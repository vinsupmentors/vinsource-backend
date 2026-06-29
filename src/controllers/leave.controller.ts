import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { notificationService } from '../services/notification.service';
import { emailService } from '../services/email.service';
import { paginate, formatPagination } from '../utils/helpers';

export const leaveController = {
  // Company-wide leave oversight for SUPER_ADMIN — every employee's leave
  // requests with status and the deciding manager's name. Not a self-service
  // apply view; SUPER_ADMIN doesn't submit leave, they audit it.
  async all(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId!;
      const { status } = req.query;
      const where: Record<string, unknown> = { employee: { companyId } };
      if (status) where.status = status;

      const requests = await prisma.leaveRequest.findMany({
        where,
        include: {
          employee: { select: { firstName: true, lastName: true, employeeCode: true } },
          leaveType: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      const managerIds = [...new Set(requests.map((r) => r.managerId).filter(Boolean))] as string[];
      const managers = managerIds.length
        ? await prisma.employee.findMany({
            where: { id: { in: managerIds } },
            select: { id: true, firstName: true, lastName: true },
          })
        : [];
      const managerMap = new Map(managers.map((m) => [m.id, `${m.firstName} ${m.lastName}`]));

      const data = requests.map((r) => ({
        ...r,
        managerName: r.managerId ? managerMap.get(r.managerId) ?? null : null,
      }));

      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async types(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const types = await prisma.companyLeaveType.findMany({
        where: { companyId: req.user!.companyId!, isActive: true },
        orderBy: { name: 'asc' },
      });
      res.json({ success: true, data: types });
    } catch (err) { next(err); }
  },

  async apply(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({
        where: { userId: req.user!.userId },
        include: { manager: { include: { user: true } } },
      });
      if (!employee) throw new AppError('Employee not found', 404);

      const { leaveTypeId, startDate, endDate, reason, isHalfDay, halfDaySession } = req.body;

      const start = new Date(startDate);
      const end = new Date(endDate);
      const days = Math.ceil((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1;

      // Check if leave type is LOP (unpaid) — no balance check needed
      const leaveType = await prisma.companyLeaveType.findUnique({ where: { id: leaveTypeId } });
      if (!leaveType) throw new AppError('Invalid leave type', 400);

      const isLOP = !leaveType.isPaid || leaveType.type === 'LOSS_OF_PAY' || leaveType.type === 'UNPAID';
      const isCompOff = leaveType.type === 'COMPENSATORY';

      if (!isLOP && !isCompOff) {
        // Balance check only for paid leaves
        const balance = await prisma.leaveBalance.findUnique({
          where: {
            employeeId_leaveTypeId_year: {
              employeeId: employee.id,
              leaveTypeId,
              year: start.getFullYear(),
            },
          },
        });

        if (!balance || balance.totalDays - balance.usedDays - balance.pendingDays < days) {
          throw new AppError('Insufficient leave balance', 400);
        }
      }

      const leaveRequest = await prisma.leaveRequest.create({
        data: {
          employeeId: employee.id,
          leaveTypeId,
          startDate: start,
          endDate: end,
          days,
          reason,
          managerId: employee.managerId,
          isHalfDay: isHalfDay || false,
          halfDaySession,
        },
        include: { leaveType: true },
      });

      // Update pending balance (only for paid leaves that have a balance record; not for comp off)
      if (!isLOP && !isCompOff) {
        const balance = await prisma.leaveBalance.findUnique({
          where: {
            employeeId_leaveTypeId_year: {
              employeeId: employee.id, leaveTypeId, year: start.getFullYear(),
            },
          },
        });
        if (balance) {
          await prisma.leaveBalance.update({
            where: { id: balance.id },
            data: { pendingDays: { increment: days } },
          });
        }
      }

      // Notify manager
      if (employee.managerId && employee.manager?.user) {
        await notificationService.create({
          userId: employee.manager.user.id,
          type: 'LEAVE_REQUEST',
          title: 'New Leave Request',
          message: `${employee.firstName} ${employee.lastName} has applied for ${days} day(s) leave`,
          data: { leaveRequestId: leaveRequest.id },
        });

        await emailService.send({
          to: employee.manager.user.email,
          subject: `Leave Request from ${employee.firstName} ${employee.lastName}`,
          html: emailService.templates.leaveApplied({
            employeeName: `${employee.firstName} ${employee.lastName}`,
            leaveType: leaveRequest.leaveType.name,
            startDate: start.toDateString(),
            endDate: end.toDateString(),
            days,
          }),
          template: 'leave_applied',
        }).catch(console.error);
      }

      res.status(201).json({ success: true, data: leaveRequest, message: 'Leave applied successfully' });
    } catch (err) { next(err); }
  },

  async myRequests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const { page = 1, limit = 20, status } = req.query;
      const p = Number(page), l = Number(limit);
      const where: Record<string, unknown> = { employeeId: employee.id };
      if (status) where.status = status;

      const [requests, total] = await Promise.all([
        prisma.leaveRequest.findMany({
          where,
          include: { leaveType: true },
          orderBy: { createdAt: 'desc' },
          ...paginate(p, l),
        }),
        prisma.leaveRequest.count({ where }),
      ]);

      res.json({ success: true, data: requests, meta: formatPagination(total, p, l) });
    } catch (err) { next(err); }
  },

  async pendingForManager(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const requests = await prisma.leaveRequest.findMany({
        where: { managerId: manager.id, status: 'PENDING' },
        include: {
          employee: { select: { firstName: true, lastName: true, employeeCode: true, profilePhoto: true } },
          leaveType: true,
        },
        orderBy: { createdAt: 'asc' },
      });

      res.json({ success: true, data: requests });
    } catch (err) { next(err); }
  },

  async approve(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { note } = req.body;
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const request = await prisma.leaveRequest.findUnique({
        where: { id: req.params.id },
        include: {
          employee: { include: { user: true } },
          leaveType: true,
        },
      });

      if (!request) throw new AppError('Leave request not found', 404);
      if (request.managerId !== manager.id) throw new AppError('Not authorized', 403);

      const updated = await prisma.leaveRequest.update({
        where: { id: request.id },
        data: {
          status: 'APPROVED',
          managerAction: 'APPROVED',
          managerNote: note,
          managerActedAt: new Date(),
        },
      });

      // Update leave balance (only for paid leaves)
      const leaveTypeForApprove = await prisma.companyLeaveType.findUnique({ where: { id: request.leaveTypeId } });
      const isLopApprove = leaveTypeForApprove && (!leaveTypeForApprove.isPaid || leaveTypeForApprove.type === 'LOSS_OF_PAY' || leaveTypeForApprove.type === 'UNPAID');
      if (!isLopApprove) {
        await prisma.leaveBalance.updateMany({
          where: {
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            year: request.startDate.getFullYear(),
          },
          data: {
            pendingDays: { decrement: request.days },
            usedDays: { increment: request.days },
          },
        });
      }

      // Notify employee
      await notificationService.create({
        userId: request.employee.userId,
        type: 'LEAVE_APPROVED',
        title: 'Leave Approved ✓',
        message: `Your ${request.leaveType.name} request has been approved`,
      });

      await emailService.send({
        to: request.employee.user.email,
        subject: 'Leave Approved',
        html: emailService.templates.leaveApproved({
          employeeName: `${request.employee.firstName} ${request.employee.lastName}`,
          leaveType: request.leaveType.name,
          startDate: request.startDate.toDateString(),
          endDate: request.endDate.toDateString(),
        }),
        template: 'leave_approved',
      }).catch(console.error);

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  async reject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { note } = req.body;
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const request = await prisma.leaveRequest.findUnique({
        where: { id: req.params.id },
        include: { employee: { include: { user: true } }, leaveType: true },
      });

      if (!request) throw new AppError('Leave request not found', 404);

      const updated = await prisma.leaveRequest.update({
        where: { id: request.id },
        data: {
          status: 'REJECTED',
          managerAction: 'REJECTED',
          managerNote: note,
          managerActedAt: new Date(),
        },
      });

      // Only decrement balance for paid leaves
      const leaveTypeForReject = await prisma.companyLeaveType.findUnique({ where: { id: request.leaveTypeId } });
      const isLopReject = leaveTypeForReject && (!leaveTypeForReject.isPaid || leaveTypeForReject.type === 'LOSS_OF_PAY' || leaveTypeForReject.type === 'UNPAID');
      if (!isLopReject) {
        await prisma.leaveBalance.updateMany({
          where: {
            employeeId: request.employeeId,
            leaveTypeId: request.leaveTypeId,
            year: request.startDate.getFullYear(),
          },
          data: { pendingDays: { decrement: request.days } },
        });
      }

      await notificationService.create({
        userId: request.employee.userId,
        type: 'LEAVE_REJECTED',
        title: 'Leave Rejected',
        message: `Your ${request.leaveType.name} request has been rejected${note ? ': ' + note : ''}`,
      });

      await emailService.send({
        to: request.employee.user.email,
        subject: 'Leave Rejected',
        html: emailService.templates.leaveRejected({
          employeeName: `${request.employee.firstName} ${request.employee.lastName}`,
          leaveType: request.leaveType.name,
          reason: note,
        }),
        template: 'leave_rejected',
      }).catch(console.error);

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  async accrueMonthly(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId!;
      const year = new Date().getFullYear();

      // Find CL leave type for this company
      const clType = await prisma.companyLeaveType.findFirst({
        where: { companyId, type: 'CASUAL', isActive: true },
      });
      if (!clType) throw new AppError('No active CL leave type found', 404);

      // Promote employees who have completed 3 months probation
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);
      await prisma.employee.updateMany({
        where: {
          companyId,
          status: 'ON_PROBATION',
          joiningDate: { lte: threeMonthsAgo },
        },
        data: { status: 'ACTIVE' },
      });

      // Accrue 1 CL for all active employees (not ON_PROBATION)
      const activeEmployees = await prisma.employee.findMany({
        where: { companyId, status: 'ACTIVE' },
        select: { id: true },
      });

      let accrued = 0;
      for (const emp of activeEmployees) {
        const existing = await prisma.leaveBalance.findUnique({
          where: {
            employeeId_leaveTypeId_year: { employeeId: emp.id, leaveTypeId: clType.id, year },
          },
        });
        if (existing) {
          await prisma.leaveBalance.update({
            where: { id: existing.id },
            data: { totalDays: { increment: 1 } },
          });
        } else {
          await prisma.leaveBalance.create({
            data: { employeeId: emp.id, leaveTypeId: clType.id, year, totalDays: 1, usedDays: 0, pendingDays: 0 },
          });
        }
        accrued++;
      }

      res.json({ success: true, message: `Accrued 1 CL for ${accrued} employees` });
    } catch (err) { next(err); }
  },

  async myBalances(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const year = Number(req.query.year) || new Date().getFullYear();

      const balances = await prisma.leaveBalance.findMany({
        where: { employeeId: employee.id, year },
        include: { leaveType: true },
      });

      res.json({ success: true, data: balances });
    } catch (err) { next(err); }
  },

  async calendar(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { month, year } = req.query;
      const m = Number(month) || new Date().getMonth() + 1;
      const y = Number(year) || new Date().getFullYear();

      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const leaves = await prisma.leaveRequest.findMany({
        where: {
          employeeId: employee.id,
          status: { in: ['APPROVED', 'PENDING'] },
          startDate: { lte: new Date(y, m, 0) },
          endDate: { gte: new Date(y, m - 1, 1) },
        },
        include: { leaveType: true },
      });

      res.json({ success: true, data: leaves });
    } catch (err) { next(err); }
  },
};
