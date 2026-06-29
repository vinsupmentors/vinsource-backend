import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { notificationService } from '../services/notification.service';

export const permissionController = {

  // Company-wide permission/half-day oversight for SUPER_ADMIN — every
  // employee's requests with status and the deciding manager's name.
  async all(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId!;
      const { status } = req.query;
      const where: Record<string, unknown> = { employee: { companyId } };
      if (status) where.status = status;

      const perms = await prisma.permission.findMany({
        where,
        include: {
          employee: { select: { firstName: true, lastName: true, employeeCode: true } },
          manager: { select: { firstName: true, lastName: true } },
        },
        orderBy: { date: 'desc' },
      });

      res.json({ success: true, data: perms });
    } catch (err) { next(err); }
  },

  async apply(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({
        where: { userId: req.user!.userId },
        include: { manager: { include: { user: true } } },
      });
      if (!employee) throw new AppError('Employee not found', 404);

      const { date, fromTime, toTime, type = 'PERMISSION', session, reason } = req.body;
      if (!date || !reason) throw new AppError('date and reason are required', 400);
      if (type === 'PERMISSION' && (!fromTime || !toTime)) throw new AppError('fromTime and toTime required for permission', 400);
      if (type === 'HALF_DAY' && !session) throw new AppError('session (MORNING/AFTERNOON) required for half-day', 400);

      const perm = await prisma.permission.create({
        data: {
          employeeId: employee.id,
          date: new Date(date),
          fromTime: fromTime ?? '09:00',
          toTime: toTime ?? '11:00',
          type,
          session: session ?? null,
          reason,
          status: 'PENDING',
          managerId: employee.managerId ?? null,
        },
      });

      if (employee.manager?.user) {
        const label = type === 'HALF_DAY' ? 'Half Day' : 'Permission';
        await notificationService.create({
          userId: employee.manager.user.id,
          type: 'LEAVE_REQUEST',
          title: `${label} Request`,
          message: `${employee.firstName} ${employee.lastName} has requested ${label.toLowerCase()} on ${new Date(date).toDateString()}`,
        });
      }

      res.status(201).json({ success: true, data: perm });
    } catch (err) { next(err); }
  },

  async myPermissions(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const perms = await prisma.permission.findMany({
        where: { employeeId: employee.id },
        orderBy: { date: 'desc' },
      });

      res.json({ success: true, data: perms });
    } catch (err) { next(err); }
  },

  async pending(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const perms = await prisma.permission.findMany({
        where: { managerId: manager.id, status: 'PENDING' },
        include: {
          employee: { select: { firstName: true, lastName: true, employeeCode: true } },
        },
        orderBy: { date: 'asc' },
      });

      res.json({ success: true, data: perms });
    } catch (err) { next(err); }
  },

  async approve(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const { id } = req.params;
      const { note } = req.body;

      const perm = await prisma.permission.findUnique({ where: { id } });
      if (!perm) throw new AppError('Permission request not found', 404);
      if (perm.managerId !== manager.id) throw new AppError('Not authorized', 403);
      if (perm.status !== 'PENDING') throw new AppError('Already processed', 400);

      await prisma.permission.update({
        where: { id },
        data: { status: 'APPROVED', managerNote: note ?? null, actedAt: new Date() },
      });

      const emp = await prisma.employee.findUnique({ where: { id: perm.employeeId }, include: { user: true } });
      if (emp) {
        const label = perm.type === 'HALF_DAY' ? 'Half Day' : 'Permission';
        await notificationService.create({
          userId: emp.user.id,
          type: 'LEAVE_APPROVED',
          title: `${label} Approved ✓`,
          message: `Your ${label.toLowerCase()} request for ${new Date(perm.date).toDateString()} has been approved`,
        });
      }

      res.json({ success: true, message: 'Approved' });
    } catch (err) { next(err); }
  },

  async reject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const { id } = req.params;
      const { note } = req.body;

      const perm = await prisma.permission.findUnique({ where: { id } });
      if (!perm) throw new AppError('Permission request not found', 404);
      if (perm.managerId !== manager.id) throw new AppError('Not authorized', 403);
      if (perm.status !== 'PENDING') throw new AppError('Already processed', 400);

      await prisma.permission.update({
        where: { id },
        data: { status: 'REJECTED', managerNote: note ?? null, actedAt: new Date() },
      });

      const emp = await prisma.employee.findUnique({ where: { id: perm.employeeId }, include: { user: true } });
      if (emp) {
        const label = perm.type === 'HALF_DAY' ? 'Half Day' : 'Permission';
        await notificationService.create({
          userId: emp.user.id,
          type: 'LEAVE_REQUEST',
          title: `${label} Rejected`,
          message: `Your ${label.toLowerCase()} request for ${new Date(perm.date).toDateString()} was rejected`,
        });
      }

      res.json({ success: true, message: 'Rejected' });
    } catch (err) { next(err); }
  },
};
