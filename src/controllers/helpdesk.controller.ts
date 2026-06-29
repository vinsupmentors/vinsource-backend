import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { paginate, formatPagination } from '../utils/helpers';

export const helpdeskController = {
  // Employee raises a ticket
  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const emp = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!emp) throw new AppError('Employee not found', 404);

      const { subject, description, priority, departmentId } = req.body;
      if (!subject || !description) throw new AppError('Subject and description are required', 400);

      const ticket = await prisma.helpDeskTicket.create({
        data: {
          employeeId: emp.id,
          subject,
          description,
          priority: priority || 'MEDIUM',
          departmentId: departmentId || emp.departmentId,
        },
        include: {
          employee: { select: { firstName: true, lastName: true, employeeCode: true } },
          department: { select: { name: true } },
        },
      });

      res.status(201).json({ success: true, data: ticket });
    } catch (err) { next(err); }
  },

  // Employee's own tickets
  async myTickets(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const emp = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!emp) return res.json({ success: true, data: [] });

      const { status } = req.query;
      const where: Record<string, unknown> = { employeeId: emp.id };
      if (status) where.status = status;

      const tickets = await prisma.helpDeskTicket.findMany({
        where,
        include: {
          department: { select: { name: true } },
          comments: { orderBy: { createdAt: 'asc' } },
          _count: { select: { comments: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      res.json({ success: true, data: tickets });
    } catch (err) { next(err); }
  },

  // HR/Manager: all tickets for company
  async listAll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId!;
      const { page = 1, limit = 20, status, priority } = req.query;
      const p = Number(page), l = Number(limit);

      const where: Record<string, unknown> = { employee: { companyId } };
      if (status) where.status = status;
      if (priority) where.priority = priority;

      const [tickets, total] = await Promise.all([
        prisma.helpDeskTicket.findMany({
          where,
          include: {
            employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true, profilePhoto: true } },
            department: { select: { name: true } },
            _count: { select: { comments: true } },
          },
          orderBy: [{ status: 'asc' }, { priority: 'desc' }, { createdAt: 'asc' }],
          ...paginate(p, l),
        }),
        prisma.helpDeskTicket.count({ where }),
      ]);

      res.json({ success: true, data: tickets, meta: formatPagination(total, p, l) });
    } catch (err) { next(err); }
  },

  // Get single ticket with full comments
  async get(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const ticket = await prisma.helpDeskTicket.findUnique({
        where: { id: req.params.id },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
          department: { select: { name: true } },
          comments: { orderBy: { createdAt: 'asc' } },
        },
      });
      if (!ticket) throw new AppError('Ticket not found', 404);
      res.json({ success: true, data: ticket });
    } catch (err) { next(err); }
  },

  // Add comment to ticket
  async addComment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { comment } = req.body;
      if (!comment?.trim()) throw new AppError('Comment cannot be empty', 400);

      const ticket = await prisma.helpDeskTicket.findUnique({ where: { id: req.params.id } });
      if (!ticket) throw new AppError('Ticket not found', 404);

      // Auto-move to IN_PROGRESS when HR/Manager comments on an OPEN ticket
      const role = req.user!.role;
      const isHR = ['HR', 'ADMIN', 'SUPER_ADMIN', 'MANAGER'].includes(role);
      if (isHR && ticket.status === 'OPEN') {
        await prisma.helpDeskTicket.update({
          where: { id: ticket.id },
          data: { status: 'IN_PROGRESS', assignedTo: req.user!.userId },
        });
      }

      const ticketComment = await prisma.ticketComment.create({
        data: { ticketId: ticket.id, authorId: req.user!.userId, comment },
      });

      res.status(201).json({ success: true, data: ticketComment });
    } catch (err) { next(err); }
  },

  // Update ticket status / priority
  async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status, priority, assignedTo } = req.body;

      const ticket = await prisma.helpDeskTicket.update({
        where: { id: req.params.id },
        data: {
          status: status as any,
          priority: priority as any,
          assignedTo,
          resolvedAt: status === 'RESOLVED' || status === 'CLOSED' ? new Date() : undefined,
        },
        include: {
          employee: { select: { firstName: true, lastName: true, employeeCode: true } },
          department: { select: { name: true } },
          comments: { orderBy: { createdAt: 'asc' } },
        },
      });

      res.json({ success: true, data: ticket });
    } catch (err) { next(err); }
  },
};
