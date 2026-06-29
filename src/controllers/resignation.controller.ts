import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { notificationService } from '../services/notification.service';
import { emailService } from '../services/email.service';

const DEFAULT_EXIT_DOCS = [
  { name: 'Laptop / Desktop', description: 'Company-issued laptop or desktop computer' },
  { name: 'ID Card',          description: 'Employee identity card' },
  { name: 'Access Card',      description: 'Office access / key card' },
  { name: 'SIM Card',         description: 'Company-issued SIM card (if any)' },
  { name: 'Other Assets',     description: 'Any other company property' },
];

export const resignationController = {

  async submit(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { reason, requestedLastDate } = req.body;
      if (!reason || !requestedLastDate) throw new AppError('reason and requestedLastDate are required', 400);

      const employee = await prisma.employee.findUnique({
        where: { userId: req.user!.userId },
        include: {
          manager: { include: { user: true } },
          user: true,
          department: true,
        },
      });
      if (!employee) throw new AppError('Employee not found', 404);

      const existing = await prisma.resignationRequest.findFirst({
        where: { employeeId: employee.id, status: { in: ['PENDING', 'MANAGER_APPROVED', 'HR_APPROVED', 'BOTH_APPROVED'] } },
      });
      if (existing) throw new AppError('You already have an active resignation request', 409);

      const resignation = await prisma.resignationRequest.create({
        data: {
          employeeId: employee.id,
          reason,
          requestedLastDate: new Date(requestedLastDate),
          managerId: employee.managerId ?? undefined,
        },
        include: { employee: { include: { user: true } } },
      });

      const empName = `${employee.firstName} ${employee.lastName}`;

      // Notify manager
      if (employee.manager?.user) {
        await notificationService.create({
          userId: employee.manager.user.id,
          type: 'RESIGNATION_SUBMITTED',
          title: 'Resignation Received',
          message: `${empName} has submitted a resignation request`,
          data: { resignationId: resignation.id },
        });
        await emailService.send({
          to: employee.manager.user.email,
          subject: `Resignation Notice — ${empName}`,
          html: emailService.templates.resignationNotice({
            recipientName: `${employee.manager.firstName} ${employee.manager.lastName}`,
            empName,
            reason,
            requestedLastDate: new Date(requestedLastDate).toDateString(),
            role: 'manager',
          }),
          template: 'resignation_notice',
        }).catch(console.error);
      }

      // Notify all HR users
      const hrUsers = await prisma.user.findMany({
        where: { role: { in: ['HR', 'ADMIN'] }, employee: { companyId: employee.companyId } },
      });
      for (const hr of hrUsers) {
        await notificationService.create({
          userId: hr.id,
          type: 'RESIGNATION_SUBMITTED',
          title: 'Resignation Received',
          message: `${empName} has submitted a resignation request`,
          data: { resignationId: resignation.id },
        });
        await emailService.send({
          to: hr.email,
          subject: `Resignation Notice — ${empName}`,
          html: emailService.templates.resignationNotice({
            recipientName: 'HR Team',
            empName,
            reason,
            requestedLastDate: new Date(requestedLastDate).toDateString(),
            role: 'hr',
          }),
          template: 'resignation_notice',
        }).catch(console.error);
      }

      // Update employee status
      await prisma.employee.update({
        where: { id: employee.id },
        data: { status: 'RESIGNED' },
      });

      res.status(201).json({ success: true, data: resignation, message: 'Resignation submitted' });
    } catch (err) { next(err); }
  },

  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status, page = 1, limit = 20 } = req.query;
      const p = Number(page), l = Number(limit);
      const role = req.user!.role;

      let where: Record<string, unknown> = {};

      if (role === 'EMPLOYEE') {
        const emp = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
        if (!emp) throw new AppError('Employee not found', 404);
        where.employeeId = emp.id;
      } else if (role === 'MANAGER') {
        const mgr = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
        if (!mgr) throw new AppError('Employee not found', 404);
        where.managerId = mgr.id;
      } else {
        // HR / Admin — company-wide
        where = {
          employee: { companyId: req.user!.companyId! },
        };
      }

      if (status) where.status = status;

      const [requests, total] = await Promise.all([
        prisma.resignationRequest.findMany({
          where,
          include: {
            employee: {
              include: {
                user: { select: { email: true } },
                department: { select: { name: true } },
                designation: { select: { name: true } },
                manager: { select: { firstName: true, lastName: true } },
              },
            },
            exitClearance: true,
          },
          orderBy: { createdAt: 'desc' },
          skip: (p - 1) * l,
          take: l,
        }),
        prisma.resignationRequest.count({ where }),
      ]);

      res.json({ success: true, data: requests, meta: { total, page: p, limit: l } });
    } catch (err) { next(err); }
  },

  async getById(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const resignation = await prisma.resignationRequest.findUnique({
        where: { id: req.params.id },
        include: {
          employee: {
            include: {
              user: { select: { email: true } },
              department: true, designation: true,
              manager: { select: { firstName: true, lastName: true, user: { select: { email: true } } } },
            },
          },
          exitClearance: { include: { documents: true } },
        },
      });
      if (!resignation) throw new AppError('Resignation not found', 404);
      res.json({ success: true, data: resignation });
    } catch (err) { next(err); }
  },

  async managerApprove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { remarks, lastDate } = req.body;
      if (!lastDate) throw new AppError('lastDate is required', 400);

      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const resignation = await prisma.resignationRequest.findUnique({
        where: { id: req.params.id },
        include: { employee: { include: { user: true } } },
      });
      if (!resignation) throw new AppError('Resignation not found', 404);
      if (resignation.managerId !== manager.id) throw new AppError('Not your subordinate', 403);
      if (resignation.managerStatus !== 'PENDING') throw new AppError('Already actioned', 400);

      const newStatus = resignation.hrStatus === 'APPROVED' ? 'BOTH_APPROVED' : 'MANAGER_APPROVED';
      const finalLastDate =
        resignation.hrStatus === 'APPROVED' && resignation.hrLastDate
          ? new Date(Math.max(new Date(lastDate).getTime(), resignation.hrLastDate.getTime()))
          : undefined;

      const updated = await prisma.resignationRequest.update({
        where: { id: resignation.id },
        data: {
          managerStatus: 'APPROVED',
          managerApprovedById: manager.id,
          managerApprovedAt: new Date(),
          managerLastDate: new Date(lastDate),
          managerRemarks: remarks,
          status: newStatus as any,
          finalLastDate,
        },
      });

      await notificationService.create({
        userId: resignation.employee.userId,
        type: 'RESIGNATION_APPROVED',
        title: 'Resignation Acknowledged by Manager',
        message: `Your manager has approved your resignation. Last working date: ${new Date(lastDate).toDateString()}`,
        data: { resignationId: resignation.id },
      });

      res.json({ success: true, data: updated, message: 'Resignation approved by manager' });
    } catch (err) { next(err); }
  },

  async managerReject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { remarks } = req.body;
      if (!remarks) throw new AppError('Remarks/reason are required', 400);

      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const resignation = await prisma.resignationRequest.findUnique({
        where: { id: req.params.id },
        include: { employee: { include: { user: true } } },
      });
      if (!resignation) throw new AppError('Resignation not found', 404);
      if (resignation.managerId !== manager.id) throw new AppError('Not your subordinate', 403);

      const updated = await prisma.resignationRequest.update({
        where: { id: resignation.id },
        data: {
          managerStatus: 'REJECTED',
          managerApprovedById: manager.id,
          managerApprovedAt: new Date(),
          managerRemarks: remarks,
          status: 'REJECTED',
        },
      });

      await prisma.employee.update({
        where: { id: resignation.employeeId },
        data: { status: 'ACTIVE' },
      });

      await notificationService.create({
        userId: resignation.employee.userId,
        type: 'RESIGNATION_SUBMITTED',
        title: 'Resignation Rejected by Manager',
        message: `Your resignation has been rejected by your manager. Reason: ${remarks}`,
        data: { resignationId: resignation.id },
      });

      res.json({ success: true, data: updated, message: 'Resignation rejected' });
    } catch (err) { next(err); }
  },

  async hrApprove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { remarks, lastDate } = req.body;
      if (!lastDate) throw new AppError('lastDate is required', 400);

      const resignation = await prisma.resignationRequest.findUnique({
        where: { id: req.params.id },
        include: { employee: { include: { user: true } } },
      });
      if (!resignation) throw new AppError('Resignation not found', 404);
      if (resignation.hrStatus !== 'PENDING') throw new AppError('Already actioned by HR', 400);

      const newStatus = resignation.managerStatus === 'APPROVED' ? 'BOTH_APPROVED' : 'HR_APPROVED';
      const finalLastDate =
        resignation.managerStatus === 'APPROVED' && resignation.managerLastDate
          ? new Date(Math.max(new Date(lastDate).getTime(), resignation.managerLastDate.getTime()))
          : undefined;

      const updated = await prisma.resignationRequest.update({
        where: { id: resignation.id },
        data: {
          hrStatus: 'APPROVED',
          hrApprovedById: req.user!.userId,
          hrApprovedAt: new Date(),
          hrLastDate: new Date(lastDate),
          hrRemarks: remarks,
          status: newStatus as any,
          finalLastDate,
        },
      });

      await notificationService.create({
        userId: resignation.employee.userId,
        type: 'RESIGNATION_APPROVED',
        title: 'Resignation Approved by HR',
        message: `HR has approved your resignation. Last working date: ${new Date(lastDate).toDateString()}`,
        data: { resignationId: resignation.id },
      });

      res.json({ success: true, data: updated, message: 'Resignation approved by HR' });
    } catch (err) { next(err); }
  },

  async hrReject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { remarks } = req.body;
      if (!remarks) throw new AppError('Remarks/reason are required', 400);

      const resignation = await prisma.resignationRequest.findUnique({
        where: { id: req.params.id },
        include: { employee: { include: { user: true } } },
      });
      if (!resignation) throw new AppError('Resignation not found', 404);

      const updated = await prisma.resignationRequest.update({
        where: { id: resignation.id },
        data: {
          hrStatus: 'REJECTED',
          hrApprovedById: req.user!.userId,
          hrApprovedAt: new Date(),
          hrRemarks: remarks,
          status: 'REJECTED',
        },
      });

      await prisma.employee.update({
        where: { id: resignation.employeeId },
        data: { status: 'ACTIVE' },
      });

      await notificationService.create({
        userId: resignation.employee.userId,
        type: 'RESIGNATION_SUBMITTED',
        title: 'Resignation Rejected by HR',
        message: `Your resignation has been rejected by HR. Reason: ${remarks}`,
        data: { resignationId: resignation.id },
      });

      res.json({ success: true, data: updated, message: 'Resignation rejected by HR' });
    } catch (err) { next(err); }
  },

  // ─── EXIT CLEARANCE ──────────────────────────────────────────────────────────

  async initiateExitClearance(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { additionalDocs } = req.body; // optional extra items

      const resignation = await prisma.resignationRequest.findUnique({
        where: { id: req.params.id },
        include: { exitClearance: true, employee: { include: { user: true } } },
      });
      if (!resignation) throw new AppError('Resignation not found', 404);
      if (!['BOTH_APPROVED', 'MANAGER_APPROVED', 'HR_APPROVED'].includes(resignation.status)) {
        throw new AppError('Resignation must be approved before initiating exit clearance', 400);
      }
      if (resignation.exitClearance) throw new AppError('Exit clearance already initiated', 409);

      const clearance = await prisma.exitClearance.create({
        data: {
          resignationId: resignation.id,
          initiatedById: req.user!.userId,
          documents: {
            createMany: {
              data: [
                ...DEFAULT_EXIT_DOCS,
                ...(additionalDocs || []),
              ],
            },
          },
        },
        include: { documents: true },
      });

      // Notify manager
      if (resignation.managerId) {
        const mgr = await prisma.employee.findUnique({
          where: { id: resignation.managerId },
          include: { user: true },
        });
        if (mgr?.user) {
          await notificationService.create({
            userId: mgr.user.id,
            type: 'EXIT_CLEARANCE_SUBMITTED',
            title: 'Final Exit Clearance',
            message: `Final day exit clearance for ${resignation.employee.firstName} ${resignation.employee.lastName} needs your approval`,
            data: { resignationId: resignation.id, clearanceId: clearance.id },
          });
        }
      }

      // Notify HR
      const hrUsers = await prisma.user.findMany({
        where: { role: { in: ['HR', 'ADMIN'] }, employee: { companyId: resignation.employee.companyId } },
      });
      for (const hr of hrUsers) {
        await notificationService.create({
          userId: hr.id,
          type: 'EXIT_CLEARANCE_SUBMITTED',
          title: 'Final Exit Clearance',
          message: `Final day exit clearance for ${resignation.employee.firstName} ${resignation.employee.lastName} needs your approval`,
          data: { resignationId: resignation.id, clearanceId: clearance.id },
        });
      }

      res.status(201).json({ success: true, data: clearance, message: 'Exit clearance initiated' });
    } catch (err) { next(err); }
  },

  async markDocumentReceived(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { docId } = req.params;
      const { receivedBy } = req.body;

      const doc = await prisma.exitDocument.update({
        where: { id: docId },
        data: { isReceived: true, receivedAt: new Date(), receivedBy },
      });
      res.json({ success: true, data: doc });
    } catch (err) { next(err); }
  },

  async managerClearExit(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { remarks, newLastDate } = req.body;
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const resignation = await prisma.resignationRequest.findUnique({
        where: { id: req.params.id },
        include: {
          exitClearance: true,
          employee: { include: { user: true } },
        },
      });
      if (!resignation?.exitClearance) throw new AppError('Exit clearance not found', 404);
      if (resignation.managerId !== manager.id) throw new AppError('Forbidden', 403);
      if (resignation.exitClearance.managerStatus !== 'PENDING') throw new AppError('Already actioned', 400);

      const newStatus =
        resignation.exitClearance.hrStatus === 'APPROVED' ? 'COMPLETED' : 'MANAGER_CLEARED';
      const finalLastDate =
        resignation.exitClearance.hrStatus === 'APPROVED' && resignation.exitClearance.hrNewLastDate
          ? resignation.exitClearance.hrNewLastDate
          : newLastDate ? new Date(newLastDate) : resignation.finalLastDate;

      const updated = await prisma.exitClearance.update({
        where: { id: resignation.exitClearance.id },
        data: {
          managerStatus: 'APPROVED',
          managerApprovedById: manager.id,
          managerApprovedAt: new Date(),
          managerRemarks: remarks,
          managerNewLastDate: newLastDate ? new Date(newLastDate) : undefined,
          status: newStatus as any,
          finalLastDate: newStatus === 'COMPLETED' ? finalLastDate : undefined,
        },
        include: { documents: true },
      });

      if (newStatus === 'COMPLETED') {
        await _completeExit(resignation.id, resignation.employeeId, finalLastDate as Date);
      }

      await notificationService.create({
        userId: resignation.employee.userId,
        type: 'EXIT_CLEARANCE_COMPLETED',
        title: newStatus === 'COMPLETED' ? 'Exit Clearance Complete' : 'Exit Cleared by Manager',
        message: newStatus === 'COMPLETED'
          ? `Your exit clearance is complete. Last working date: ${(finalLastDate as Date)?.toDateString()}`
          : 'Your exit clearance has been approved by your manager',
        data: { resignationId: resignation.id },
      });

      res.json({ success: true, data: updated, message: 'Manager exit clearance done' });
    } catch (err) { next(err); }
  },

  async managerRejectExit(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { remarks, newLastDate } = req.body;
      if (!remarks) throw new AppError('Remarks are required', 400);

      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const resignation = await prisma.resignationRequest.findUnique({
        where: { id: req.params.id },
        include: {
          exitClearance: true,
          employee: { include: { user: true } },
        },
      });
      if (!resignation?.exitClearance) throw new AppError('Exit clearance not found', 404);
      if (resignation.managerId !== manager.id) throw new AppError('Forbidden', 403);

      const updated = await prisma.exitClearance.update({
        where: { id: resignation.exitClearance.id },
        data: {
          managerStatus: 'REJECTED',
          managerApprovedById: manager.id,
          managerApprovedAt: new Date(),
          managerRemarks: remarks,
          managerNewLastDate: newLastDate ? new Date(newLastDate) : undefined,
          status: 'REJECTED',
        },
      });

      await notificationService.create({
        userId: resignation.employee.userId,
        type: 'EXIT_CLEARANCE_SUBMITTED',
        title: 'Exit Clearance Rejected by Manager',
        message: `Exit clearance rejected. Reason: ${remarks}${newLastDate ? '. New proposed last date: ' + new Date(newLastDate).toDateString() : ''}`,
        data: { resignationId: resignation.id },
      });

      res.json({ success: true, data: updated, message: 'Exit clearance rejected by manager' });
    } catch (err) { next(err); }
  },

  async hrClearExit(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { remarks, newLastDate } = req.body;

      const resignation = await prisma.resignationRequest.findUnique({
        where: { id: req.params.id },
        include: {
          exitClearance: true,
          employee: { include: { user: true } },
        },
      });
      if (!resignation?.exitClearance) throw new AppError('Exit clearance not found', 404);
      if (resignation.exitClearance.hrStatus !== 'PENDING') throw new AppError('Already actioned by HR', 400);

      const newStatus =
        resignation.exitClearance.managerStatus === 'APPROVED' ? 'COMPLETED' : 'HR_CLEARED';
      const finalLastDate =
        resignation.exitClearance.managerStatus === 'APPROVED' && resignation.exitClearance.managerNewLastDate
          ? new Date(Math.max(
              (newLastDate ? new Date(newLastDate) : new Date(0)).getTime(),
              resignation.exitClearance.managerNewLastDate.getTime(),
            ))
          : newLastDate ? new Date(newLastDate) : resignation.finalLastDate;

      const updated = await prisma.exitClearance.update({
        where: { id: resignation.exitClearance.id },
        data: {
          hrStatus: 'APPROVED',
          hrApprovedById: req.user!.userId,
          hrApprovedAt: new Date(),
          hrRemarks: remarks,
          hrNewLastDate: newLastDate ? new Date(newLastDate) : undefined,
          status: newStatus as any,
          finalLastDate: newStatus === 'COMPLETED' ? finalLastDate : undefined,
        },
        include: { documents: true },
      });

      if (newStatus === 'COMPLETED') {
        await _completeExit(resignation.id, resignation.employeeId, finalLastDate as Date);
      }

      await notificationService.create({
        userId: resignation.employee.userId,
        type: 'EXIT_CLEARANCE_COMPLETED',
        title: newStatus === 'COMPLETED' ? 'Exit Clearance Complete' : 'Exit Cleared by HR',
        message: newStatus === 'COMPLETED'
          ? `Your exit clearance is complete. Last working date: ${(finalLastDate as Date)?.toDateString()}`
          : 'Your exit clearance has been approved by HR',
        data: { resignationId: resignation.id },
      });

      res.json({ success: true, data: updated, message: 'HR exit clearance done' });
    } catch (err) { next(err); }
  },

  async hrRejectExit(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { remarks, newLastDate } = req.body;
      if (!remarks) throw new AppError('Remarks are required', 400);

      const resignation = await prisma.resignationRequest.findUnique({
        where: { id: req.params.id },
        include: {
          exitClearance: true,
          employee: { include: { user: true } },
        },
      });
      if (!resignation?.exitClearance) throw new AppError('Exit clearance not found', 404);

      const updated = await prisma.exitClearance.update({
        where: { id: resignation.exitClearance.id },
        data: {
          hrStatus: 'REJECTED',
          hrApprovedById: req.user!.userId,
          hrApprovedAt: new Date(),
          hrRemarks: remarks,
          hrNewLastDate: newLastDate ? new Date(newLastDate) : undefined,
          status: 'REJECTED',
        },
      });

      await notificationService.create({
        userId: resignation.employee.userId,
        type: 'EXIT_CLEARANCE_SUBMITTED',
        title: 'Exit Clearance Rejected by HR',
        message: `Exit clearance rejected by HR. Reason: ${remarks}${newLastDate ? '. New proposed last date: ' + new Date(newLastDate).toDateString() : ''}`,
        data: { resignationId: resignation.id },
      });

      res.json({ success: true, data: updated, message: 'Exit clearance rejected by HR' });
    } catch (err) { next(err); }
  },
};

async function _completeExit(resignationId: string, employeeId: string, lastDate: Date) {
  await prisma.employee.update({
    where: { id: employeeId },
    data: {
      status: 'RESIGNED',
      exitDate: lastDate,
    },
  });
}
