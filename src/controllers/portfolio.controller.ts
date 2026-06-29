import { Response, NextFunction, Request } from 'express';
import crypto from 'crypto';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

const studentSelect = {
  id: true, firstName: true, lastName: true, studentCode: true, track: true, photo: true, email: true, phone: true,
};

/** Short, URL-safe, unique-enough slug for the public portfolio link (e.g. `a1b2c3d4e5f6`). */
function generateSlug(): string {
  return crypto.randomBytes(8).toString('hex');
}

/**
 * Production Manager surface: review student portfolio submissions.
 * Approving generates a public slug (the QR code / public link target);
 * the QR image itself is rendered client-side from that URL.
 */
export const portfolioController = {
  async pending(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const portfolios = await prisma.studentPortfolio.findMany({
        where: { status: 'PENDING' },
        include: { student: { select: studentSelect } },
        orderBy: { submittedAt: 'asc' },
      });
      res.json({ success: true, data: portfolios });
    } catch (err) { next(err); }
  },

  /** All portfolios (any status) — for a full history view alongside the pending queue. */
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status } = req.query;
      const portfolios = await prisma.studentPortfolio.findMany({
        where: status ? { status: String(status) as 'PENDING' | 'APPROVED' | 'REJECTED' } : undefined,
        include: {
          student: { select: studentSelect },
          reviewedBy: { select: { firstName: true, lastName: true } },
        },
        orderBy: { updatedAt: 'desc' },
      });
      res.json({ success: true, data: portfolios });
    } catch (err) { next(err); }
  },

  async get(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const portfolio = await prisma.studentPortfolio.findUnique({
        where: { id: req.params.id },
        include: { student: { select: studentSelect }, reviewedBy: { select: { firstName: true, lastName: true } } },
      });
      if (!portfolio) throw new AppError('Portfolio not found', 404);
      res.json({ success: true, data: portfolio });
    } catch (err) { next(err); }
  },

  async approve(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { note } = req.body as { note?: string };
      const existing = await prisma.studentPortfolio.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Portfolio not found', 404);

      const publicSlug = existing.publicSlug || generateSlug();

      const portfolio = await prisma.studentPortfolio.update({
        where: { id: existing.id },
        data: {
          status: 'APPROVED',
          reviewedById: req.user!.employeeId!,
          reviewedAt: new Date(),
          reviewNote: note,
          publicSlug,
        },
      });
      res.json({ success: true, data: portfolio });
    } catch (err) { next(err); }
  },

  async reject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { note } = req.body as { note?: string };
      const existing = await prisma.studentPortfolio.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Portfolio not found', 404);

      const portfolio = await prisma.studentPortfolio.update({
        where: { id: existing.id },
        data: {
          status: 'REJECTED',
          reviewedById: req.user!.employeeId!,
          reviewedAt: new Date(),
          reviewNote: note,
        },
      });
      res.json({ success: true, data: portfolio });
    } catch (err) { next(err); }
  },

  /**
   * Public, unauthenticated lookup by slug — backs the /portfolio/:slug page
   * that a scanned QR code opens. Only ever returns APPROVED portfolios;
   * everything else 404s so pending/rejected drafts are never exposed.
   */
  async publicGet(req: Request, res: Response, next: NextFunction) {
    try {
      const portfolio = await prisma.studentPortfolio.findFirst({
        where: { publicSlug: req.params.slug, status: 'APPROVED' },
        include: { student: { select: studentSelect } },
      });
      if (!portfolio) throw new AppError('Portfolio not found', 404);
      res.json({ success: true, data: portfolio });
    } catch (err) { next(err); }
  },
};
