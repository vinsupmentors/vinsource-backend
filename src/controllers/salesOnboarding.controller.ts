import { Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { getEffectiveAccess } from '../utils/moduleAccess';
import { PAYMENT_PROOF_DIR } from '../middleware/upload';
import { history } from '../utils/salesFlow';

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;
const MODES = ['CASH', 'UPI', 'CARD', 'NET_BANKING', 'CHEQUE', 'JODO', 'OTHER'];
const PLAN_TYPE: Record<string, 'FULL' | 'PART' | 'EMI'> = { FULL: 'FULL', PART: 'PART', EMI: 'EMI' };
const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

async function isAdmin(req: AuthRequest): Promise<boolean> {
  if (!req.user) return false;
  if (req.user.role === 'SUPER_ADMIN') return true;
  return (await getEffectiveAccess(req.user.userId)).SALES === 'ADMIN';
}

async function loadLead(req: AuthRequest) {
  const lead = await prisma.lead.findUnique({ where: { id: req.params.id }, select: { id: true, name: true, deletedAt: true, assignedToId: true } });
  if (!lead || lead.deletedAt) throw new AppError('Lead not found', 404);
  if (!(await isAdmin(req)) && lead.assignedToId !== req.user?.employeeId) throw new AppError('You do not have access to this lead', 403);
  return lead;
}

function parsePayment(req: AuthRequest) {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError('Enter the amount collected', 400);
  const mode = MODES.includes(String(req.body.mode)) ? String(req.body.mode) : 'UPI';
  const reference = req.body.reference ? String(req.body.reference).trim().slice(0, 190) : null;
  const ocrAmount = req.body.ocrAmount !== undefined && req.body.ocrAmount !== '' ? Number(req.body.ocrAmount) : null;
  const ocrReference = req.body.ocrReference ? String(req.body.ocrReference).trim().slice(0, 190) : null;
  const amountMatched = ocrAmount === null || !Number.isFinite(ocrAmount) ? null : Math.abs(ocrAmount - amount) < 0.5;
  const paidAt = req.body.paidAt ? new Date(String(req.body.paidAt)) : new Date();
  return { amount, mode, reference, ocrAmount: ocrAmount !== null && Number.isFinite(ocrAmount) ? ocrAmount : null, ocrReference, amountMatched, paidAt: isNaN(paidAt.getTime()) ? new Date() : paidAt };
}

async function addPayment(planId: string, req: AuthRequest, kind: 'REGISTRATION_FEE' | null) {
  const pay = parsePayment(req);
  const file = (req as any).file as { filename: string } | undefined;
  if (!file) throw new AppError('Attach the payment screenshot', 400);
  const inst = await prisma.feeInstallment.create({
    data: {
      planId,
      dueDate: pay.paidAt,
      amount: pay.amount,
      status: 'PENDING_APPROVAL',
      paidAt: pay.paidAt,
      mode: pay.mode as any,
      reference: pay.reference,
      proofFile: file.filename,
      ocrAmount: pay.ocrAmount,
      ocrReference: pay.ocrReference,
      amountMatched: pay.amountMatched,
      receivedById: req.user?.employeeId || null,
      ...(kind ? { kind: kind as any } : {}),
    },
  });
  return { inst, pay };
}

const mismatchNote = (pay: { amountMatched: boolean | null; ocrAmount: number | null }) =>
  pay.amountMatched === false ? ` ⚠ screenshot shows ${inr(pay.ocrAmount || 0)}` : '';

export const salesOnboardingController = {
  /** Onboard a lead: batch preferences + payment method, optionally the registration payment with its screenshot. */
  async onboard(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const lead = await loadLead(req);
      const b = req.body || {};
      const courseName = String(b.courseName || '').trim();
      const daysType = String(b.daysType || '').toUpperCase();
      const timing = String(b.timing || '').toUpperCase();
      const mode = String(b.mode || '').toUpperCase();
      const paymentMethod = String(b.paymentMethod || '').toUpperCase();
      if (!courseName) throw new AppError('Choose the course', 400);
      if (!['WEEKDAY', 'WEEKEND'].includes(daysType)) throw new AppError('Choose Weekday or Weekend', 400);
      if (!['MORNING', 'AFTERNOON', 'EVENING'].includes(timing)) throw new AppError('Choose the timing', 400);
      if (!['OFFLINE', 'ONLINE'].includes(mode)) throw new AppError('Choose Offline or Online', 400);
      if (!PLAN_TYPE[paymentMethod]) throw new AppError('Choose the payment method', 400);
      const registrationPaid = b.registrationPaid === true || b.registrationPaid === 'true';
      const totalFee = b.totalFee !== undefined && b.totalFee !== '' && Number(b.totalFee) > 0 ? Number(b.totalFee) : null;
      if (await prisma.leadOnboarding.findUnique({ where: { leadId: lead.id } })) throw new AppError('This lead is already onboarded', 409);
      if (registrationPaid && !(req as any).file) throw new AppError('Attach the payment screenshot for the registration amount', 400);

      const owner = req.user?.employeeId || undefined;
      const plan = await prisma.feePaymentPlan.create({
        data: { leadId: lead.id, courseName, totalFee: totalFee || 0, planType: PLAN_TYPE[paymentMethod], status: 'ACTIVE', createdById: owner },
      });
      const onboarding = await prisma.leadOnboarding.create({
        data: { leadId: lead.id, courseName, daysType, timing, mode, paymentMethod, totalFee, registrationPaid, planId: plan.id, createdById: owner },
      });
      await prisma.lead.update({ where: { id: lead.id }, data: { courseInterest: courseName } }).catch(() => {});

      let line = `Onboarded for ${courseName} · ${label(daysType)} · ${label(timing)} · ${label(mode)} · ${label(paymentMethod)} payment`;
      if (registrationPaid) {
        const { pay } = await addPayment(plan.id, req, 'REGISTRATION_FEE');
        line += ` · Registration ${inr(pay.amount)} (${pay.mode.replace('_', ' ')}${pay.reference ? `, ref ${pay.reference}` : ''})${mismatchNote(pay)} — sent to Finance for approval`;
      }
      await history(lead.id, owner, 'ONBOARDING', line);
      await prisma.leadNote.create({ data: { leadId: lead.id, authorId: owner || null, body: `Fees: ${line}${totalFee ? ` · Course fee ${inr(totalFee)}` : ''}` } }).catch(() => {});
      res.status(201).json({ success: true, data: onboarding, message: registrationPaid ? 'Onboarded. Registration payment sent to Finance for approval.' : 'Lead onboarded.' });
    } catch (err) {
      const f = (req as any).file as { filename: string } | undefined;
      if (f) fs.unlink(path.join(PAYMENT_PROOF_DIR, f.filename), () => {});
      next(err);
    }
  },

  /** Sales adds a further payment; it joins Finance's approval queue. */
  async recordPayment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const lead = await loadLead(req);
      const ob = await prisma.leadOnboarding.findUnique({ where: { leadId: lead.id } });
      if (!ob || !ob.planId) throw new AppError('Onboard this lead first', 400);
      const plan = await prisma.feePaymentPlan.findUnique({ where: { id: ob.planId } });
      if (!plan) throw new AppError('Fee plan not found', 404);
      if (plan.status !== 'ACTIVE') await prisma.feePaymentPlan.update({ where: { id: plan.id }, data: { status: 'ACTIVE' } });
      if (req.body.totalFee !== undefined && req.body.totalFee !== '' && Number(req.body.totalFee) > 0 && plan.totalFee <= 0) {
        await prisma.feePaymentPlan.update({ where: { id: plan.id }, data: { totalFee: Number(req.body.totalFee) } });
        await prisma.leadOnboarding.update({ where: { id: ob.id }, data: { totalFee: Number(req.body.totalFee) } });
      }
      const { pay } = await addPayment(plan.id, req, null);
      await history(lead.id, req.user?.employeeId, 'PAYMENT', `Payment of ${inr(pay.amount)} recorded (${pay.mode.replace('_', ' ')}${pay.reference ? `, ref ${pay.reference}` : ''})${mismatchNote(pay)} — awaiting Finance verification`);
      res.status(201).json({ success: true, message: 'Payment sent to Finance for approval.' });
    } catch (err) {
      const f = (req as any).file as { filename: string } | undefined;
      if (f) fs.unlink(path.join(PAYMENT_PROOF_DIR, f.filename), () => {});
      next(err);
    }
  },

  /** Onboarding details for a lead (null when not onboarded). */
  async get(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const lead = await loadLead(req);
      const data = await prisma.leadOnboarding.findUnique({ where: { leadId: lead.id } });
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /** Stream a payment screenshot to Sales (owner/admin) or Finance. */
  async proof(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const inst = await prisma.feeInstallment.findUnique({ where: { id: req.params.id }, select: { proofFile: true, plan: { select: { lead: { select: { assignedToId: true } } } } } });
      if (!inst || !inst.proofFile) throw new AppError('No screenshot on this payment', 404);
      let allowed = req.user?.role === 'ADMIN' || req.user?.role === 'SUPER_ADMIN' || (!!req.user?.employeeId && inst.plan.lead.assignedToId === req.user.employeeId);
      if (!allowed && req.user) {
        const acc = await getEffectiveAccess(req.user.userId);
        allowed = acc.SALES === 'ADMIN' || (!!acc.FINANCE_SALES && acc.FINANCE_SALES !== 'NONE');
      }
      if (!allowed) throw new AppError('You do not have access to this screenshot', 403);
      const file = path.join(PAYMENT_PROOF_DIR, path.basename(inst.proofFile));
      if (!fs.existsSync(file)) throw new AppError('Screenshot file missing', 404);
      res.setHeader('Cache-Control', 'private, no-store');
      res.sendFile(file);
    } catch (err) { next(err); }
  },
};
