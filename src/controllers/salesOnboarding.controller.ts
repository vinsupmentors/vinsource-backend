import { Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { getEffectiveAccess } from '../utils/moduleAccess';
import { PAYMENT_PROOF_DIR } from '../middleware/upload';
import { history } from '../utils/salesFlow';
import { quoteEmi, addMonthsKeepDay } from '../utils/emiQuote';

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

const firstVal = (v: any) => (Array.isArray(v) ? v[0] : v);

function parsePayment(req: AuthRequest) {
  const amount = Number(req.body.amount);
  if (!Number.isFinite(amount) || amount <= 0) throw new AppError('Enter the amount collected', 400);
  const mode = MODES.includes(String(req.body.payMode ?? firstVal(req.body.mode))) ? String(req.body.payMode ?? firstVal(req.body.mode)) : 'UPI';
  const reference = req.body.reference ? String(req.body.reference).trim().slice(0, 190) : null;
  const ocrAmount = req.body.ocrAmount !== undefined && req.body.ocrAmount !== '' ? Number(req.body.ocrAmount) : null;
  const ocrReference = req.body.ocrReference ? String(req.body.ocrReference).trim().slice(0, 190) : null;
  const amountMatched = ocrAmount === null || !Number.isFinite(ocrAmount) ? null : Math.abs(ocrAmount - amount) < 0.5;
  const paidAt = req.body.paidAt ? new Date(String(req.body.paidAt)) : new Date();
  return { amount, mode, reference, ocrAmount: ocrAmount !== null && Number.isFinite(ocrAmount) ? ocrAmount : null, ocrReference, amountMatched, paidAt: isNaN(paidAt.getTime()) ? new Date() : paidAt };
}

async function addPayment(planId: string, req: AuthRequest, kind: 'REGISTRATION_FEE' | 'DOWN_PAYMENT' | null) {
  const pay = parsePayment(req);
  const file = (req as any).file as { filename: string } | undefined;
  if (!file) throw new AppError('Attach the payment screenshot', 400);
  if (pay.reference) {
    const dup = await prisma.feeInstallment.findFirst({ where: { reference: pay.reference, rejectedAt: null }, select: { id: true } });
    if (dup) throw new AppError(`Transaction ID ${pay.reference} has already been used on another payment. Check the screenshot — the same payment can't be submitted twice.`, 409);
  }
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
      const mode = String(firstVal(b.mode) || '').toUpperCase();
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
      if (registrationPaid && req.body.reference) {
        const dup = await prisma.feeInstallment.findFirst({ where: { reference: String(req.body.reference).trim(), rejectedAt: null }, select: { id: true } });
        if (dup) throw new AppError(`Transaction ID ${String(req.body.reference).trim()} has already been used on another payment.`, 409);
      }

      const owner = req.user?.employeeId || undefined;
      let emi: Awaited<ReturnType<typeof quoteEmi>> | null = null;
      const emiMonths = Number(b.emiMonths) || 0;
      if (paymentMethod === 'EMI') {
        if (!totalFee) throw new AppError('Enter the course fee to set up the EMI', 400);
        if (!emiMonths) throw new AppError('Choose the number of EMI months', 400);
        emi = await quoteEmi(totalFee, emiMonths);
        if (registrationPaid && Number(b.amount) > emi.downPayment + 0.5) throw new AppError(`The amount collected can't be more than the down payment (${inr(emi.downPayment)}).`, 400);
      }
      const plan = await prisma.feePaymentPlan.create({
        data: {
          leadId: lead.id, courseName, totalFee: totalFee || 0, planType: PLAN_TYPE[paymentMethod], status: 'ACTIVE', createdById: owner,
          ...(emi ? { emiMonths: emi.months, downPayment: emi.downPayment, interestRatePct: emi.ratePct, interestAmount: emi.interest } : {}),
        },
      });
      const onboarding = await prisma.leadOnboarding.create({
        data: { leadId: lead.id, courseName, daysType, timing, mode, paymentMethod, totalFee, registrationPaid, planId: plan.id, createdById: owner },
      });
      await prisma.lead.update({ where: { id: lead.id }, data: { courseInterest: courseName } }).catch(() => {});

      let regAmount = 0;
      let line = `Onboarded for ${courseName} · ${label(daysType)} · ${label(timing)} · ${label(mode)} · ${label(paymentMethod)} payment`;
      if (registrationPaid) {
        const { pay } = await addPayment(plan.id, req, emi ? 'DOWN_PAYMENT' : 'REGISTRATION_FEE');
        regAmount = pay.amount;
        line += ` · Registration ${inr(pay.amount)} (${pay.mode.replace('_', ' ')}${pay.reference ? `, ref ${pay.reference}` : ''})${mismatchNote(pay)} — sent to Finance for approval`;
      }
      if (emi) {
        const now = new Date();
        const rows: { kind: 'DOWN_PAYMENT' | 'EMI'; amount: number; due: Date; n?: number }[] = [];
        const dpLeft = Math.round((emi.downPayment - regAmount) * 100) / 100;
        if (dpLeft > 0.5) rows.push({ kind: 'DOWN_PAYMENT', amount: dpLeft, due: new Date(now.getTime() + 7 * 86400000) });
        emi.monthly.forEach((amt, i) => rows.push({ kind: 'EMI', amount: amt, due: addMonthsKeepDay(now, i + 1), n: i + 1 }));
        const assignee = lead.assignedToId || owner;
        for (const r of rows) {
          const inst = await prisma.feeInstallment.create({ data: { planId: plan.id, dueDate: r.due, amount: r.amount, status: 'PENDING', kind: r.kind, emiMonthNumber: r.n ?? null, scheduled: true } });
          if (assignee) {
            const at = new Date(`${new Date(r.due.getTime() + 5.5 * 3600000).toISOString().slice(0, 10)}T10:00:00+05:30`);
            await prisma.salesTask.create({
              data: { title: `${r.kind === 'EMI' ? `EMI ${r.n}/${emi.months}` : 'Down payment'} ${inr(r.amount)} due — ${lead.name}`, description: 'Collect the payment and submit it with the screenshot from the lead\'s Fees tab.', leadId: lead.id, assignedToId: assignee, createdById: owner || null, dueAt: at, kind: 'MANUAL', installmentId: inst.id },
            }).catch(() => {});
          }
        }
        line += ` · EMI ${emi.months} months: down payment ${inr(emi.downPayment)}, ${inr(emi.monthly[0])}/month at ${emi.ratePct}% on the balance (total ${inr(emi.totalPayable)})`;
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
        allowed = acc.SALES === 'ADMIN' || (!!acc.FINANCE_SALES && acc.FINANCE_SALES !== 'NONE') || (!!acc.REPORT_SHEETS && acc.REPORT_SHEETS !== 'NONE');
      }
      if (!allowed) throw new AppError('You do not have access to this screenshot', 403);
      const file = path.join(PAYMENT_PROOF_DIR, path.basename(inst.proofFile));
      if (!fs.existsSync(file)) throw new AppError('Screenshot file missing', 404);
      res.setHeader('Cache-Control', 'private, no-store');
      res.sendFile(file);
    } catch (err) { next(err); }
  },

  /** Admin reverses a wrong onboarding while nothing has been approved by Finance. */
  async undo(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!(await isAdmin(req))) throw new AppError('Only a Sales Admin can undo an onboarding', 403);
      const lead = await prisma.lead.findUnique({ where: { id: req.params.id }, select: { id: true, deletedAt: true } });
      if (!lead || lead.deletedAt) throw new AppError('Lead not found', 404);
      const ob = await prisma.leadOnboarding.findUnique({ where: { leadId: lead.id } });
      if (!ob) throw new AppError('This lead is not onboarded', 400);
      const insts = ob.planId ? await prisma.feeInstallment.findMany({ where: { planId: ob.planId } }) : [];
      if (insts.some((i) => i.status === 'PAID')) throw new AppError('Finance has already approved a payment, so this onboarding can no longer be undone.', 409);
      await prisma.$transaction(async (tx) => {
        if (ob.planId) await tx.feePaymentPlan.delete({ where: { id: ob.planId } });
        await tx.leadOnboarding.delete({ where: { id: ob.id } });
      });
      for (const i of insts) if (i.proofFile) fs.unlink(path.join(PAYMENT_PROOF_DIR, path.basename(i.proofFile)), () => {});
      await history(lead.id, req.user?.employeeId, 'ONBOARDING', `Onboarding undone by admin (${ob.courseName})${insts.length ? ` — ${insts.length} unapproved payment(s) removed` : ''}`);
      res.json({ success: true, message: 'Onboarding undone.' });
    } catch (err) { next(err); }
  },

  /** Salesperson (or admin) changes this student's total course fee, e.g. after a course change. */
  async setTotalFee(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const lead = await loadLead(req);
      const ob = await prisma.leadOnboarding.findUnique({ where: { leadId: lead.id } });
      if (!ob || !ob.planId) throw new AppError('Onboard this lead first', 400);
      const fee = Number(req.body.totalFee);
      if (!Number.isFinite(fee) || fee <= 0) throw new AppError('Enter a valid course fee', 400);
      const courseName = req.body.courseName ? String(req.body.courseName).trim() : ob.courseName;
      const plan = await prisma.feePaymentPlan.findUnique({ where: { id: ob.planId } });
      await prisma.$transaction([
        prisma.feePaymentPlan.update({ where: { id: ob.planId }, data: { totalFee: fee, courseName } }),
        prisma.leadOnboarding.update({ where: { id: ob.id }, data: { totalFee: fee, courseName } }),
      ]);
      const changedCourse = courseName !== ob.courseName ? ` and course changed from ${ob.courseName} to ${courseName}` : '';
      await history(lead.id, req.user?.employeeId, 'ONBOARDING', `Course fee changed from ${plan && plan.totalFee > 0 ? inr(plan.totalFee) : 'not set'} to ${inr(fee)}${changedCourse}${req.body.reason ? ` — ${String(req.body.reason).slice(0, 200)}` : ''}`);
      res.json({ success: true, message: 'Course fee updated.' });
    } catch (err) { next(err); }
  },

  /** Finance rejects a payment; the reason goes back to the salesperson as a task. */
  async rejectPayment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const reason = String(req.body.reason || '').trim();
      if (!reason) throw new AppError('Give a reason for rejecting', 400);
      const inst = await prisma.feeInstallment.findUnique({ where: { id: req.params.id }, include: { plan: { include: { lead: { select: { id: true, name: true, assignedToId: true } } } } } });
      if (!inst) throw new AppError('Payment not found', 404);
      if (inst.status !== 'PENDING_APPROVAL') throw new AppError('This payment is not awaiting approval', 400);
      await prisma.feeInstallment.update({
        where: { id: inst.id },
        data: inst.scheduled
          ? { status: 'PENDING', paidAt: null, reference: null, proofFile: null, ocrAmount: null, ocrReference: null, amountMatched: null, mode: null, receivedById: null, rejectedAt: new Date(), rejectReason: reason, rejectedById: req.user?.employeeId || null }
          : { status: 'WAIVED', rejectedAt: new Date(), rejectReason: reason, rejectedById: req.user?.employeeId || null },
      });
      if (inst.proofFile && inst.scheduled) fs.unlink(path.join(PAYMENT_PROOF_DIR, path.basename(inst.proofFile)), () => {});
      const lead = inst.plan.lead;
      await history(lead.id, req.user?.employeeId, 'PAYMENT', `Payment of ${inr(inst.amount)}${inst.reference ? ` (ref ${inst.reference})` : ''} rejected by Finance — ${reason}`);
      const assignee = inst.receivedById || lead.assignedToId;
      if (assignee) {
        await prisma.salesTask.create({
          data: { title: `Payment rejected for ${lead.name}: ${reason}`.slice(0, 190), description: `Finance rejected the ${inr(inst.amount)} payment${inst.reference ? ` (ref ${inst.reference})` : ''}. Reason: ${reason}. Please check and submit the payment again from the Fees tab.`, leadId: lead.id, assignedToId: assignee, createdById: req.user?.employeeId || null, dueAt: new Date(), kind: 'MANUAL' },
        }).catch(() => {});
      }
      res.json({ success: true, message: 'Payment rejected. The salesperson has been notified.' });
    } catch (err) { next(err); }
  },

  /** Course fee master. */
  async listCourseFees(_req: AuthRequest, res: Response, next: NextFunction) {
    try { res.json({ success: true, data: await prisma.courseFee.findMany({ orderBy: { courseName: 'asc' } }) }); } catch (err) { next(err); }
  },

  async saveCourseFee(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const courseName = String(req.body.courseName || '').trim();
      const fee = Number(req.body.fee);
      if (!courseName) throw new AppError('Course name is required', 400);
      if (!Number.isFinite(fee) || fee <= 0) throw new AppError('Enter a valid fee', 400);
      const data = await prisma.courseFee.upsert({
        where: { courseName }, create: { courseName, fee, updatedById: req.user?.employeeId || null }, update: { fee, updatedById: req.user?.employeeId || null },
      });
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async deleteCourseFee(req: AuthRequest, res: Response, next: NextFunction) {
    try { await prisma.courseFee.delete({ where: { id: req.params.id } }); res.json({ success: true }); } catch (err) { next(err); }
  },

  /** Allowed EMI months and the full schedule for a fee + tenure. */
  async emiQuote(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const fee = Number(req.query.fee);
      const months = Number(req.query.months) || 0;
      const { allowedEmiMonths } = await import('../utils/emiQuote');
      if (!months) return res.json({ success: true, data: { allowedMonths: fee > 0 ? allowedEmiMonths(fee) : [] } });
      res.json({ success: true, data: await quoteEmi(fee, months) });
    } catch (err) { next(err); }
  },

  /** Sales submits the money for a scheduled instalment (EMI / down payment), with its screenshot, for Finance to approve. */
  async payInstallment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const inst = await prisma.feeInstallment.findUnique({ where: { id: req.params.id }, include: { plan: { select: { leadId: true, lead: { select: { id: true, name: true, assignedToId: true } } } } } });
      if (!inst) throw new AppError('Instalment not found', 404);
      if (!(await isAdmin(req)) && inst.plan.lead.assignedToId !== req.user?.employeeId) throw new AppError('You do not have access to this lead', 403);
      if (inst.status !== 'PENDING' && inst.status !== 'OVERDUE') throw new AppError('This instalment is not waiting for payment', 400);
      const pay = parsePayment(req);
      const file = (req as any).file as { filename: string } | undefined;
      if (!file) throw new AppError('Attach the payment screenshot', 400);
      if (pay.reference) {
        const dup = await prisma.feeInstallment.findFirst({ where: { reference: pay.reference, rejectedAt: null, NOT: { id: inst.id } }, select: { id: true } });
        if (dup) throw new AppError(`Transaction ID ${pay.reference} has already been used on another payment.`, 409);
      }
      await prisma.feeInstallment.update({
        where: { id: inst.id },
        data: { status: 'PENDING_APPROVAL', amount: pay.amount, paidAt: pay.paidAt, mode: pay.mode as any, reference: pay.reference, proofFile: file.filename, ocrAmount: pay.ocrAmount, ocrReference: pay.ocrReference, amountMatched: pay.amountMatched, receivedById: req.user?.employeeId || null, rejectedAt: null, rejectReason: null },
      });
      await prisma.salesTask.updateMany({ where: { installmentId: inst.id, status: 'OPEN' }, data: { status: 'DONE', completedAt: new Date() } });
      await history(inst.plan.leadId, req.user?.employeeId, 'PAYMENT', `${inst.kind === 'EMI' ? `EMI ${inst.emiMonthNumber}` : 'Instalment'} payment of ${inr(pay.amount)} recorded (${pay.mode.replace('_', ' ')}${pay.reference ? `, ref ${pay.reference}` : ''})${mismatchNote(pay)} — awaiting Finance verification`);
      res.json({ success: true, message: 'Payment sent to Finance for approval.' });
    } catch (err) {
      const f = (req as any).file as { filename: string } | undefined;
      if (f) fs.unlink(path.join(PAYMENT_PROOF_DIR, f.filename), () => {});
      next(err);
    }
  },

  /** EMI menu: every EMI student with what is paid, what is due next and what is overdue. */
  async emiPlans(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      // EMI-menu users (and Sales Admin) see every EMI student; a salesperson without the EMI menu sees only their own.
      let admin = await isAdmin(req);
      if (!admin && req.user) {
        const acc = await getEffectiveAccess(req.user.userId);
        admin = !!acc.EMI && acc.EMI !== 'NONE';
      }
      const me = req.user?.employeeId;
      if (!admin && !me) throw new AppError('Your account is not linked to an employee record', 400);
      const plans = await prisma.feePaymentPlan.findMany({
        where: { planType: 'EMI', status: { in: ['ACTIVE', 'COMPLETED'] }, lead: { deletedAt: null, ...(admin ? {} : { assignedToId: me }) } },
        include: { installments: { orderBy: { dueDate: 'asc' } }, lead: { select: { id: true, name: true, phone: true, assignedTo: { select: { id: true, firstName: true, lastName: true } } } } },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });
      const now = new Date();
      const rows = plans.map((p) => {
        const live = p.installments.filter((i) => i.status !== 'WAIVED');
        const total = live.reduce((n, i) => n + i.amount, 0);
        const paid = live.filter((i) => i.status === 'PAID').reduce((n, i) => n + i.amount, 0);
        const awaiting = live.filter((i) => i.status === 'PENDING_APPROVAL').reduce((n, i) => n + i.amount, 0);
        const open = live.filter((i) => i.status === 'PENDING' || i.status === 'OVERDUE');
        const overdue = open.filter((i) => i.dueDate < now);
        const next = open[0] || null;
        return {
          planId: p.id, lead: p.lead, courseName: p.courseName, months: p.emiMonths, ratePct: p.interestRatePct, fee: p.totalFee,
          total, paid, awaiting, balance: Math.max(0, total - paid - awaiting),
          paidCount: live.filter((i) => i.status === 'PAID' && i.kind === 'EMI').length,
          overdueCount: overdue.length, overdueAmount: overdue.reduce((n, i) => n + i.amount, 0),
          nextDue: next ? { dueDate: next.dueDate, amount: next.amount } : null,
        };
      });
      res.json({ success: true, data: rows });
    } catch (err) { next(err); }
  },
};
