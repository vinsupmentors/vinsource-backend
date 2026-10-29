import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

const PACE = ['TOO_FAST', 'JUST_RIGHT', 'TOO_SLOW'];
const DOUBTS = ['YES', 'PARTLY', 'NO'];
const INTENT = ['YES', 'MAYBE', 'NO'];
const rate = (v: unknown, label: string) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 5) throw new AppError(`Please rate: ${label}`, 400);
  return n;
};
const text = (v: unknown, max = 1500) => (v ? String(v).trim().slice(0, max) || null : null);

export const demoFeedbackController = {
  /** Sales rep releases the feedback questions for a demo → returns the token (idempotent). */
  async release(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const demo = await prisma.demo.findUnique({ where: { id: req.params.id }, include: { studentFeedback: true, lead: { select: { name: true } } } });
      if (!demo) throw new AppError('Demo not found', 404);
      let fb = demo.studentFeedback;
      if (!fb) {
        fb = await prisma.demoFeedback.create({ data: { demoId: demo.id, token: crypto.randomBytes(16).toString('hex'), releasedById: req.user?.employeeId || null } });
      }
      res.json({ success: true, data: { token: fb.token, submitted: !!fb.submittedAt, student: demo.lead.name } });
    } catch (err) { next(err); }
  },

  /** Public: the form details for a token. */
  async publicGet(req: Request, res: Response, next: NextFunction) {
    try {
      const fb = await prisma.demoFeedback.findUnique({ where: { token: String(req.params.token) }, include: { demo: { include: { lead: { select: { name: true } }, conductedBy: { select: { firstName: true, lastName: true } } } } } });
      if (!fb) throw new AppError('This feedback link is not valid', 404);
      res.json({ success: true, data: { student: fb.demo.lead.name, course: fb.demo.courseEnquired || '', trainer: fb.demo.conductedBy ? `${fb.demo.conductedBy.firstName} ${fb.demo.conductedBy.lastName}`.trim() : '', submitted: !!fb.submittedAt } });
    } catch (err) { next(err); }
  },

  /** Public: the student submits the review. */
  async publicSubmit(req: Request, res: Response, next: NextFunction) {
    try {
      const fb = await prisma.demoFeedback.findUnique({ where: { token: String(req.params.token) } });
      if (!fb) throw new AppError('This feedback link is not valid', 404);
      if (fb.submittedAt) throw new AppError('Feedback has already been submitted. Thank you!', 400);
      const b = req.body || {};
      const overall = rate(b.overall, 'Overall demo');
      const trainer = rate(b.trainer, 'Trainer explanation');
      const content = rate(b.content, 'Content');
      if (!PACE.includes(b.pace)) throw new AppError('Please tell us about the pace', 400);
      if (!DOUBTS.includes(b.doubts)) throw new AppError('Please tell us whether your doubts were answered', 400);
      if (!INTENT.includes(b.joinIntent)) throw new AppError('Please tell us if you would like to join', 400);
      await prisma.demoFeedback.update({
        where: { id: fb.id },
        data: { submittedAt: new Date(), overall, trainer, content, pace: b.pace, doubts: b.doubts, joinIntent: b.joinIntent, liked: text(b.liked), improve: text(b.improve), studentName: text(b.studentName, 120) },
      });
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};
