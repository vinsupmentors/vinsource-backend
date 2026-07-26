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
