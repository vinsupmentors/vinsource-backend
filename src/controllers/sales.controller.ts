import { Response, NextFunction } from 'express';
import { LeadStatus, LeadLostReason, LeadActivityStatus, DemoStatus } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { paginate, formatPagination, nextDemoBookingNumber } from '../utils/helpers';
import { computeSalesPulse } from '../services/salesPulse.service';
import { computeSalesLeaderboard } from '../services/salesLeaderboard.service';
import { getEffectiveAccess } from '../utils/moduleAccess';
import { announceOnlineDemo, newDemoCode } from './salesDemoRoom.controller';
import { buildWhereFromFilter } from '../utils/filterTree';
import { historyCutoff } from '../utils/leadHistoryVisibility';
import { leadPhoneKey, assertNoDuplicateLead } from '../utils/leadPhone';
import { leadConfig, resolveStage, resolveLostReason, ensureSource, scoutKeyByName } from '../utils/leadConfig';
import { LEAD_FILTER_FIELDS, CALL_FILTER_FIELDS } from '../utils/salesFilterFields';
import { normalizePhone } from '../utils/phone';
import { computeRankCard } from '../utils/rankCard';
import { getOnboardingStatus, reconcileFlagsBatch } from '../utils/onboardingStatus';
import { ensureReminderForStage, moveDemoReminder, syncFollowUpTask, moveOpenTasks, upsertDemoTask, closeDemoTask, applyDemoOutcome, completeScheduledDemos, OUTCOME_PLAN } from '../utils/salesFlow';

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

type HistoryDb = Pick<typeof prisma, 'leadHistory'>;
/** Append one entry to a lead's permanent history. Never throws into the caller's flow. */
async function logLeadHistory(
  leadId: string, actorId: string | undefined | null, type: string, summary: string,
  fromValue?: string | null, toValue?: string | null, db: HistoryDb = prisma,
) {
  try {
    await db.leadHistory.create({ data: { leadId, actorId: actorId || null, type, summary, fromValue: fromValue ?? null, toValue: toValue ?? null } });
  } catch (e) { console.error('Lead history write failed', e); }
}

/**
 * List-view student summary for "My Students" — enough for a roster table,
 * not the full dossier. documentsCompletedAt/onboardingApprovedAt are
 * reconciled against the live signed-status (see onboardingStatus.ts)
 * before returning, rather than trusting the raw cached columns — those
 * flags are set once and never revisited, so without this a student whose
 * track changed or who's missing a newly-added document can sit forever
 * showing as "awaiting approval" here even though the (live-recomputing)
 * admin Approval screen has already correctly excluded them.
 */
async function listStudentsSummary(studentWhere: Record<string, unknown>) {
  const students = await prisma.student.findMany({
    where: studentWhere,
    select: {
      id: true, firstName: true, lastName: true, studentCode: true, photo: true,
      track: true, status: true, email: true, phone: true, joiningDate: true, movedToPlacementAt: true,
      profileCompletedAt: true, documentsCompletedAt: true, onboardingApprovedAt: true,
      enrollments: {
        select: {
          schedule: { select: { id: true, timing: true, course: { select: { id: true, name: true } }, batch: { select: { id: true, code: true } } } },
        },
      },
      portfolio: { select: { status: true, targetRole: true } },
      certificateRequests: { select: { type: true, feeApprovedAt: true, ldmApprovedAt: true, certificateNo: true } },
      // Project presentation proof (trainer marks it done + uploads 2 photos) — shown to the advisor.
      trainerFeedbacks: { select: { courseId: true, presentationDone: true, presentationAt: true, presentationPhotos: true, certificateEligible: true } },
      skillAdvisor: { select: employeeSelect },
    },
    orderBy: { joiningDate: 'desc' },
  });
  return reconcileFlagsBatch(students);
}

/** Whitelisted column sorts for the Leads table; always tie-break on newest so paging is stable. */
function leadOrderBy(sortBy: unknown, sortDir: unknown) {
  const dir = String(sortDir) === 'asc' ? 'asc' : 'desc';
  const col = String(sortBy || '');
  const plain = ['name', 'phone', 'email', 'status', 'source', 'courseInterest', 'scoutKey', 'createdAt', 'nextFollowUpAt', 'lastContactAt'];
  if (plain.includes(col)) return [{ [col]: dir }, { createdAt: 'desc' as const }] as never;
  if (col === 'assignedTo') return [{ assignedTo: { firstName: dir } }, { createdAt: 'desc' as const }] as never;
  return { createdAt: 'desc' as const } as never;
}

export const salesController = {
  // ── Leads ────────────────────────────────────────────────────────────────
  async listLeads(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 20, status, search, assignedToId, followUp, activityStatus, source, createdFrom, createdTo, followUpFrom, followUpTo, course, scoutKey, sortBy, sortDir, nameLike, phoneLike, emailLike } = req.query;
      // limit=all → one big page (capped so a huge table cannot take the server down).
      const allRows = String(limit) === 'all';
      const p = allRows ? 1 : Number(page), l = allRows ? 5000 : Math.min(500, Number(limit) || 20);

      const where: Record<string, unknown> = { deletedAt: null };
      // Every list filter accepts a comma list, so several values can be ticked at once.
      const list = (v: unknown) => String(v).split(',').map((s) => s.trim()).filter(Boolean);
      const multi = (v: unknown) => { const a = list(v); return a.length === 1 ? a[0] : { in: a }; };
      const and: Record<string, unknown>[] = [];
      // status = lead stage; activityStatus = the Update Status picked while logging an activity.
      // Stages and statuses are Admin-managed: built-in ones filter on the base column, custom ones on their own key.
      const cfgF = await leadConfig();
      if (status) {
        const keys = list(status);
        const sys = keys.filter((k) => cfgF.find('STAGE', k)?.system);
        const cust = keys.filter((k) => { const d = cfgF.find('STAGE', k); return d && !d.system; });
        const ors: Record<string, unknown>[] = [];
        if (sys.length) ors.push({ status: { in: sys }, stageKey: null });
        if (cust.length) ors.push({ stageKey: { in: cust } });
        if (ors.length) and.push({ OR: ors });
      }
      if (activityStatus) {
        const keys = list(activityStatus);
        const sys = keys.filter((k) => cfgF.find('STATUS', k)?.system);
        const cust = keys.filter((k) => { const d = cfgF.find('STATUS', k); return d && !d.system; });
        const ors: Record<string, unknown>[] = [];
        if (keys.includes('NONE')) ors.push({ activityStatus: null });
        if (sys.length) ors.push({ activityStatus: { in: sys }, statusKey: null });
        if (cust.length) ors.push({ statusKey: { in: cust } });
        if (ors.length) and.push({ OR: ors });
      }
      if (scoutKey) {
        const keys = list(scoutKey);
        const named = keys.filter((k) => k !== 'NONE');
        and.push({ OR: [...(keys.includes('NONE') ? [{ scoutKey: null }] : []), ...(named.length ? [{ scoutKey: { in: named } }] : [])] });
      }
      if (source) {
        const a = list(source);
        if (a.includes('Unknown')) and.push({ OR: [{ source: null }, { source: '' }, ...(a.filter((x) => x !== 'Unknown').length ? [{ source: { in: a.filter((x) => x !== 'Unknown') } }] : [])] });
        else where.source = multi(source);
      }
      if (course) where.courseInterest = multi(course);
      // Excel-style column text filters
      if (nameLike) and.push({ name: { contains: String(nameLike) } });
      if (phoneLike) and.push({ phone: { contains: String(phoneLike) } });
      if (emailLike) and.push({ email: { contains: String(emailLike) } });
      if (assignedToId) where.assignedToId = list(assignedToId).includes('NONE') ? null : multi(assignedToId);
      const range = (from: unknown, to: unknown) => {
        const r: Record<string, Date> = {};
        if (from) { const d = new Date(String(from)); d.setHours(0, 0, 0, 0); r.gte = d; }
        if (to) { const d = new Date(String(to)); d.setHours(23, 59, 59, 999); r.lte = d; }
        return r;
      };
      if (createdFrom || createdTo) where.createdAt = range(createdFrom, createdTo);
      if ((followUpFrom || followUpTo) && !followUp) where.nextFollowUpAt = range(followUpFrom, followUpTo);
      if (search) {
        and.push({
          OR: [
            { name: { contains: String(search) } },
            { phone: { contains: String(search) } },
            { email: { contains: String(search) } },
          ],
        });
      }
      // Advanced filter builder (groups of AND/OR conditions) — applied on top of the quick filters.
      const advanced = buildWhereFromFilter(req.query.filter, LEAD_FILTER_FIELDS);
      if (advanced) and.push(advanced);
      if (and.length) where.AND = and;
      // "Reminder" column filter — leads whose next-follow-up is overdue or due today.
      if (followUp === 'none') {
        // Open leads with no reminder at all.
        where.nextFollowUpAt = null;
        where.status = { notIn: ['LOST', 'ENROLLED'] };
      } else if (followUp === 'overdue' || followUp === 'today') {
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
          orderBy: leadOrderBy(sortBy, sortDir),
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
      // File-wide defaults (a row's own value always wins) + dry-run so the screen can show exactly what will happen first.
      const dryRun = req.body.validateOnly === true;
      const admin = await isSalesAdmin(req);
      const defaults = (req.body.defaults || {}) as Record<string, string | undefined>;
      const defSource = String(defaults.source || '').trim();
      const defCourse = String(defaults.courseInterest || '').trim();
      const defAssignee = String(defaults.assignedToId || '').trim();
      const defBatch = String(defaults.batchLabel || '').trim().slice(0, 120);
      const defScout = admin ? String(defaults.scoutKey || '').trim() : '';
      if (defScout && !(await leadConfig()).find('SCOUT', defScout)) throw new AppError('Unknown Lead Scout', 400);
      if (defSource) await ensureSource(defSource);

      const [allEmployees, allCampaigns, existingLeads] = await Promise.all([
        prisma.employee.findMany({ select: { id: true, employeeCode: true, firstName: true, lastName: true } }),
        prisma.campaign.findMany({ select: { id: true, name: true } }),
        prisma.lead.findMany({ where: { deletedAt: null }, select: { phoneKey: true, phone: true } }),
      ]);
      const employeeByCode = new Map(allEmployees.map((e) => [e.employeeCode.trim().toLowerCase(), e.id]));
      const campaignByName = new Map(allCampaigns.map((c) => [c.name.trim().toLowerCase(), c.id]));
      const existingPhones = new Set(existingLeads.map((l) => l.phoneKey || leadPhoneKey(l.phone) || ''));

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
          const key = leadPhoneKey(phone);
          if (!key) {
            results.push({ row: rowNum, status: 'error', message: `"${phone}" is not a valid phone number` });
            continue;
          }
          if (existingPhones.has(key)) {
            results.push({ row: rowNum, status: 'error', message: `Duplicate — a lead with phone "${phone}" already exists (or appears earlier in this file)` });
            continue;
          }

          const warnings: string[] = [];
          // Lead Scout is admin-only: a salesperson's file cannot set it.
          const scoutRaw = admin ? field(row, 'leadscout', 'scout', 'leadgivenby') : '';
          const scoutKeyForRow = (scoutRaw ? await scoutKeyByName(scoutRaw) : null) || defScout || null;
          if (scoutRaw && !scoutKeyForRow) warnings.push(`Lead Scout "${scoutRaw}" not in Config — left blank`);
          const rowSource = field(row, 'source') || defSource;
          if (!dryRun) await ensureSource(rowSource);

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
            if (!assignedToId) warnings.push(`rep "${assignedName}" not matched — left unassigned (goes to My Base)`);
          }
          // A salesperson's own upload belongs to them; an admin's file falls back to the chosen default (or My Base).
          if (!assignedToId) assignedToId = admin ? (defAssignee || undefined) : req.user?.employeeId || undefined;
          if (!admin && assignedToId !== req.user?.employeeId) assignedToId = req.user?.employeeId || undefined;

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

          if (dryRun) {
            existingPhones.add(key);
            results.push({ row: rowNum, status: 'created', message: warnings.length ? warnings.join('; ') : undefined });
            continue;
          }
          const lead = await prisma.lead.create({
            data: {
              name,
              phone,
              phoneKey: key,
              scoutKey: scoutKeyForRow || undefined,
              email: field(row, 'email') || undefined,
              source: rowSource || undefined,
              courseInterest: field(row, 'courseinterest') || defCourse || undefined,
              notes: notesParts.length ? notesParts.join(' — ') : undefined,
              assignedToId,
              assignedAt: assignedToId ? new Date() : undefined,
              batchLabel: defBatch || undefined,
              createdById: req.user?.employeeId,
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

            const bookingNumber = await nextDemoBookingNumber(prisma);
            await prisma.demo.create({
              data: {
                bookingNumber,
                leadId: lead.id,
                scheduledAt: demoDate,
                mode: demoModeRaw === 'online' ? 'ONLINE' : 'OFFLINE',
                status: demoStatus,
              },
            });
          }

          await logLeadHistory(lead.id, req.user?.employeeId, 'CREATED', `Lead imported${defBatch ? ` (batch "${defBatch}")` : ''}${rowSource ? `, source: ${rowSource}` : ''}${assignedToId ? '' : ', placed in My Base'}`, null, rowSource || null);
          existingPhones.add(key);
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
      res.status(dryRun ? 200 : 201).json({ success: true, data: { results, created, failed: results.length - created, dryRun } });
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
      if (!lead || lead.deletedAt) throw new AppError('Lead not found', 404);
      // A BDA (SALES=EDIT) may only open leads assigned to them.
      if (!(await isSalesAdmin(req)) && lead.assignedToId !== req.user?.employeeId) {
        throw new AppError('You do not have access to this lead', 403);
      }
      res.json({ success: true, data: lead });
    } catch (err) { next(err); }
  },

  async createLead(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, phone, email, source, courseInterest, assignedToId, campaignId, notes, city } = req.body;
      // Lead Scout is an accountability field — only Sales Admin may set it.
      const scoutKey = (await isSalesAdmin(req)) ? req.body.scoutKey : undefined;
      if (!name || !phone) throw new AppError('Name and phone are required', 400);
      await assertNoDuplicateLead(phone);
      if (scoutKey && !(await leadConfig()).find('SCOUT', String(scoutKey))) throw new AppError('Unknown Lead Scout', 400);
      await ensureSource(source);

      const lead = await prisma.lead.create({
        data: { name, phone, phoneKey: leadPhoneKey(phone), email, source, courseInterest, city: city || null, assignedToId, campaignId, notes, scoutKey: scoutKey || null, createdById: req.user?.employeeId },
        include: { assignedTo: { select: employeeSelect } },
      });
      const assignee = lead.assignedTo ? `${lead.assignedTo.firstName} ${lead.assignedTo.lastName}` : 'nobody';
      await logLeadHistory(lead.id, req.user?.employeeId, 'CREATED',
        `Lead created${source ? ` (source: ${source})` : ''}, assigned to ${assignee}`, null, source ?? null);
      res.status(201).json({ success: true, data: lead });
    } catch (err) { next(err); }
  },

  async updateLead(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await assertLeadAccess(req, req.params.id);
      const { name, phone, email, source, courseInterest, status, stageKey, assignedToId, campaignId, notes, lostReason,
        city, educationQualification, collegeName, passedOutYear, currentStatus } = req.body;
      // Lead Scout is an accountability field — only Sales Admin may change it (ignored for everyone else).
      const scoutKey = (await isSalesAdmin(req)) ? req.body.scoutKey : undefined;
      // Stage can be a built-in stage or an Admin-created one (Config tab).
      const wantedStage = stageKey ?? status;
      const newStage = wantedStage !== undefined ? await resolveStage(String(wantedStage)) : null;
      // Picking a Lost-type stage (Not Interested / Unresponsive) needs no extra prompt: the reason follows the stage unless one is given.
      const newReason = newStage?.status === 'LOST'
        ? await resolveLostReason(String(lostReason || (newStage.stageKey === 'CUSTOM_NOT_INTERESTED' ? 'NOT_INTERESTED' : newStage.stageKey === 'CUSTOM_UNRESPONSIVE' ? 'UNREACHABLE' : 'OTHER')))
        : null;
      if (scoutKey && !(await leadConfig()).find('SCOUT', String(scoutKey))) throw new AppError('Unknown Lead Scout', 400);
      if (source) await ensureSource(source);
      const before = await prisma.lead.findUnique({
        where: { id: req.params.id },
        include: { assignedTo: { select: employeeSelect } },
      });
      if (!before || before.deletedAt) throw new AppError('Lead not found', 404);
      if (phone && leadPhoneKey(phone) !== before.phoneKey) await assertNoDuplicateLead(phone, before.id);
      const lead = await prisma.lead.update({
        where: { id: req.params.id },
        data: {
          name, phone, phoneKey: phone ? leadPhoneKey(phone) : undefined, email, source, courseInterest, assignedToId, campaignId, notes,
          status: newStage ? (newStage.status as LeadStatus) : undefined,
          stageKey: newStage ? newStage.stageKey : undefined,
          ...(newStage && newStage.stageKey !== 'CUSTOM_UNRESPONSIVE' ? { dnpCount: 0 } : {}),
          scoutKey: scoutKey !== undefined ? (scoutKey || null) : undefined,
          // Profile-tab edits: blank clears the value.
          city: city !== undefined ? (city || null) : undefined,
          educationQualification: educationQualification !== undefined ? (educationQualification || null) : undefined,
          collegeName: collegeName !== undefined ? (collegeName || null) : undefined,
          passedOutYear: passedOutYear !== undefined ? (passedOutYear ? Number(passedOutYear) : null) : undefined,
          currentStatus: currentStatus !== undefined ? (currentStatus || null) : undefined,
          // Only a LOST lead carries a reason — clear it the moment status moves elsewhere,
          // so re-opened leads don't keep showing a stale "why it was lost" reason.
          lostReason: newStage ? (newReason ? (newReason.lostReason as LeadLostReason) : null) : undefined,
          lostReasonKey: newStage ? (newReason ? newReason.lostReasonKey : null) : undefined,
        },
        include: { assignedTo: { select: employeeSelect } },
      });

      // History: assignment, stage and plain field edits each get their own line.
      const actor = req.user?.employeeId;
      const fullName = (e?: { firstName: string; lastName: string } | null) => (e ? `${e.firstName} ${e.lastName}` : 'Unassigned');
      if (assignedToId !== undefined && (assignedToId || null) !== before.assignedToId) {
        await moveOpenTasks(lead.id, assignedToId || null); // follow-up / demo tasks follow the lead to its new owner
        await logLeadHistory(lead.id, actor, 'ASSIGNED', `Reassigned from ${fullName(before.assignedTo)} to ${fullName(lead.assignedTo)}`, fullName(before.assignedTo), fullName(lead.assignedTo));
      }
      // Moving the lead to Demo done by hand finishes its scheduled demo so the Demo tab agrees.
      if (newStage && newStage.status === 'DEMO_DONE' && before.status !== 'DEMO_DONE') await completeScheduledDemos(lead.id, actor);
      if (newStage && (newStage.status === 'LOST' || newStage.status === 'ENROLLED')) await syncFollowUpTask(lead.id, null, null, actor);
      if (newStage) await ensureReminderForStage(lead.id, newStage.stageKey, actor).catch((e) => console.error('Auto reminder failed', e));
      if (newStage) {
        const beforeKey = before.stageKey || before.status;
        const afterKey = newStage.stageKey || newStage.status;
        if (beforeKey !== afterKey) {
          const cfgH = await leadConfig();
          await logLeadHistory(lead.id, actor, 'STAGE', `Lead stage changed from ${cfgH.label('STAGE', beforeKey)} to ${newStage.label}`, beforeKey, afterKey);
        }
      }
      if (scoutKey !== undefined && (scoutKey || null) !== before.scoutKey) {
        const cfgH = await leadConfig();
        await logLeadHistory(lead.id, actor, 'EDIT', `Lead Scout changed from ${before.scoutKey ? cfgH.label('SCOUT', before.scoutKey) : 'none'} to ${scoutKey ? cfgH.label('SCOUT', String(scoutKey)) : 'none'}`);
      }
      const changed: string[] = [];
      const cmp: Record<string, [unknown, unknown]> = {
        name: [name, before.name], phone: [phone, before.phone], email: [email, before.email], source: [source, before.source],
        courseInterest: [courseInterest, before.courseInterest], notes: [notes, before.notes],
        city: [city, before.city], educationQualification: [educationQualification, before.educationQualification],
        collegeName: [collegeName, before.collegeName], currentStatus: [currentStatus, before.currentStatus],
      };
      for (const [k, [next_, prev]] of Object.entries(cmp)) {
        if (next_ !== undefined && (next_ || null) !== (prev || null)) changed.push(k);
      }
      if (changed.length) await logLeadHistory(lead.id, actor, 'EDIT', `Edited ${changed.join(', ')}`);

      res.json({ success: true, data: lead });
    } catch (err) { next(err); }
  },

  /** Soft delete — the lead vanishes from every screen but the row, its call
   * logs, demos and history all stay in the database. */
  async deleteLead(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const lead = await prisma.lead.findUnique({ where: { id: req.params.id }, select: { id: true, deletedAt: true, name: true } });
      if (!lead) throw new AppError('Lead not found', 404);
      if (!lead.deletedAt) {
        await prisma.lead.update({ where: { id: lead.id }, data: { deletedAt: new Date(), deletedById: req.user?.employeeId } });
        await logLeadHistory(lead.id, req.user?.employeeId, 'DELETED', 'Lead removed from the screen (data retained)');
      }
      res.json({ success: true, message: 'Lead removed' });
    } catch (err) { next(err); }
  },

  /** Active courses — feeds the course dropdown on Log Activity / demo booking. */
  async courses(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const courses = await prisma.academyCourse.findMany({ where: { isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } });
      res.json({ success: true, data: courses });
    } catch (err) { next(err); }
  },

  /** Full audit trail for one lead, newest first. */
  async leadHistory(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await assertLeadAccess(req, req.params.id);
      const cutoff = await historyCutoff(await isSalesAdmin(req), req.params.id);
      const rows = await prisma.leadHistory.findMany({
        where: { leadId: req.params.id, ...(cutoff ? { createdAt: { gte: cutoff } } : {}) },
        include: { actor: { select: employeeSelect } },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: rows });
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
      const cutoff = await historyCutoff(await isSalesAdmin(req), req.params.id);
      const logs = await prisma.leadCallLog.findMany({
        where: { leadId: req.params.id, ...(cutoff ? { calledAt: { gte: cutoff } } : {}) },
        include: { calledBy: { select: employeeSelect } },
        orderBy: { calledAt: 'desc' },
      });
      res.json({ success: true, data: logs });
    } catch (err) { next(err); }
  },

  // Global call log — every call (manual or auto-tracked) across all leads,
  // like a phone's own call log rather than one lead's history. Two modes:
  // browse a single day (default today), or search a phone number to pull
  // its full history regardless of date. Non-admins only ever see calls they
  // personally made/received (calledById === themselves) — same self-scoping
  // as listLeads, just keyed off the call instead of the lead assignment.
  async listCallLog(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { date, phone, employeeId, page = 1, limit = 50 } = req.query;
      const p = Number(page), l = Math.min(Number(limit) || 50, 200);

      const where: Record<string, unknown> = {};
      const admin = await isSalesAdmin(req);
      if (!admin) {
        where.calledById = req.user?.employeeId || '__none__';
      } else if (employeeId) {
        where.calledById = employeeId;
      }

      // With an advanced filter active, the daily view's date limit steps aside (the filter can set its own dates).
      const advanced = buildWhereFromFilter(req.query.filter, CALL_FILTER_FIELDS);
      if (!phone && !advanced) {
        const day = date ? new Date(String(date)) : new Date();
        if (isNaN(day.getTime())) throw new AppError('Invalid date', 400);
        const start = new Date(day); start.setHours(0, 0, 0, 0);
        const end = new Date(start); end.setDate(end.getDate() + 1);
        where.calledAt = { gte: start, lt: end };
      }

      if (advanced) where.AND = [advanced];

      const include = {
        calledBy: { select: employeeSelect },
        lead: { select: { id: true, name: true, phone: true } },
      };

      if (phone) {
        // Stored numbers aren't consistently formatted (+91, leading 0,
        // spaces/dashes), so normalize both sides in app code instead of a
        // fragile SQL LIKE — same approach as the auto-ingestion matcher.
        // Fine at this table's scale (a sales team's calls, not millions of
        // rows), and this only runs on an explicit search, not a hot path.
        const normalized = normalizePhone(String(phone));
        const all = await prisma.leadCallLog.findMany({ where, include, orderBy: { calledAt: 'desc' } });
        const filtered = all.filter((c) => {
          const num = c.rawPhoneNumber || c.lead?.phone;
          return num && normalizePhone(num) === normalized;
        });
        const total = filtered.length;
        const paged = filtered.slice((p - 1) * l, p * l);
        res.json({ success: true, data: paged, meta: formatPagination(total, p, l) });
        return;
      }

      const [logs, total] = await Promise.all([
        prisma.leadCallLog.findMany({ where, include, orderBy: { calledAt: 'desc' }, ...paginate(p, l) }),
        prisma.leadCallLog.count({ where }),
      ]);
      res.json({ success: true, data: logs, meta: formatPagination(total, p, l) });
    } catch (err) { next(err); }
  },

  /**
   * Log Activity.
   *  - A *call* update must point at a real call from the call log (`callLogId`): the call's duration and
   *    recording stay the call's own, and the activity is attached to it. No new call-log row is invented.
   *  - A status update with no call (`callLogId` empty) changes the lead and writes History + a note, but
   *    never appears in the call log and does not count as a contact.
   *  - A *meeting / visit* is a real contact without a phone call, so it is logged as its own activity row.
   * Student intake (city, college…) is edited in the Profile tab only — it is not asked here.
   */
  async addCallLog(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await assertLeadAccess(req, req.params.id);
      const { notes, nextFollowUpAt, status, lostReason, activityType, activityStatus, courseInterest, callLogId } = req.body;

      // Order of the flow: Update Status first, then follow-up date+time, then lead stage.
      // The status list is Admin-managed (Config tab): each status knows its stage, whether a follow-up is needed and whether notes are.
      const cfg = await leadConfig();
      const sdef = cfg.find('STATUS', String(activityStatus || ''));
      if (!sdef || !sdef.base || !sdef.active) {
        throw new AppError('Choose a valid Update Status', 400);
      }
      const baseStatus = sdef.base as LeadActivityStatus;
      const customStatusKey = sdef.system ? null : sdef.key;
      const type = activityType === 'MEETING' ? 'MEETING' : 'CALL';
      if (sdef.notesRequired && !(notes && String(notes).trim())) {
        throw new AppError('Notes are required for this status', 400);
      }
      if (sdef.needsFollowUp && !nextFollowUpAt) {
        throw new AppError('Follow-up date and time are required for this status', 400);
      }
      if (nextFollowUpAt && isNaN(new Date(nextFollowUpAt).getTime())) throw new AppError('Invalid follow-up date', 400);
      if (baseStatus === 'DEMO_BOOKED' && !(courseInterest && String(courseInterest).trim())) {
        throw new AppError('Select the course for the demo', 400);
      }

      // The stage follows the status; an explicit stage from the form (e.g. Negotiation) wins unless it is Lost.
      const target = await resolveStage(sdef.targetStageKey || 'CUSTOM_FOLLOW_UP');
      let stage = target;
      if (status) stage = await resolveStage(String(status)); // an explicit stage from the form always wins
      let finalLostReason: LeadLostReason | null = null;
      let finalLostReasonKey: string | null = null;
      if (stage.status === 'LOST') {
        if (lostReason) {
          const r = await resolveLostReason(String(lostReason));
          finalLostReason = r.lostReason as LeadLostReason; finalLostReasonKey = r.lostReasonKey;
        } else finalLostReason = baseStatus === 'NOT_INTERESTED' || stage.stageKey === 'CUSTOM_NOT_INTERESTED' ? LeadLostReason.NOT_INTERESTED : stage.stageKey === 'CUSTOM_UNRESPONSIVE' ? LeadLostReason.UNREACHABLE : LeadLostReason.OTHER;
      }

      const leadId = req.params.id;
      const before = await prisma.lead.findUnique({ where: { id: leadId }, select: { status: true, stageKey: true, activityStatus: true, statusKey: true, nextFollowUpAt: true, deletedAt: true, courseInterest: true, assignedToId: true, dnpCount: true } });
      if (!before || before.deletedAt) throw new AppError('Lead not found', 404);

      // DNP counter: consecutive "did not pick" updates. Any other update resets it; the 5th DNP makes the lead Unresponsive.
      const DNP_LIMIT = 5;
      const dnpCount = baseStatus === 'DNP' ? before.dnpCount + 1 : 0;
      const autoUnresponsive = baseStatus === 'DNP' && dnpCount >= DNP_LIMIT;
      if (autoUnresponsive) {
        stage = await resolveStage('CUSTOM_UNRESPONSIVE');
        finalLostReason = LeadLostReason.UNREACHABLE; finalLostReasonKey = null;
      }

      // Which call (if any) is this update about?
      let linkedCall: { id: string; calledAt: Date } | null = null;
      if (callLogId) {
        const c = await prisma.leadCallLog.findUnique({ where: { id: String(callLogId) }, select: { id: true, leadId: true, calledAt: true, activityStatus: true } });
        if (!c || c.leadId !== leadId) throw new AppError('That call does not belong to this lead', 400);
        if (c.activityStatus) throw new AppError('That call already has an update attached', 400);
        linkedCall = { id: c.id, calledAt: c.calledAt };
      }
      const isMeeting = type === 'MEETING';
      const touched = isMeeting ? new Date() : linkedCall?.calledAt ?? null; // a real contact happened
      // Closed-out statuses clear the reminder; open ones set the chosen date+time.
      const followUpValue = sdef.needsFollowUp && stage.status !== 'LOST' && stage.status !== 'ENROLLED' ? new Date(nextFollowUpAt) : null;
      const noteText = notes ? String(notes) : null;

      const leadData = {
        ...(touched ? { lastContactAt: touched } : {}),
        nextFollowUpAt: followUpValue,
        activityStatus: baseStatus,
        statusKey: customStatusKey,
        dnpCount,
        status: stage.status as LeadStatus,
        stageKey: stage.stageKey,
        lostReason: finalLostReason,
        lostReasonKey: finalLostReasonKey,
        courseInterest: courseInterest ? String(courseInterest) : undefined,
      };

      let log: unknown = null;
      if (linkedCall) {
        const [updated] = await prisma.$transaction([
          prisma.leadCallLog.update({
            where: { id: linkedCall.id },
            data: { notes: noteText, nextFollowUpAt: followUpValue, activityType: 'CALL', activityStatus: baseStatus, statusKey: customStatusKey },
            include: { calledBy: { select: employeeSelect } },
          }),
          prisma.lead.update({ where: { id: leadId }, data: leadData }),
        ]);
        log = updated;
      } else if (isMeeting) {
        const [created] = await prisma.$transaction([
          prisma.leadCallLog.create({
            data: { leadId, calledById: req.user?.employeeId, notes: noteText, nextFollowUpAt: followUpValue, calledAt: new Date(), activityType: 'MEETING', activityStatus: baseStatus, statusKey: customStatusKey },
            include: { calledBy: { select: employeeSelect } },
          }),
          prisma.lead.update({ where: { id: leadId }, data: leadData }),
        ]);
        log = created;
      } else {
        // Status update without a call: lead + history + note only — nothing in the call log.
        await prisma.lead.update({ where: { id: leadId }, data: leadData });
        if (noteText) await prisma.leadNote.create({ data: { leadId, authorId: req.user?.employeeId || null, body: noteText } }).catch(() => {});
      }

      const actor = req.user?.employeeId;
      const fmt = (d: Date | null) => (d ? d.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : 'none');
      const beforeStatusKey = before.statusKey || before.activityStatus;
      const beforeStageKey = before.stageKey || before.status;
      const what = isMeeting ? 'Meeting logged' : linkedCall ? 'Call update logged' : 'Status updated (no call)';
      await logLeadHistory(leadId, actor, 'ACTIVITY',
        `${what} — status ${sdef.label}${baseStatus === 'DNP' ? ` (DNP ${dnpCount} of ${DNP_LIMIT} in a row)` : ''}${notes ? `: ${String(notes).slice(0, 300)}` : ' (no notes)'}`,
        beforeStatusKey, sdef.key);
      if (beforeStatusKey !== sdef.key) {
        await logLeadHistory(leadId, actor, 'STATUS', `Status changed from ${beforeStatusKey ? cfg.label('STATUS', beforeStatusKey) : 'none'} to ${sdef.label}`, beforeStatusKey, sdef.key);
      }
      if (autoUnresponsive) await logLeadHistory(leadId, actor, 'STAGE', `Did not pick ${DNP_LIMIT} times in a row — lead marked Unresponsive automatically`);
      const newStageKey = stage.stageKey || stage.status;
      if (beforeStageKey !== newStageKey) {
        await logLeadHistory(leadId, actor, 'STAGE', `Lead stage changed from ${cfg.label('STAGE', beforeStageKey)} to ${stage.label}`, beforeStageKey, newStageKey);
      }
      if ((before.nextFollowUpAt?.getTime() ?? null) !== (followUpValue?.getTime() ?? null)) {
        await logLeadHistory(leadId, actor, 'FOLLOW_UP', `Follow-up ${followUpValue ? `set to ${fmt(followUpValue)}` : 'cleared'}`, fmt(before.nextFollowUpAt), fmt(followUpValue));
      }

      // Follow-up date → task (the previous follow-up task is closed). Demo over → the booked demo is finished too.
      // DEMO_BOOKED's own slot is a demo task created by the demo booking, not a follow-up.
      await syncFollowUpTask(leadId, before.assignedToId, baseStatus === 'DEMO_BOOKED' ? null : followUpValue, actor, noteText || undefined);
      if (baseStatus === 'DEMO_OVER' || stage.status === 'DEMO_DONE') await completeScheduledDemos(leadId, actor);

      res.status(201).json({ success: true, data: log, meta: { loggedInCallLog: !!log } });
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
        if (leadId) {
          const cutoff = await historyCutoff(false, String(leadId));
          if (cutoff) where.scheduledAt = { gte: cutoff };
        }
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
      const { leadId, scheduledAt, mode, conductedById, status, feedback, courseEnquired, attendeeEmail } = req.body;
      if (!leadId || !scheduledAt) throw new AppError('leadId and scheduledAt are required', 400);
      await assertLeadAccess(req, leadId);

      // Student intake is captured during the call (Log Activity), not here —
      // pull whatever's already on file for this lead so the demo record
      // still carries a full snapshot without asking the BDA to retype it.
      const lead = await prisma.lead.findUnique({
        where: { id: leadId },
        select: {
          city: true, educationQualification: true, collegeName: true,
          passedOutYear: true, currentStatus: true, courseInterest: true, email: true, deletedAt: true, name: true,
        },
      });
      if (!lead || lead.deletedAt) throw new AppError('Lead not found', 404);

      // The course is mandatory on every demo booking.
      const course = String(courseEnquired || lead.courseInterest || '').trim();
      if (!course) throw new AppError('Select the course for this demo', 400);

      // Online demos run inside the portal and the prospect is emailed their
      // link, so a valid email is needed (saved onto the lead if it had none).
      const online = (mode || 'ONLINE') === 'ONLINE';
      const email = String(attendeeEmail || lead.email || '').trim().toLowerCase();
      if (online && !/^\S+@\S+\.\S+$/.test(email)) throw new AppError('A valid email is required to send the online demo link', 400);

      const bookingNumber = await nextDemoBookingNumber(prisma);
      const roomFields = online
        ? { roomName: `salesdemo-${bookingNumber.toLowerCase()}-${newDemoCode().slice(0, 4).toLowerCase()}`, accessCode: newDemoCode() }
        : {};

      const [demo] = await prisma.$transaction([
        prisma.demo.create({
          data: {
            leadId, scheduledAt: new Date(scheduledAt), mode, conductedById: conductedById || undefined, status, feedback,
            bookingNumber,
            city: lead.city ?? undefined,
            educationQualification: lead.educationQualification ?? undefined,
            collegeName: lead.collegeName ?? undefined,
            passedOutYear: lead.passedOutYear ?? undefined,
            currentStatus: lead.currentStatus ?? undefined,
            courseEnquired: course,
            ...roomFields,
          },
          include: { lead: true, conductedBy: { select: employeeSelect } },
        }),
        prisma.lead.update({
          where: { id: leadId },
          data: { status: 'DEMO_SCHEDULED', stageKey: null, courseInterest: course, ...(online && !lead.email ? { email } : {}) },
        }),
      ]);

      await upsertDemoTask(demo.id, req.user?.employeeId).catch((e) => console.error('Demo task failed', e));
      // A booked demo is also the lead's next reminder when it has none.
      await prisma.lead.updateMany({ where: { id: leadId, nextFollowUpAt: null }, data: { nextFollowUpAt: new Date(scheduledAt) } }).catch(() => {});
      // A demo booking replaces any open follow-up — the demo itself is now the next thing to do.
      await syncFollowUpTask(leadId, null, null, req.user?.employeeId).catch(() => {});
      await logLeadHistory(leadId, req.user?.employeeId, 'DEMO', `Demo ${bookingNumber} booked (${online ? 'online' : 'offline'}) for ${course} on ${new Date(scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })}`);
      if (online) {
        const me = req.user?.employeeId ? await prisma.employee.findUnique({ where: { id: req.user.employeeId }, select: { firstName: true, lastName: true } }) : null;
        // Best effort — a mail hiccup must never block the booking itself.
        announceOnlineDemo(demo.id, me ? `${me.firstName} ${me.lastName}` : 'Sales').catch((e) => console.error('Online demo announce failed', e));
      }
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
        select: { leadId: true, proofUrl: true, mode: true, startedAt: true, roomName: true, status: true, scheduledAt: true },
      });
      if (!existingDemo) throw new AppError('Demo not found', 404);
      await assertLeadAccess(req, existingDemo.leadId);

      const { scheduledAt, mode, conductedById, status, feedback, outcome, coConductedById, followUpAt } = req.body;
      const proofFile = req.file as Express.Multer.File | undefined;

      if (outcome && !OUTCOME_PLAN[String(outcome)]) throw new AppError('Unknown demo outcome', 400);
      if (status === 'COMPLETED') {
        if (!outcome) {
          throw new AppError('Pick the lead stage (Demo Over - Positive / Need Follow up / Not Interested) when marking a demo Conducted', 400);
        }
        // Proof of demo is optional for now (a photo can still be attached).
      }
      if (followUpAt && isNaN(new Date(followUpAt).getTime())) throw new AppError('Invalid follow-up date', 400);

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

      const actor = req.user?.employeeId;
      // The demo slot doubles as the lead's reminder: finishing/cancelling clears it, a new slot moves it.
      if (status === 'COMPLETED' || status === 'NO_SHOW' || status === 'CANCELLED') await moveDemoReminder(demo.leadId, existingDemo.scheduledAt, null);
      else if (scheduledAt) await moveDemoReminder(demo.leadId, existingDemo.scheduledAt, new Date(scheduledAt));
      if (status === 'COMPLETED') {
        await closeDemoTask(demo.id, 'DONE');
        await prisma.lead.update({ where: { id: demo.leadId }, data: { status: 'DEMO_DONE', stageKey: null } });
        // The outcome decides where the lead goes next (and sets the follow-up task where one is needed).
        await applyDemoOutcome(demo.leadId, String(outcome), actor, followUpAt ? new Date(followUpAt) : null);
      } else if (status === 'NO_SHOW') {
        await closeDemoTask(demo.id, 'DONE');
        await logLeadHistory(demo.leadId, actor, 'DEMO', `Demo ${demo.bookingNumber} marked No Show`);
      } else if (status === 'CANCELLED') {
        await closeDemoTask(demo.id, 'CANCELLED');
        await logLeadHistory(demo.leadId, actor, 'DEMO', `Demo ${demo.bookingNumber} cancelled`);
      } else if (!status && outcome && existingDemo.status === 'COMPLETED') {
        // Outcome filled in later for a demo that was finished without one (e.g. lead moved to Demo over by hand).
        await applyDemoOutcome(demo.leadId, String(outcome), actor, followUpAt ? new Date(followUpAt) : null);
      } else if (scheduledAt || conductedById) {
        await upsertDemoTask(demo.id, actor);
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
      const newMode = mode || original.mode;
      // An online demo needs its own room + access code (the old ones belonged to the frozen booking).
      const roomFields = newMode === 'ONLINE'
        ? { roomName: `salesdemo-${bookingNumber.toLowerCase()}-${newDemoCode().slice(0, 4).toLowerCase()}`, accessCode: newDemoCode(), maxMinutes: original.maxMinutes }
        : {};

      const [, , newDemo] = await prisma.$transaction([
        prisma.demo.update({ where: { id: original.id }, data: { status: 'RESCHEDULED', rescheduleReason: reason } }),
        prisma.lead.update({ where: { id: original.leadId }, data: { status: 'DEMO_SCHEDULED', stageKey: null } }),
        prisma.demo.create({
          data: {
            leadId: original.leadId,
            scheduledAt: new Date(scheduledAt),
            mode: newMode,
            status: 'SCHEDULED',
            rescheduledFromId: original.id,
            bookingNumber,
            conductedById: original.conductedById,
            ...roomFields,
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

      await closeDemoTask(original.id, 'CANCELLED');
      await moveDemoReminder(original.leadId, original.scheduledAt, new Date(scheduledAt));
      await upsertDemoTask(newDemo.id, req.user?.employeeId).catch((e) => console.error('Demo task failed', e));
      await logLeadHistory(original.leadId, req.user?.employeeId, 'DEMO', `Demo ${original.bookingNumber} rescheduled to ${new Date(scheduledAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })} (${newDemo.bookingNumber}): ${reason}`);
      if (newMode === 'ONLINE') {
        const me = req.user?.employeeId ? await prisma.employee.findUnique({ where: { id: req.user.employeeId }, select: { firstName: true, lastName: true } }) : null;
        announceOnlineDemo(newDemo.id, me ? `${me.firstName} ${me.lastName}` : 'Sales').catch((e) => console.error('Online demo announce failed', e));
      }
      res.status(201).json({ success: true, data: newDemo });
    } catch (err) { next(err); }
  },

  // ── Summary stats ────────────────────────────────────────────────────────
  async stats(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isSalesAdmin(req);
      const ownLeadWhere: Record<string, unknown> = admin ? { deletedAt: null } : { deletedAt: null, assignedToId: req.user?.employeeId || '__none__' };
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
        where: {
          status: 'ACTIVE',
          // Super Admin's own employee record is flagged isSystemAccount so it
          // stays out of ordinary employee lists/counts — but it still needs to
          // survive here so the SUPER_ADMIN bypass below can see it.
          OR: [{ isSystemAccount: false }, { user: { role: 'SUPER_ADMIN' } }],
        },
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
  async pulse(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { start, end } = req.query;
      let range: { start: Date; end: Date } | undefined;
      if (start && end) {
        const s = new Date(String(start)), e = new Date(String(end));
        if (isNaN(s.getTime()) || isNaN(e.getTime())) throw new AppError('Invalid start/end date', 400);
        range = { start: s, end: e };
      }
      const data = await computeSalesPulse(range);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  // ── Leaderboard + Targets — per-salesperson KPI breakdown and the monthly
  // goals a SALES ADMIN sets against them. Both ADMIN-only, same as Pulse.

  async leaderboard(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { start, end, month, year } = req.query;
      if (!start || !end) throw new AppError('start and end dates are required', 400);
      const s = new Date(String(start)), e = new Date(String(end));
      if (isNaN(s.getTime()) || isNaN(e.getTime())) throw new AppError('Invalid start/end date', 400);
      const m = month ? Number(month) : undefined;
      const y = year ? Number(year) : undefined;
      const data = await computeSalesLeaderboard(s, e, m, y);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async listTargets(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { month, year } = req.query;
      if (!month || !year) throw new AppError('month and year are required', 400);
      const targets = await prisma.salesTarget.findMany({
        where: { month: Number(month), year: Number(year) },
        include: { employee: { select: employeeSelect } },
      });
      res.json({ success: true, data: targets });
    } catch (err) { next(err); }
  },

  /** Upsert — setting a target for a rep who already has one this month
   * just overwrites it, so admins can freely revise a goal mid-month. */
  async setTarget(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { employeeId, month, year, enrollmentGoal, revenueGoal } = req.body;
      if (!employeeId || !month || !year) throw new AppError('employeeId, month, and year are required', 400);
      const m = Number(month), y = Number(year);
      if (m < 1 || m > 12) throw new AppError('month must be between 1 and 12', 400);

      const target = await prisma.salesTarget.upsert({
        where: { employeeId_month_year: { employeeId, month: m, year: y } },
        update: { enrollmentGoal: Number(enrollmentGoal) || 0, revenueGoal: Number(revenueGoal) || 0, setById: req.user!.employeeId },
        create: {
          employeeId, month: m, year: y,
          enrollmentGoal: Number(enrollmentGoal) || 0, revenueGoal: Number(revenueGoal) || 0,
          setById: req.user!.employeeId,
        },
        include: { employee: { select: employeeSelect } },
      });
      res.json({ success: true, data: target });
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

  // ── My Students (Sales advisor visibility) ──────────────────────────────
  // Every student can optionally be linked to a "Skill Advisor" — the Sales
  // employee who enrolled them, set via employee code at intake (Production's
  // Add Student / bulk upload / PT direct-to-pool, see production.controller
  // resolveEmployeeByCode). This gives that advisor a self-scoped "My
  // Students" view of their own students' full academy record, plus a
  // SALES=ADMIN-gated cross-rep overview — same split as listLeads/listDemos.

  /** Self-scoped: the students where the caller is the Skill Advisor. */
  async myStudents(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user?.employeeId;
      if (!employeeId) return res.json({ success: true, data: [] });
      const students = await listStudentsSummary({ skillAdvisorId: employeeId });
      res.json({ success: true, data: students });
    } catch (err) { next(err); }
  },

  /**
   * Cross-rep overview — every student that has a Skill Advisor assigned,
   * optionally filtered to one advisor. Route-gated SALES=ADMIN (same
   * treatment as Pulse/Leaderboard), so no in-handler admin check is needed.
   */
  async advisedStudents(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { advisorId } = req.query;
      const students = await listStudentsSummary(
        advisorId ? { skillAdvisorId: String(advisorId) } : { skillAdvisorId: { not: null } }
      );
      res.json({ success: true, data: students });
    } catch (err) { next(err); }
  },

  /**
   * Full A-to-Z dossier for one advised student: rank card (attendance /
   * marks / projects / module feedback — shared util with Placements'
   * getStudentProfile and the certificate approval review screen), trainer
   * feedback, internal Softskill/Aptitude feedback (never shown to the
   * student themselves), certificate request status, and placement
   * interviews/results. A regular advisor may only open their own advisee;
   * SALES=ADMIN can open anyone's.
   */
  async myStudentDetail(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const student = await prisma.student.findUnique({
        where: { id },
        include: {
          user: { select: { email: true, lastLoginAt: true } },
          portfolio: true,
          skillAdvisor: { select: employeeSelect },
        },
      });
      if (!student) throw new AppError('Student not found', 404);
      if (student.skillAdvisorId !== req.user?.employeeId && !(await isSalesAdmin(req))) {
        throw new AppError('You do not have access to this student', 403);
      }

      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { studentId: id },
        include: { schedule: { include: { course: { select: { id: true, name: true } }, batch: { select: { code: true } } } } },
      });

      const [interviews, results, trainerFeedbacks, softskillFeedback, certificateRequests] = await Promise.all([
        prisma.placementInterview.findMany({
          where: { studentId: id },
          include: {
            drive: { include: { partner: { select: { id: true, name: true } } } },
            feedbackGivenBy: { select: employeeSelect },
          },
          orderBy: { scheduledAt: 'desc' },
        }),
        prisma.placementResult.findMany({
          where: { studentId: id },
          include: { drive: { include: { partner: { select: { id: true, name: true } } } } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.trainerFeedback.findMany({
          where: { studentId: id },
          include: { trainer: { select: employeeSelect }, course: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.softskillFeedback.findMany({
          where: { studentId: id },
          include: { session: { select: { topic: true, type: true, startDate: true } }, trainer: { select: employeeSelect } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.studentCertificateRequest.findMany({
          where: { studentId: id },
          include: { course: { select: { name: true } } },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      const [rankCard, onboardingStatus] = await Promise.all([
        computeRankCard(id),
        getOnboardingStatus(id),
      ]);

      res.json({
        success: true,
        data: {
          student: { ...student, enrollments, trainerFeedbacks },
          interviews,
          results,
          rankCard,
          softskillFeedback,
          certificateRequests,
          onboarding: {
            allSigned: onboardingStatus.allSigned,
            items: onboardingStatus.items.map((it) => ({ id: it.id, title: it.title, signed: it.signed, signedAt: it.signedAt })),
          },
        },
      });
    } catch (err) { next(err); }
  },
};
