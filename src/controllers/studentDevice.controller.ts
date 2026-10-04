import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { invalidateStudentDeviceCache } from '../middleware/auth';

const requestInclude = {
  user: {
    select: {
      id: true, email: true, boundDeviceLabel: true, boundDeviceAt: true,
      student: { select: { id: true, studentCode: true, firstName: true, lastName: true, phone: true } },
    },
  },
} as const;

/**
 * Admin side of the student single-device lock. A student's account is bound
 * to one device (User.boundDeviceId); a login from any other device is
 * refused and lands here as a PENDING request. Approving re-binds the
 * account to the new device and signs the old one out; rejecting leaves
 * the account exactly as it was.
 */
export const studentDeviceController = {
  async list(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const [pending, history] = await Promise.all([
        prisma.studentDeviceChangeRequest.findMany({
          where: { status: 'PENDING' },
          orderBy: { requestedAt: 'desc' },
          include: requestInclude,
        }),
        prisma.studentDeviceChangeRequest.findMany({
          where: { status: { in: ['APPROVED', 'REJECTED'] } },
          orderBy: { reviewedAt: 'desc' },
          take: 30,
          include: requestInclude,
        }),
      ]);
      res.json({ success: true, data: { pending, history } });
    } catch (err) { next(err); }
  },

  async approve(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const request = await prisma.studentDeviceChangeRequest.findUnique({ where: { id: req.params.id } });
      if (!request) throw new AppError('Request not found.', 404);
      if (request.status !== 'PENDING') throw new AppError(`This request was already ${request.status.toLowerCase()}.`, 400);

      await prisma.$transaction([
        prisma.user.update({
          where: { id: request.userId },
          data: { boundDeviceId: request.newDeviceId, boundDeviceLabel: request.newDeviceLabel, boundDeviceAt: new Date() },
        }),
        prisma.studentDeviceChangeRequest.update({
          where: { id: request.id },
          data: { status: 'APPROVED', reviewedById: req.user!.userId, reviewedAt: new Date(), reviewNote: req.body?.note || undefined },
        }),
        // Any other open requests for this student are now moot — the
        // account has a single registered device again.
        prisma.studentDeviceChangeRequest.updateMany({
          where: { userId: request.userId, status: 'PENDING', id: { not: request.id } },
          data: { status: 'REJECTED', reviewedById: req.user!.userId, reviewedAt: new Date(), reviewNote: 'Superseded by an approved device change.' },
        }),
        // Sign the old device out everywhere (its tokens also stop working
        // immediately via the device check in middleware/auth.ts).
        prisma.userSession.deleteMany({ where: { userId: request.userId } }),
      ]);
      invalidateStudentDeviceCache(request.userId);

      await prisma.auditLog.create({
        data: { userId: req.user!.userId, action: 'EDIT', module: 'PRODUCTION_TRAINING', entityId: request.userId, entityType: 'StudentDevice', newData: { approvedRequestId: request.id } },
      }).catch(() => {});

      res.json({ success: true, message: 'Device change approved. The student can now sign in on the new device.' });
    } catch (err) { next(err); }
  },

  async reject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const request = await prisma.studentDeviceChangeRequest.findUnique({ where: { id: req.params.id } });
      if (!request) throw new AppError('Request not found.', 404);
      if (request.status !== 'PENDING') throw new AppError(`This request was already ${request.status.toLowerCase()}.`, 400);

      await prisma.studentDeviceChangeRequest.update({
        where: { id: request.id },
        data: { status: 'REJECTED', reviewedById: req.user!.userId, reviewedAt: new Date(), reviewNote: req.body?.note || undefined },
      });
      res.json({ success: true, message: 'Request rejected.' });
    } catch (err) { next(err); }
  },

  /**
   * Admin-initiated reset (lost/replaced device, no login attempt to approve):
   * clears the binding so the student's NEXT login — from whichever device —
   * becomes the registered one, and signs out whatever is active now.
   */
  async reset(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const student = await prisma.student.findUnique({ where: { id: req.params.studentId }, select: { userId: true } });
      if (!student?.userId) throw new AppError('Student login not found.', 404);

      await prisma.$transaction([
        prisma.user.update({ where: { id: student.userId }, data: { boundDeviceId: null, boundDeviceLabel: null, boundDeviceAt: null } }),
        prisma.userSession.deleteMany({ where: { userId: student.userId } }),
        prisma.studentDeviceChangeRequest.updateMany({
          where: { userId: student.userId, status: 'PENDING' },
          data: { status: 'REJECTED', reviewedById: req.user!.userId, reviewedAt: new Date(), reviewNote: 'Device registration was reset by an admin.' },
        }),
      ]);
      invalidateStudentDeviceCache(student.userId);
      res.json({ success: true, message: "Device registration cleared. The student's next sign-in will register that device." });
    } catch (err) { next(err); }
  },
};
