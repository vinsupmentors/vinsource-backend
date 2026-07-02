import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { paginate, formatPagination } from '../utils/helpers';

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };

export const salesController = {
  // ── Leads ────────────────────────────────────────────────────────────────
  async listLeads(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 20, status, search, assignedToId } = req.query;
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

      const [leads, total] = await Promise.all([
        prisma.lead.findMany({
          where,
          include: {
            assignedTo: { select: employeeSelect },
            campaign: { select: { id: true, name: true } },
            _count: { select: { demos: true } },
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
      const { name, phone, email, source, courseInterest, status, assignedToId, campaignId, notes } = req.body;
      const lead = await prisma.lead.update({
        where: { id: req.params.id },
        data: { name, phone, email, source, courseInterest, status, assignedToId, campaignId, notes },
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
      const { leadId, scheduledAt, conductedById, status, feedback } = req.body;
      if (!leadId || !scheduledAt) throw new AppError('leadId and scheduledAt are required', 400);

      const [demo] = await prisma.$transaction([
        prisma.demo.create({
          data: { leadId, scheduledAt: new Date(scheduledAt), conductedById, status, feedback },
          include: { lead: true, conductedBy: { select: employeeSelect } },
        }),
        prisma.lead.update({ where: { id: leadId }, data: { status: 'DEMO_SCHEDULED' } }),
      ]);
      res.status(201).json({ success: true, data: demo });
    } catch (err) { next(err); }
  },

  async updateDemo(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduledAt, conductedById, status, feedback } = req.body;
      const demo = await prisma.demo.update({
        where: { id: req.params.id },
        data: {
          scheduledAt: scheduledAt ? new Date(scheduledAt) : undefined,
          conductedById, status, feedback,
        },
        include: { lead: true, conductedBy: { select: employeeSelect } },
      });

      if (status === 'COMPLETED') {
        await prisma.lead.update({ where: { id: demo.leadId }, data: { status: 'DEMO_DONE' } });
      }

      res.json({ success: true, data: demo });
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
};
