import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AuthRequest } from '../types';
import { AppError } from '../middleware/errorHandler';
import { notificationService } from '../services/notification.service';

export const compOffController = {

  /** Employee submits a comp off request for a day they worked (e.g. Sunday) */
  async submit(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const { workDate, reason } = req.body;
      if (!workDate) throw new AppError('workDate is required', 400);

      const date = new Date(workDate);
      if (isNaN(date.getTime())) throw new AppError('Invalid workDate', 400);

      // Prevent duplicate requests for the same date
      const existing = await prisma.compOffRequest.findFirst({
        where: { employeeId: employee.id, workDate: date, status: { in: ['PENDING', 'APPROVED'] } },
      });
      if (existing) throw new AppError('A comp off request for this date already exists', 409);

      const manager = await prisma.employee.findUnique({
        where: { id: employee.managerId ?? '' },
        include: { user: true },
      });

      const request = await prisma.compOffRequest.create({
        data: {
          employeeId: employee.id,
          workDate: date,
          reason: reason ?? null,
          status: 'PENDING',
          managerId: manager?.id ?? null,
        },
      });

      if (manager) {
        await notificationService.create({
          userId: manager.user.id,
          type: 'LEAVE_REQUEST',
          title: 'Comp Off Request',
          message: `${employee.firstName} worked on ${date.toDateString()} and is requesting a comp off day`,
        });
      }

      res.status(201).json({ success: true, data: request });
    } catch (err) { next(err); }
  },

  /** Employee views their own comp off requests */
  async myRequests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const requests = await prisma.compOffRequest.findMany({
        where: { employeeId: employee.id },
        orderBy: { workDate: 'desc' },
      });

      res.json({ success: true, data: requests });
    } catch (err) { next(err); }
  },

  /** Manager views pending comp off requests from their team */
  async pending(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const requests = await prisma.compOffRequest.findMany({
        where: { managerId: manager.id, status: 'PENDING' },
        include: {
          employee: { select: { firstName: true, lastName: true, employeeCode: true } },
        },
        orderBy: { workDate: 'desc' },
      });

      res.json({ success: true, data: requests });
    } catch (err) { next(err); }
  },

  /** Manager: all comp off requests (any status) for their team. */
  async teamAll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const { status } = req.query;
      const requests = await prisma.compOffRequest.findMany({
        where: {
          managerId: manager.id,
          ...(status && status !== 'ALL' ? { status: status as string } : {}),
        },
        include: {
          employee: { select: { firstName: true, lastName: true, employeeCode: true } },
        },
        orderBy: { createdAt: 'desc' },
      });

      res.json({ success: true, data: requests });
    } catch (err) { next(err); }
  },

  /** Manager approves a comp off request → credit COMP_OFF leave balance */
  async approve(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const { id } = req.params;
      const { note } = req.body;

      const request = await prisma.compOffRequest.findUnique({ where: { id } });
      if (!request) throw new AppError('Comp off request not found', 404);
      if (request.managerId !== manager.id) throw new AppError('Not authorized', 403);
      if (request.status !== 'PENDING') throw new AppError('Request already processed', 400);

      await prisma.compOffRequest.update({
        where: { id },
        data: { status: 'APPROVED', managerNote: note ?? null, actedAt: new Date() },
      });

      // Credit 1 comp off day to the employee's leave balance
      const company = await prisma.employee.findUnique({
        where: { id: request.employeeId },
        select: { companyId: true },
      });

      const leaveType = await prisma.companyLeaveType.findFirst({
        where: { companyId: company!.companyId, type: 'COMPENSATORY', isActive: true },
      });

      if (leaveType) {
        const year = new Date(request.workDate).getFullYear();
        await prisma.leaveBalance.upsert({
          where: { employeeId_leaveTypeId_year: { employeeId: request.employeeId, leaveTypeId: leaveType.id, year } },
          update: { totalDays: { increment: 1 } },
          create: { employeeId: request.employeeId, leaveTypeId: leaveType.id, year, totalDays: 1 },
        });
      }

      // Notify employee
      const emp = await prisma.employee.findUnique({ where: { id: request.employeeId }, include: { user: true } });
      if (emp) {
        await notificationService.create({
          userId: emp.user.id,
          type: 'LEAVE_APPROVED',
          title: 'Comp Off Approved ✓',
          message: `Your comp off request for ${new Date(request.workDate).toDateString()} has been approved. 1 day credited.`,
        });
      }

      res.json({ success: true, message: 'Comp off approved — 1 day credited' });
    } catch (err) { next(err); }
  },

  /** Manager rejects a comp off request */
  async reject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const { id } = req.params;
      const { note } = req.body;

      const request = await prisma.compOffRequest.findUnique({ where: { id } });
      if (!request) throw new AppError('Comp off request not found', 404);
      if (request.managerId !== manager.id) throw new AppError('Not authorized', 403);
      if (request.status !== 'PENDING') throw new AppError('Request already processed', 400);

      await prisma.compOffRequest.update({
        where: { id },
        data: { status: 'REJECTED', managerNote: note ?? null, actedAt: new Date() },
      });

      const emp = await prisma.employee.findUnique({ where: { id: request.employeeId }, include: { user: true } });
      if (emp) {
        await notificationService.create({
          userId: emp.user.id,
          type: 'LEAVE_REQUEST',
          title: 'Comp Off Rejected',
          message: `Your comp off request for ${new Date(request.workDate).toDateString()} was rejected`,
        });
      }

      res.json({ success: true, message: 'Comp off request rejected' });
    } catch (err) { next(err); }
  },
};
