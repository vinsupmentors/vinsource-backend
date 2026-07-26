import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { paginate, formatPagination } from '../utils/helpers';
import { computeSalesPulse } from '../services/salesPulse.service';

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
        prisma.employee.findMany({ select: { id: true, employeeCode: true } }),
        prisma.campaign.findMany({ select: { id: true, name: true } }),
        prisma.lead.findMany({ select: { phone: true } }),
      ]);
      const employeeByCode = new Map(allEmployees.map((e) => [e.employeeCode.trim().toLowerCase(), e.id]));
      const campaignByName = new Map(allCampaigns.map((c) => [c.name.trim().toLowerCase(), c.id]));
      const existingPhones = new Set(existingLeads.map((l) => l.phone.trim()));

      const results: Array<{ row: number; status: 'created' | 'error'; message?: string; leadId?: string }> = [];

      for (let i = 0; i < leads.length; i++) {
        const row = leads[i] || {};
        const rowNum = i + 1;
        try {
          const name = String(row.name || '').trim();
          const phone = String(row.phone || '').trim();
          if (!name || !phone) {
            results.push({ row: rowNum, status: 'error', message: 'name and phone are required' });
            continue;
          }
          if (existingPhones.has(phone)) {
            results.push({ row: rowNum, status: 'error', message: `A lead with phone "${phone}" already exists` });
            continue;
          }

          const assignedRaw = String(row.assignedToCode || row.assignedTo || '').trim();
          const assignedToId = assignedRaw ? employeeByCode.get(assignedRaw.toLowerCase()) : undefined;
          if (assignedRaw && !assignedToId) {
            results.push({ row: rowNum, status: 'error', message: `Employee code "${assignedRaw}" not found` });
            continue;
          }

          const campaignRaw = String(row.campaign || '').trim();
          const campaignId = campaignRaw ? campaignByName.get(campaignRaw.toLowerCase()) : undefined;
          if (campaignRaw && !campaignId) {
            results.push({ row: rowNum, status: 'error', message: `Campaign "${campaignRaw}" not found` });
            continue;
          }

          const lead = await prisma.lead.create({
            data: {
              name,
              phone,
              email: row.email ? String(row.email).trim() : undefined,
              source: row.source ? String(row.source).trim() : undefined,
              courseInterest: row.courseInterest ? String(row.courseInterest).trim() : undefined,
              notes: row.notes ? String(row.notes).trim() : undefined,
              assignedToId,
              campaignId,
            },
          });
          existingPhones.add(phone);
          results.push({ row: rowNum, status: 'created', leadId: lead.id });
        } catch (rowErr) {
          results.push({ row: rowNum, status: 'error', message: rowErr instanceof Error ? rowErr.message : 'Unknown error' });
        }
      }

      const created = results.filter((r) => r.status === 'created').length;
      res.status(201).json({ success: true, data: { results, created, failed: results.length - created } });
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

      const demos = await prisma.demo.findMany({
        where,
        include: {
          lead: { select: { id: true, name: true, phone: true } },
          conductedBy: { select: employeeSelect },
        },
        orderBy: { scheduledAt: 'desc' },
      });
      res.json({ success: true, data: demos });
    } catch (err) { next(err); }
  },

  async createDemo(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { leadId, scheduledAt, mode, conductedById, status, feedback } = req.body;
      if (!leadId || !scheduledAt) throw new AppError('leadId and scheduledAt are required', 400);

      const [demo] = await prisma.$transaction([
        prisma.demo.create({
          data: { leadId, scheduledAt: new Date(scheduledAt), mode, conductedById, status, feedback },
          include: { lead: true, conductedBy: { select: employeeSelect } },
        }),
        prisma.lead.update({ where: { id: leadId }, data: { status: 'DEMO_SCHEDULED' } }),
      ]);
      res.status(201).json({ success: true, data: demo });
    } catch (err) { next(err); }
  },

  async updateDemo(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduledAt, mode, conductedById, status, feedback } = req.body;
      const demo = await prisma.demo.update({
        where: { id: req.params.id },
        data: {
          scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
          mode, conductedById, status, feedback,
        },
        include: { lead: true, conductedBy: { select: employeeSelect } },
      });

      if (status === 'COMPLETED') {
        await prisma.lead.update({ where: { id: demo.leadId }, data: { status: 'DEMO_DONE' } });
      }

      res.json({ success: true, data: demo });
    } catch (err) { next(err); }
  },

  /**
   * Reschedules a demo without losing the trail: the original row is frozen
   * as RESCHEDULED (so "was today's demo conducted or rescheduled" reporting
   * has a real record of what was originally planned) and a fresh SCHEDULED
   * row is created pointing back at it via rescheduledFromId.
   */
  async rescheduleDemo(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduledAt, mode } = req.body;
      if (!scheduledAt) throw new AppError('New scheduledAt is required', 400);

      const original = await prisma.demo.findUnique({ where: { id: req.params.id } });
      if (!original) throw new AppError('Demo not found', 404);

      const [, , newDemo] = await prisma.$transaction([
        prisma.demo.update({ where: { id: original.id }, data: { status: 'RESCHEDULED' } }),
        prisma.lead.update({ where: { id: original.leadId }, data: { status: 'DEMO_SCHEDULED' } }),
        prisma.demo.create({
          data: {
            leadId: original.leadId,
            scheduledAt: new Date(scheduledAt),
            mode: mode || original.mode,
            status: 'SCHEDULED',
            rescheduledFromId: original.id,
          },
          include: { lead: true, conductedBy: { select: employeeSelect } },
        }),
      ]);

      res.status(201).json({ success: true, data: newDemo });
    } catch (err) { next(err); }
  },

  // ── Summary stats ────────────────────────────────────────────────────────
  async stats(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const [byStatus, totalLeads, upcomingDemos, enrolledThisMonth] = await Promise.all([
        prisma.lead.groupBy({ by: ['status'], _count: { _all: true } }),
        prisma.lead.count(),
        prisma.demo.count({
          where: { status: 'SCHEDULED', scheduledAt: { gte: new Date() } },
        }),
        prisma.lead.count({
          where: {
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
