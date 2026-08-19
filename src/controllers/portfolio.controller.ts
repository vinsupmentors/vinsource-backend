import { Response, NextFunction, Request } from 'express';
import crypto from 'crypto';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { computeGamification } from '../services/gamification.service';
import { ensureInternshipCertRequest } from '../utils/certificateRequests';

const studentSelect = {
  id: true, firstName: true, lastName: true, studentCode: true, track: true, photo: true, email: true, phone: true,
  // Used to group portfolios by course on the Production Portfolio Approvals
  // screen. PT (direct-placement) students have no enrollment at all — the
  // frontend buckets those under a "PT — Direct Placement" card instead.
  enrollments: { select: { schedule: { select: { course: { select: { id: true, name: true } } } } } },
};

/** Fallback slug generator — only used if a student somehow has no studentCode. */
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
      const existing = await prisma.studentPortfolio.findUnique({
        where: { id: req.params.id },
        include: { student: { select: { studentCode: true } } },
      });
      if (!existing) throw new AppError('Portfolio not found', 404);

      // The public URL is the student's roll number (studentCode), not a
      // random hash — clean, memorable, and consistent every time the
      // portfolio is (re)approved.
      const publicSlug = existing.student.studentCode || generateSlug();

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

      await ensureInternshipCertRequest(existing.studentId);

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
   * Admin delete — pulls a portfolio (pending, approved, or rejected) off the
   * board entirely, e.g. to take down a live public page or clear out a
   * submission that should never have gone in. Hard delete: the student's
   * `GET /api/student-portal/portfolio` will come back null afterward and
   * they can start fresh with a new submission.
   */
  async remove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.studentPortfolio.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Portfolio not found', 404);
      await prisma.studentPortfolio.delete({ where: { id: existing.id } });
      res.json({ success: true, message: 'Portfolio deleted' });
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

      // Earned achievement badges (computed live; only earned ones go public)
      const { badges } = await computeGamification(portfolio.studentId).catch(() => ({ badges: [] as { earned: boolean }[] }));
      res.json({ success: true, data: { ...portfolio, badges: badges.filter((b) => b.earned) } });
    } catch (err) { next(err); }
  },
};
