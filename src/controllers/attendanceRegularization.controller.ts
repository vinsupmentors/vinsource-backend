import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { notificationService } from '../services/notification.service';

function dayRange(d: Date) {
  const start = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const end = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999));
  return { start, end };
}

export const attendanceRegularizationController = {
  /** Employee raises a query about a wrong/missing attendance record. */
  async apply(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({
        where: { userId: req.user!.userId },
        include: { manager: { include: { user: true } } },
      });
      if (!employee) throw new AppError('Employee not found', 404);

      const { date, requestedCheckIn, requestedCheckOut, requestedStatus, reason } = req.body;
      if (!date || !reason) throw new AppError('date and reason are required', 400);

      const request = await prisma.attendanceRegularization.create({
        data: {
          employeeId: employee.id,
          date: new Date(date),
          requestedCheckIn: requestedCheckIn ?? null,
          requestedCheckOut: requestedCheckOut ?? null,
          requestedStatus: requestedStatus ?? 'PRESENT',
          reason,
          status: 'PENDING',
          managerId: employee.managerId ?? null,
        },
      });

      if (employee.manager?.user) {
        await notificationService.create({
          userId: employee.manager.user.id,
          type: 'LEAVE_REQUEST',
          title: 'Attendance Regularization Request',
          message: `${employee.firstName} ${employee.lastName} raised an attendance query for ${new Date(date).toDateString()}`,
        });
      }

      res.status(201).json({ success: true, data: request });
    } catch (err) { next(err); }
  },

  /** Employee's own request history. */
  async myRequests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const requests = await prisma.attendanceRegularization.findMany({
        where: { employeeId: employee.id },
        orderBy: { date: 'desc' },
      });

      res.json({ success: true, data: requests });
    } catch (err) { next(err); }
  },

  /** Manager's inbox of requests awaiting decision. */
  async pending(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const requests = await prisma.attendanceRegularization.findMany({
        where: { managerId: manager.id, status: 'PENDING' },
        include: {
          employee: { select: { firstName: true, lastName: true, employeeCode: true } },
        },
        orderBy: { date: 'asc' },
      });

      res.json({ success: true, data: requests });
    } catch (err) { next(err); }
  },

  /** Manager approves — only now does the underlying Attendance record get corrected. */
  async approve(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const { id } = req.params;
      const { note } = req.body;

      const request = await prisma.attendanceRegularization.findUnique({ where: { id } });
      if (!request) throw new AppError('Request not found', 404);
      if (request.managerId !== manager.id) throw new AppError('Not authorized', 403);
      if (request.status !== 'PENDING') throw new AppError('Already processed', 400);

      const { start, end } = dayRange(new Date(request.date));
      const existing = await prisma.attendance.findFirst({
        where: { employeeId: request.employeeId, date: { gte: start, lte: end } },
      });

      const toDateTime = (hhmm: string | null, base: Date) => {
        if (!hhmm) return undefined;
        const [h, m] = hhmm.split(':').map(Number);
        const dt = new Date(base);
        dt.setUTCHours(h, m, 0, 0);
        return dt;
      };

      if (existing) {
        await prisma.attendance.update({
          where: { id: existing.id },
          data: {
            checkIn: toDateTime(request.requestedCheckIn, start) ?? existing.checkIn,
            checkOut: toDateTime(request.requestedCheckOut, start) ?? existing.checkOut,
            status: request.requestedStatus as any,
            isRegularized: true,
            regularizeNote: request.reason,
            approvedBy: manager.id,
          },
        });
      } else {
        await prisma.attendance.create({
          data: {
            employeeId: request.employeeId,
            date: start,
            checkIn: toDateTime(request.requestedCheckIn, start),
            checkOut: toDateTime(request.requestedCheckOut, start),
            status: request.requestedStatus as any,
            isRegularized: true,
            regularizeNote: request.reason,
            approvedBy: manager.id,
          },
        });
      }

      await prisma.attendanceRegularization.update({
        where: { id },
        data: { status: 'APPROVED', managerNote: note ?? null, actedAt: new Date() },
      });

      const emp = await prisma.employee.findUnique({ where: { id: request.employeeId }, include: { user: true } });
      if (emp) {
        await notificationService.create({
          userId: emp.user.id,
          type: 'LEAVE_APPROVED',
          title: 'Attendance Request Approved ✓',
          message: `Your attendance query for ${new Date(request.date).toDateString()} has been approved and corrected`,
        });
      }

      res.json({ success: true, message: 'Approved' });
    } catch (err) { next(err); }
  },

  /** Manager: all requests (PENDING + APPROVED + REJECTED) for their team. */
  async teamAll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const isSuperAdmin = req.user?.role === 'SUPER_ADMIN';
      const { status } = req.query;
      const where: Record<string, unknown> = {};

      if (!isSuperAdmin) {
        const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
        if (!manager) throw new AppError('Employee not found', 404);
        where.managerId = manager.id;
      }
      if (status && status !== 'ALL') where.status = status as string;

      const requests = await prisma.attendanceRegularization.findMany({
        where,
        include: {
          employee: { select: { firstName: true, lastName: true, employeeCode: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      res.json({ success: true, data: requests });
    } catch (err) { next(err); }
  },

  async reject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const { id } = req.params;
      const { note } = req.body;

      const request = await prisma.attendanceRegularization.findUnique({ where: { id } });
      if (!request) throw new AppError('Request not found', 404);
      if (request.managerId !== manager.id) throw new AppError('Not authorized', 403);
      if (request.status !== 'PENDING') throw new AppError('Already processed', 400);

      await prisma.attendanceRegularization.update({
        where: { id },
        data: { status: 'REJECTED', managerNote: note ?? null, actedAt: new Date() },
      });

      const emp = await prisma.employee.findUnique({ where: { id: request.employeeId }, include: { user: true } });
      if (emp) {
        await notificationService.create({
          userId: emp.user.id,
          type: 'LEAVE_REQUEST',
          title: 'Attendance Request Rejected',
          message: `Your attendance query for ${new Date(request.date).toDateString()}  was rejected`,
        });
      }

      res.json({ success: true, message: 'Rejected' });
    } catch (err) { next(err); }
  },
};
