import { Response, NextFunction } from 'express';
import { LeadStatus, LeadLostReason, DemoStatus } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { paginate, formatPagination, nextDemoBookingNumber } from '../utils/helpers';
import { computeSalesPulse } from '../services/salesPulse.service';
import { getEffectiveAccess } from '../utils/moduleAccess';

// BDAs (SALES access level EDIT, not ADMIN) only ever see their own assigned
// leads/demos — Sales Pulse and Lead Quality (aggregate, cross-rep views) are
// gated to ADMIN at the route level instead. SUPER_ADMIN and anyone with
// SALES=ADMIN sees everything, same as before.
async function isSalesAdmin(req: AuthRequest): Promise<boolean> {
  if (!req.user) return false;
  const access = await getEffectiveAccess(req.user.userId);
  return access.SALES === 'ADMIN';
}

/** Throws if a non-admin caller is trying to read/write a lead (or its calls/
 * demos) that isn't assigned to them — enforced server-side so a BDA can't
 * reach a teammate's lead just by knowing/guessing its id, even though the
 * UI never surfaces those ids to them in the first place. */
async function assertLeadAccess(req: AuthRequest, leadId: string): Promise<void> {
  if (await isSalesAdmin(req)) return;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { assignedToId: true } });
  if (!lead) throw new AppError('Lead not found', 404);
  if (lead.assignedToId !== req.user?.employeeId) {
    throw new AppError('You do not have access to this lead', 403);
  }
}

// Case/space-insensitive column lookup — lets the bulk-upload endpoint accept
// both the simple manual-entry template (name, phone, assignedToCode, ...)
// AND a direct export from a legacy CRM (Name, Phone, Assigned, Status,
// Reminder, Last Contact, Created, Demo, Date Of Demo, ...) unchanged, since
// XLSX rows come in keyed exactly by whatever header row the file has.
function field(row: Record<string, unknown>, ...aliases: string[]): string {
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(row)) {
    normalized[key.trim().toLowerCase().replace(/\s+/g, '')] = row[key];
  }
  for (const alias of aliases) {
    const v = normalized[alias];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

function parseFlexDate(raw: string): Date | undefined {
  if (!raw) return undefined;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? undefined : d;
}

// Legacy CRM status text -> our pipeline. Anything not in this list falls
// back to NEW, with the original text preserved in the imported lead's notes
// so nothing is silently lost on import.
const LEGACY_STATUS_MAP: Record<string, { status: LeadStatus; lostReason?: LeadLostReason }> = {
  'new lead': { status: LeadStatus.NEW },
  'dnp': { status: LeadStatus.CONTACTED },
  'followup': { status: LeadStatus.CONTACTED },
  'my base': { status: LeadStatus.CONTACTED },
  'not interested': { status: LeadStatus.LOST, lostReason: LeadLostReason.NOT_INTERESTED },
  'unresponsive': { status: LeadStatus.LOST, lostReason: LeadLostReason.UNREACHABLE },
  'disqualified': { status: LeadStatus.LOST, lostReason: LeadLostReason.OTHER },
  'language barrier': { status: LeadStatus.LOST, lostReason: LeadLostReason.OTHER },
  'online appointment fixed': { status: LeadStatus.DEMO_SCHEDULED },
  'direct appointment fixed': { status: LeadStatus.DEMO_SCHEDULED },
  'demo fixed - no show': { status: LeadStatus.DEMO_SCHEDULED },
  'demo conducted - followup': { status: LeadStatus.DEMO_DONE },
  'online appointment over': { status: LeadStatus.DEMO_DONE },
  'direct appointment over': { status: LeadStatus.DEMO_DONE },
  'positive': { status: LeadStatus.NEGOTIATION },
  'may buy later': { status: LeadStatus.NEGOTIATION },
  'demo conducted - positive': { status: LeadStatus.NEGOTIATION },
  'student': { status: LeadStatus.ENROLLED },
};

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };

export const salesController = {
  // ── Leads ────────────────────────────────────────────────────────────────
  async listLeads(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 20, status, search, assignedToId, followUp } = req.query;
      const p = Number(page), l = Number(limit);

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (assignedToId) where.assignedToId = assignedToId;
      if (search) {
        where.OR = [
          { name: { contains: String(search) } },
          { phone: { contains: String(search) } },
          { email: { contains: String(search) } },
        ];
      }
      // "Reminder" column filter — leads whose next-follow-up is overdue or due today.
      if (followUp === 'overdue' || followUp === 'today') {
        const startOfToday = new Date(); startOfToday.setHours(0, 0, 0, 0);
        const endOfToday = new Date(startOfToday); endOfToday.setDate(endOfToday.getDate() + 1);
        where.nextFollowUpAt = followUp === 'overdue' ? { lt: startOfToday } : { gte: startOfToday, lt: endOfToday };
      }

      // A BDA (SALES=EDIT) only ever sees leads assigned to them — this
      // overrides any assignedToId query param so they can't page through
      // teammates' leads by editing the request.
      if (!(await isSalesAdmin(req))) {
        where.assignedToId = req.user?.employeeId || '__none__';
      }

      const [leads, total] = await Promise.all([
        prisma.lead.findMany({
          where,
          include: {
            assignedTo: { select: employeeSelect },
            campaign: { select: { id: true, name: true } },
            demos: { orderBy: { scheduledAt: 'desc' }, take: 1 },
            _count: { select: { demos: true, callLogs: true } },
          },
          orderBy: { createdAt: 'desc' },
          ...paginate(p, l),
        }),
        prisma.lead.count({ where }),
      ]);

      res.json({ success: true, data: leads, meta: formatPagination(total, p, l) });
    } catch (err) { next(err); }
  },

  /**
   * Bulk lead import from an uploaded spreadsheet (parsed client-side, rows
   * posted as JSON here — same shape as Production's bulkUploadStudents).
   * Employees/campaigns are pre-fetched once and matched by code/name per
   * row rather than hitting the DB per lookup. Existing phone numbers are
   * pre-loaded too so duplicate rows are reported instead of silently
   * creating a second lead for the same person.
   */
  async bulkUploadLeads(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { leads } = req.body;
      if (!Array.isArray(leads) || !leads.length) {
        throw new AppError('leads array is required', 400);
      }

      const [allEmployees, allCampaigns, existingLeads] = await Promise.all([
        prisma.employee.findMany({ select: { id: true, employeeCode: true, firstName: true, lastName: true } }),
        prisma.campaign.findMany({ select: { id: true, name: true } }),
        prisma.lead.findMany({ select: { phone: true } }),
      ]);
      const employeeByCode = new Map(allEmployees.map((e) => [e.employeeCode.trim().toLowerCase(), e.id]));
      const campaignByName = new Map(allCampaigns.map((c) => [c.name.trim().toLowerCase(), c.id]));
      const existingPhones = new Set(existingLeads.map((l) => l.phone.trim()));

      // Name-based employee lookup — the legacy CRM export assigns leads by
      // full name ("Jothimalar S") rather than employee code, so match on
      // normalized full name, falling back to first name if it's unambiguous.
      const normName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');
      const employeeByFullName = new Map<string, string>();
      const employeeIdsByFirstName = new Map<string, string[]>();
      for (const e of allEmployees) {
        employeeByFullName.set(normName(`${e.firstName} ${e.lastName}`), e.id);
        const fn = normName(e.firstName);
        employeeIdsByFirstName.set(fn, [...(employeeIdsByFirstName.get(fn) || []), e.id]);
      }
      const resolveEmployeeByName = (raw: string): string | undefined => {
        const n = normName(raw);
        if (employeeByFullName.has(n)) return employeeByFullName.get(n);
        const matches = employeeIdsByFirstName.get(n);
        return matches && matches.length === 1 ? matches[0] : undefined;
      };

      const results: Array<{ row: number; status: 'created' | 'error'; message?: string; leadId?: string }> = [];

      for (let i = 0; i < leads.length; i++) {
        const row = (leads[i] || {}) as Record<string, unknown>;
        const rowNum = i + 1;
        try {
          const name = field(row, 'name');
          const phone = field(row, 'phone', 'phonenumber', 'mobile');
          if (!name || !phone) {
            results.push({ row: rowNum, status: 'error', message: 'name and phone are required' });
            continue;
          }
          if (existingPhones.has(phone)) {
            results.push({ row: rowNum, status: 'error', message: `A lead with phone "${phone}" already exists` });
            continue;
          }

          const warnings: string[] = [];

          const assignedCode = field(row, 'assignedtocode');
          const assignedName = field(row, 'assigned', 'assignedto');
          let assignedToId: string | undefined;
          if (assignedCode) {
            assignedToId = employeeByCode.get(assignedCode.toLowerCase());
            if (!assignedToId) {
              results.push({ row: rowNum, status: 'error', message: `Employee code "${assignedCode}" not found` });
              continue;
            }
          } else if (assignedName) {
            assignedToId = resolveEmployeeByName(assignedName);
            if (!assignedToId) warnings.push(`rep "${assignedName}" not matched — left unassigned`);
          }

          const campaignRaw = field(row, 'campaign');
          let campaignId: string | undefined;
          if (campaignRaw) {
            campaignId = campaignByName.get(campaignRaw.toLowerCase());
            if (!campaignId) warnings.push(`campaign "${campaignRaw}" not found — left blank`);
          }

          // Legacy status text -> our pipeline (see LEGACY_STATUS_MAP above).
          const legacyStatusRaw = field(row, 'status');
          const legacyStatusKey = legacyStatusRaw.toLowerCase();
          const mapped = LEGACY_STATUS_MAP[legacyStatusKey];
          const status: LeadStatus = mapped?.status || LeadStatus.NEW;
          const lostReason = mapped?.lostReason;
          if (legacyStatusRaw && !mapped) warnings.push(`status "${legacyStatusRaw}" not recognized — imported as New`);

          const createdAt = parseFlexDate(field(row, 'created'));
          const lastContactAt = parseFlexDate(field(row, 'lastcontact'));
          const nextFollowUpAt = parseFlexDate(field(row, 'reminder'));

          const notesParts: string[] = [];
          const notesField = field(row, 'notes');
          if (notesField) notesParts.push(notesField);
          if (legacyStatusRaw) notesParts.push(`Imported from legacy CRM — original status: "${legacyStatusRaw}"`);

          const lead = await prisma.lead.create({
            data: {
              name,
              phone,
              email: field(row, 'email') || undefined,
              source: field(row, 'source') || undefined,
              courseInterest: field(row, 'courseinterest') || undefined,
              notes: notesParts.length ? notesParts.join(' — ') : undefined,
              assignedToId,
              campaignId,
              status,
              lostReason,
              lastContactAt,
              nextFollowUpAt,
              ...(createdAt ? { createdAt } : {}),
            },
          });

          // Legacy exports carry a Demo column (Online/Offline) + Date Of Demo —
          // recreate that as a real Demo row so the Demos tab / pulse reports
          // aren't blind to demos that already happened before the migration.
          const demoModeRaw = field(row, 'demo').toLowerCase();
          const demoDate = parseFlexDate(field(row, 'dateofdemo'));
          if (demoModeRaw && demoDate) {
            let demoStatus: DemoStatus = DemoStatus.SCHEDULED;
            if (legacyStatusKey.includes('no show')) demoStatus = DemoStatus.NO_SHOW;
            else if (legacyStatusKey.startsWith('demo conducted') || legacyStatusKey.includes('appointment over')) demoStatus = DemoStatus.COMPLETED;
            else if (demoDate.getTime() < Date.now()) demoStatus = DemoStatus.COMPLETED;

            await prisma.demo.create({
              data: {
                leadId: lead.id,
                scheduledAt: demoDate,
                mode: demoModeRaw === 'online' ? 'ONLINE' : 'OFFLINE',
                status: demoStatus,
              },
            });
          }

          existingPhones.add(phone);
          results.push({
            row: rowNum,
            status: 'created',
            leadId: lead.id,
            message: warnings.length ? warnings.join('; ') : undefined,
          });
        } catch (rowErr) {
          results.push({ row: rowNum, status: 'error', message: rowErr instanceof Error ? rowErr.message : 'Unknown error' });
        }
      }

      const created = results.filter((r) => r.status === 'created').length;
      res.status(201).json({ success: true, data: { results, created, failed: results.length - created } });
    } catch (err) { next(err); }
  },

  /** Single-lead fetch — used by the frontend to hydrate the detail modal
   * when it's opened from somewhere other than the Leads table (e.g. a Demo
   * Booked row), where the full lead object isn't already in memory. */
  async getLead(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const lead = await prisma.lead.findUnique({
        where: { id: req.params.id },
        include: {
          assignedTo: { select: employeeSelect },
          campaign: { select: { id: true, name: true } },
          demos: { orderBy: { scheduledAt: 'desc' }, take: 1 },
          _count: { select: { demos: true, callLogs: true } },
        },
      });
      if (!lead) throw new AppError('Lead not found', 404);
      // A BDA (SALES=EDIT) may only open leads assigned to them.
      if (!(await isSalesAdmin(req)) && lead.assignedToId !== req.user?.employeeId) {
        throw new AppError('You do not have access to this lead', 403);
      }
      res.json({ success: true, data: lead });
    } catch (err) { next(err); }
  },

  async createLead(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, phone, email, source, courseInterest, assignedToId, campaignId, notes } = req.body;
      if (!name || !phone) throw new AppError('Name and phone are required', 400);

      const lead = await prisma.lead.create({
        data: { name, phone, email, source, courseInterest, assignedToId, campaignId, notes },
        include: { assignedTo: { select: employeeSelect } },
      });
      res.status(201).json({ success: true, data: lead });
    } catch (err) { next(err); }
  },

  async updateLead(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await assertLeadAccess(req, req.params.id);
      const { name, phone, email, source, courseInterest, status, assignedToId, campaignId, notes, lostReason } = req.body;
      if (status === 'LOST' && !lostReason) {
        throw new AppError('A reason is required when marking a lead as Lost', 400);
      }
      const lead = await prisma.lead.update({
        where: { id: req.params.id },
        data: {
          name, phone, email, source, courseInterest, status, assignedToId, campaignId, notes,
          // Only a LOST lead carries a reason — clear it the moment status moves elsewhere,
          // so re-opened leads don't keep showing a stale "why it was lost" reason.
          lostReason: status === 'LOST' ? lostReason : status !== undefined ? null : undefined,
        },
        include: { assignedTo: { select: employeeSelect } },
      });
      res.json({ success: true, data: lead });
    } catch (err) { next(err); }
  },

  async deleteLead(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.lead.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Lead deleted' });
    } catch (err) { next(err); }
  },

  // ── Call log ─────────────────────────────────────────────────────────────
  // This is the permanent per-lead history: every call, its notes, and the
  // follow-up date picked at the time. It's what a lead keeps when
  // reassigned — the new BDA reads this same list and sees everything the
  // previous one logged.
  async listCallLogs(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await assertLeadAccess(req, req.params.id);
      const logs = await prisma.leadCallLog.findMany({
        where: { leadId: req.params.id },
        include: { calledBy: { select: employeeSelect } },
        orderBy: { calledAt: 'desc' },
      });
      res.json({ success: true, data: logs });
    } catch (err) { next(err); }
  },

  async addCallLog(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await assertLeadAccess(req, req.params.id);
      const { notes, nextFollowUpAt, status, lostReason } = req.body;
      if (!notes) throw new AppError('Call notes are required', 400);
      if (status === 'LOST' && !lostReason) {
        throw new AppError('A reason is required when marking a lead as Lost', 400);
      }

      const leadId = req.params.id;
      const calledAt = new Date();
      // Present-and-empty means "clear the reminder"; absent means "leave it as is".
      const followUpValue = nextFollowUpAt !== undefined ? (nextFollowUpAt ? new Date(nextFollowUpAt) : null) : undefined;

      const [log] = await prisma.$transaction([
        prisma.leadCallLog.create({
          data: { leadId, calledById: req.user?.employeeId, notes, nextFollowUpAt: followUpValue, calledAt },
          include: { calledBy: { select: employeeSelect } },
        }),
        prisma.lead.update({
          where: { id: leadId },
          data: {
            lastContactAt: calledAt,
            nextFollowUpAt: followUpValue,
            status: status || undefined,
            lostReason: status === 'LOST' ? lostReason : status !== undefined ? null : undefined,
          },
        }),
      ]);

      res.status(201).json({ success: true, data: log });
    } catch (err) { next(err); }
  },

  // ── Demos ────────────────────────────────────────────────────────────────
  async listDemos(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { leadId, status } = req.query;
      const where: Record<string, unknown> = {};
      if (leadId) where.leadId = leadId;
      if (status) where.status = status;

      // A BDA only ever sees demos on their own assigned leads — this powers
      // their Demo Booked / Demo Rescheduled / Demo Conducted tabs (each is
      // just this same endpoint with a different ?status=).
      if (!(await isSalesAdmin(req))) {
        where.lead = { assignedToId: req.user?.employeeId || '__none__' };
      }

      const demos = await prisma.demo.findMany({
        where,
        include: {
          lead: { select: { id: true, name: true, phone: true } },
          conductedBy: { select: employeeSelect },
          coConductedBy: { select: employeeSelect },
        },
        orderBy: { scheduledAt: 'desc' },
      });
      res.json({ success: true, data: demos });
    } catch (err) { next(err); }
  },

  async createDemo(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const {
        leadId, scheduledAt, mode, conductedById, status, feedback,
        city, educationQualification, collegeName, passedOutYear, currentStatus, courseEnquired, bookingComments,
      } = req.body;
      if (!leadId || !scheduledAt) throw new AppError('leadId and scheduledAt are required', 400);
      await assertLeadAccess(req, leadId);

      const bookingNumber = await nextDemoBookingNumber(prisma);

      const [demo] = await prisma.$transaction([
        prisma.demo.create({
          data: {
            leadId, scheduledAt: new Date(scheduledAt), mode, conductedById, status, feedback,
            bookingNumber,
            city: city || undefined,
            educationQualification: educationQualification || undefined,
            collegeName: collegeName || undefined,
            passedOutYear: passedOutYear ? Number(passedOutYear) : undefined,
            currentStatus: currentStatus || undefined,
            courseEnquired: courseEnquired || undefined,
            bookingComments: bookingComments || undefined,
          },
          include: { lead: true, conductedBy: { select: employeeSelect } },
        }),
        prisma.lead.update({ where: { id: leadId }, data: { status: 'DEMO_SCHEDULED' } }),
      ]);
      res.status(201).json({ success: true, data: demo });
    } catch (err) { next(err); }
  },

  /**
   * Also doubles as the "Mark Conducted" action (status=COMPLETED): that path
   * requires an outcome and a proof photo/screenshot (the file upload —
   * req.file — comes from the uploadDemoProof middleware on this route).
   */
  async updateDemo(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const existingDemo = await prisma.demo.findUnique({
        where: { id: req.params.id },
        select: { leadId: true, proofUrl: true },
      });
      if (!existingDemo) throw new AppError('Demo not found', 404);
      await assertLeadAccess(req, existingDemo.leadId);

      const { scheduledAt, mode, conductedById, status, feedback, outcome, coConductedById } = req.body;
      const proofFile = req.file as Express.Multer.File | undefined;

      if (status === 'COMPLETED') {
        if (!outcome) {
          throw new AppError('Pick an outcome (Not Interested / Interested / 50-50 / Need Follow-up) when marking a demo Conducted', 400);
        }
        if (!proofFile && !existingDemo.proofUrl) {
          throw new AppError('A photo/screenshot proof is required to mark a demo Conducted', 400);
        }
      }

      const demo = await prisma.demo.update({
        where: { id: req.params.id },
        data: {
          scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
          mode, conductedById, status, feedback,
          outcome: outcome || undefined,
          coConductedById: coConductedById || undefined,
          proofUrl: proofFile ? `/uploads/demo-proofs/${proofFile.filename}` : undefined,
        },
        include: {
          lead: true,
          conductedBy: { select: employeeSelect },
          coConductedBy: { select: employeeSelect },
        },
      });

      if (status === 'COMPLETED') {
        await prisma.lead.update({ where: { id: demo.leadId }, data: { status: 'DEMO_DONE' } });
      }

      res.json({ success: true, data: demo });
    } catch (err) { next(err); }
  },

  /**
   * Reschedules a demo without losing the trail: the original row is frozen
   * as RESCHEDULED (with the reason recorded) so "was today's demo conducted
   * or rescheduled" reporting has a real record of what was originally
   * planned, and a fresh SCHEDULED row is created pointing back at it via
   * rescheduledFromId. The student intake details carry forward — no need to
   * re-enter city/qualification/etc. just because the slot moved.
   */
  async rescheduleDemo(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduledAt, mode, reason } = req.body;
      if (!scheduledAt) throw new AppError('New scheduledAt is required', 400);
      if (!reason) throw new AppError('A reason for rescheduling is required', 400);

      const original = await prisma.demo.findUnique({ where: { id: req.params.id } });
      if (!original) throw new AppError('Demo not found', 404);
      await assertLeadAccess(req, original.leadId);

      const bookingNumber = await nextDemoBookingNumber(prisma);

      const [, , newDemo] = await prisma.$transaction([
        prisma.demo.update({ where: { id: original.id }, data: { status: 'RESCHEDULED', rescheduleReason: reason } }),
        prisma.lead.update({ where: { id: original.leadId }, data: { status: 'DEMO_SCHEDULED' } }),
        prisma.demo.create({
          data: {
            leadId: original.leadId,
            scheduledAt: new Date(scheduledAt),
            mode: mode || original.mode,
            status: 'SCHEDULED',
            rescheduledFromId: original.id,
            bookingNumber,
            city: original.city,
            educationQualification: original.educationQualification,
            collegeName: original.collegeName,
            passedOutYear: original.passedOutYear,
            currentStatus: original.currentStatus,
            courseEnquired: original.courseEnquired,
            bookingComments: original.bookingComments,
          },
          include: { lead: true, conductedBy: { select: employeeSelect } },
        }),
      ]);

      res.status(201).json({ success: true, data: newDemo });
    } catch (err) { next(err); }
  },

  // ── Summary stats ────────────────────────────────────────────────────────
  async stats(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isSalesAdmin(req);
      const ownLeadWhere: Record<string, unknown> = admin ? {} : { assignedToId: req.user?.employeeId || '__none__' };
      const ownDemoWhere: Record<string, unknown> = admin ? {} : { lead: { assignedToId: req.user?.employeeId || '__none__' } };

      const [byStatus, totalLeads, upcomingDemos, enrolledThisMonth] = await Promise.all([
        prisma.lead.groupBy({ by: ['status'], where: ownLeadWhere, _count: { _all: true } }),
        prisma.lead.count({ where: ownLeadWhere }),
        prisma.demo.count({
          where: { ...ownDemoWhere, status: 'SCHEDULED', scheduledAt: { gte: new Date() } },
        }),
        prisma.lead.count({
          where: {
            ...ownLeadWhere,
            status: 'ENROLLED',
            updatedAt: { gte: new Date(new Date().getFullYear(), new Date().getMonth(), 1) },
          },
        }),
      ]);

      const statusCounts: Record<string, number> = {};
      for (const row of byStatus) statusCounts[row.status] = row._count._all;

      res.json({
        success: true,
        data: { totalLeads, statusCounts, upcomingDemos, enrolledThisMonth },
      });
    } catch (err) { next(err); }
  },

  /**
   * Sales team roster for the Assign / Conducted by / Co-conducted by
   * dropdowns — every active employee whose *effective* SALES access
   * (department default, overridden per-user via Master Control) is EDIT or
   * ADMIN. Plain VIEW-only accounts (e.g. an auditor) don't show up here,
   * since they're not people leads/demos should actually be assigned to.
   */
  async listTeam(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employees = await prisma.employee.findMany({
        where: { status: 'ACTIVE', isSystemAccount: false },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeCode: true,
          department: { select: { moduleAccessDefaults: { where: { module: 'SALES' }, select: { accessLevel: true } } } },
          user: { select: { role: true, moduleAccessGrants: { where: { module: 'SALES' }, select: { accessLevel: true } } } },
        },
        orderBy: [{ firstName: 'asc' }, { lastName: 'asc' }],
      });

      const LEVEL_RANK: Record<string, number> = { NONE: 0, VIEW: 1, EDIT: 2, ADMIN: 3 };
      const team = employees
        .filter((e) => {
          if (e.user?.role === 'SUPER_ADMIN') return true;
          const override = e.user?.moduleAccessGrants?.[0]?.accessLevel;
          const level = override ?? e.department?.moduleAccessDefaults?.[0]?.accessLevel;
          return !!level && LEVEL_RANK[level] >= LEVEL_RANK.EDIT;
        })
        .map((e) => ({ id: e.id, firstName: e.firstName, lastName: e.lastName, employeeCode: e.employeeCode }));

      res.json({ success: true, data: team });
    } catch (err) { next(err); }
  },

  /** Live "as of right now" snapshot for the Sales Pulse panel — same numbers the hourly/EOD emails use. */
  async pulse(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const data = await computeSalesPulse();
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /**
   * Per-campaign lead quality: how many leads a campaign actually produced vs.
   * how many of those turned out to be workable. "Received"/"Given to Sales" come
   * from the marketing-entered CampaignDailyReport numbers (Digital Marketing);
   * "Assigned"/"Not Interested"/"Doesn't Work"/"Enrolled" come from the Lead
   * records themselves (status + lostReason), which is where the sales team's
   * actual outcome per lead lives — hence living under Sales.
   */
  async leadQuality(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status } = req.query;
      const campaignWhere: Record<string, unknown> = {};
      if (status) campaignWhere.status = status;

      const [campaigns, dailyTotals, statusCounts, reasonCounts, assignedCounts] = await Promise.all([
        prisma.campaign.findMany({
          where: campaignWhere,
          select: { id: true, name: true, channel: true, status: true },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.campaignDailyReport.groupBy({
          by: ['campaignId'],
          _sum: { leadsReceived: true, leadsGivenToSales: true },
        }),
        prisma.lead.groupBy({
          by: ['campaignId', 'status'],
          where: { campaignId: { not: null } },
          _count: { _all: true },
        }),
        prisma.lead.groupBy({
          by: ['campaignId', 'lostReason'],
          where: { campaignId: { not: null }, status: 'LOST' },
          _count: { _all: true },
        }),
        prisma.lead.groupBy({
          by: ['campaignId'],
          where: { campaignId: { not: null }, assignedToId: { not: null } },
          _count: { _all: true },
        }),
      ]);

      const dailyMap = new Map(dailyTotals.map((d) => [d.campaignId, d._sum]));
      const assignedMap = new Map(assignedCounts.map((r) => [r.campaignId as string, r._count._all]));

      const statusMap = new Map<string, Record<string, number>>();
      for (const row of statusCounts) {
        if (!row.campaignId) continue;
        const m = statusMap.get(row.campaignId) || {};
        m[row.status] = row._count._all;
        statusMap.set(row.campaignId, m);
      }

      const reasonMap = new Map<string, Record<string, number>>();
      for (const row of reasonCounts) {
        if (!row.campaignId) continue;
        const m = reasonMap.get(row.campaignId) || {};
        const key = row.lostReason || 'UNSPECIFIED';
        m[key] = row._count._all;
        reasonMap.set(row.campaignId, m);
      }

      const rows = campaigns.map((c) => {
        const statuses = statusMap.get(c.id) || {};
        const reasons = reasonMap.get(c.id) || {};
        const daily = dailyMap.get(c.id) || { leadsReceived: 0, leadsGivenToSales: 0 };
        const totalLeads = Object.values(statuses).reduce((s, n) => s + n, 0);
        const totalLost = statuses.LOST || 0;
        const notInterested = reasons.NOT_INTERESTED || 0;
        const doesntWork = totalLost - notInterested; // INVALID_NUMBER + UNREACHABLE + DUPLICATE + OTHER + UNSPECIFIED
        const enrolled = statuses.ENROLLED || 0;
        const leadsAssigned = assignedMap.get(c.id) || 0;
        const qualityPct = leadsAssigned > 0 ? ((leadsAssigned - totalLost) / leadsAssigned) * 100 : null;

        return {
          campaignId: c.id,
          campaignName: c.name,
          channel: c.channel,
          campaignStatus: c.status,
          leadsReceived: daily.leadsReceived || 0,
          leadsGivenToSales: daily.leadsGivenToSales || 0,
          leadsAssigned,
          totalLeads,
          notInterested,
          doesntWork,
          totalLost,
          enrolled,
          qualityPct,
        };
      });

      const overall = rows.reduce(
        (acc, r) => ({
          leadsReceived: acc.leadsReceived + r.leadsReceived,
          leadsGivenToSales: acc.leadsGivenToSales + r.leadsGivenToSales,
          leadsAssigned: acc.leadsAssigned + r.leadsAssigned,
          totalLeads: acc.totalLeads + r.totalLeads,
          notInterested: acc.notInterested + r.notInterested,
          doesntWork: acc.doesntWork + r.doesntWork,
          totalLost: acc.totalLost + r.totalLost,
          enrolled: acc.enrolled + r.enrolled,
        }),
        { leadsReceived: 0, leadsGivenToSales: 0, leadsAssigned: 0, totalLeads: 0, notInterested: 0, doesntWork: 0, totalLost: 0, enrolled: 0 }
      );
      const overallQualityPct = overall.leadsAssigned > 0 ? ((overall.leadsAssigned - overall.totalLost) / overall.leadsAssigned) * 100 : null;

      res.json({ success: true, data: { campaigns: rows, overall: { ...overall, qualityPct: overallQualityPct } } });
    } catch (err) { next(err); }
  },

  // ── Report recipients (who gets the Sales Pulse / EOD emails) ──────────────
  async listReportRecipients(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const recipients = await prisma.reportRecipient.findMany({ where: { type: 'SALES_HOURLY' }, orderBy: { createdAt: 'asc' } });
      res.json({ success: true, data: recipients });
    } catch (err) { next(err); }
  },

  async addReportRecipient(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { email, name } = req.body;
      if (!email) throw new AppError('email is required', 400);
      const recipient = await prisma.reportRecipient.upsert({
        where: { type_email: { type: 'SALES_HOURLY', email: String(email).toLowerCase() } },
        update: { name },
        create: { type: 'SALES_HOURLY', email: String(email).toLowerCase(), name },
      });
      res.status(201).json({ success: true, data: recipient });
    } catch (err) { next(err); }
  },

  async removeReportRecipient(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.reportRecipient.delete({ where: { id: req.params.id } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};
