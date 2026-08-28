import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { paginate, formatPagination } from '../utils/helpers';
import { emailService } from '../services/email.service';
import { generateReceiptPdf, ReceiptTransaction } from '../utils/receiptPdf';

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };
const leadSelect = { id: true, name: true, phone: true, email: true, city: true, assignedToId: true };

// Always CC'd on every student bill/receipt email, alongside the sales
// person mapped to that student (Lead.assignedTo).
const OPS_CC_EMAIL = 'opsvinsup@gmail.com';

const planInclude = {
  lead: { select: leadSelect },
  createdBy: { select: employeeSelect },
  installments: {
    orderBy: { dueDate: 'asc' as const },
    include: { receivedBy: { select: employeeSelect } },
  },
};

/**
 * Sequential VSA-######/MM/YYYY receipt number. Our own counter (this app
 * has no visibility into the external billing tool's sequence that produced
 * the VSA-000806 sample) — seeded off the existing FeeCollection row count so
 * numbers keep climbing rather than restarting, with a uniqueness retry loop
 * since receiptNo is a hard DB constraint.
 */
async function nextReceiptNo(date: Date): Promise<string> {
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  let seq = (await prisma.feeCollection.count()) + 1;
  for (let attempt = 0; attempt < 25; attempt++) {
    const candidate = `VSA-${String(seq).padStart(6, '0')}/${mm}/${yyyy}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await prisma.feeCollection.findUnique({ where: { receiptNo: candidate } });
    if (!exists) return candidate;
    seq++;
  }
  return `VSA-${String(seq).padStart(6, '0')}/${mm}/${yyyy}-${Date.now()}`;
}

/** Build + email the cumulative receipt PDF for a plan after a payment lands.
 * Wrapped in try/catch end-to-end (not just around the send) — a throw
 * anywhere in here (e.g. PDF generation) must never become a silent,
 * unlogged unhandled rejection, since this is always called fire-and-forget. */
async function emailReceipt(planId: string, paymentDate: Date) {
  try {
    await emailReceiptInner(planId, paymentDate);
  } catch (err) {
    console.error(`Fee receipt failed for plan ${planId}:`, err);
  }
}

async function emailReceiptInner(planId: string, paymentDate: Date) {
  const plan = await prisma.feePaymentPlan.findUnique({
    where: { id: planId },
    include: {
      lead: { select: { name: true, email: true, city: true, assignedTo: { select: { email: true } } } },
      installments: { where: { status: 'PAID' }, orderBy: { paidAt: 'asc' } },
    },
  });
  if (!plan) return;
  const email = (plan.lead.email || '').trim();
  if (!email) return; // nothing to send a bill to

  const totalPaid = plan.installments.reduce((sum, i) => sum + i.amount, 0);
  const receiptNo = await nextReceiptNo(paymentDate);
  const transactions: ReceiptTransaction[] = plan.installments.map((i) => ({
    mode: i.mode || 'OTHER',
    date: i.paidAt || i.createdAt,
    amount: i.amount,
  }));

  const pdf = await generateReceiptPdf({
    receiptNo,
    billToName: plan.lead.name,
    billToCity: plan.lead.city,
    paymentDate,
    dueDate: null,
    itemName: plan.courseName,
    totalFee: plan.totalFee,
    totalPaid,
    transactions,
  });

  const cc: string[] = [OPS_CC_EMAIL];
  const advisorEmail = plan.lead.assignedTo?.email?.trim();
  if (advisorEmail && advisorEmail.toLowerCase() !== OPS_CC_EMAIL.toLowerCase()) cc.push(advisorEmail);

  await emailService.send({
    to: email,
    cc: cc.length ? cc : undefined,
    subject: `🧾 Payment Receipt — ${receiptNo}`,
    html: emailService.templates.feeReceipt({
      name: plan.lead.name,
      receiptNo,
      totalFee: plan.totalFee,
      totalPaid,
      amountDue: Math.max(0, plan.totalFee - totalPaid),
      courseName: plan.courseName,
    }),
    attachments: [{ filename: `${receiptNo.replace(/\//g, '-')}.pdf`, content: pdf, contentType: 'application/pdf' }],
    template: 'fee_receipt',
  }).catch((err) => console.error('Fee receipt email failed:', err));
}

export const financeSalesController = {
  // ── Flat ledger (existing — unchanged) ──────────────────────────────────
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 20, mode, search } = req.query;
      const p = Number(page), l = Number(limit);

      const where: Record<string, unknown> = {};
      if (mode) where.mode = mode;
      if (search) {
        where.OR = [
          { studentName: { contains: String(search) } },
          { receiptNo: { contains: String(search) } },
        ];
      }

      const [collections, total, sumResult] = await Promise.all([
        prisma.feeCollection.findMany({
          where,
          include: {
            lead: { select: { id: true, name: true, courseInterest: true } },
            receivedBy: { select: employeeSelect },
          },
          orderBy: { collectedAt: 'desc' },
          ...paginate(p, l),
        }),
        prisma.feeCollection.count({ where }),
        prisma.feeCollection.aggregate({ where, _sum: { amount: true } }),
      ]);

      res.json({
        success: true,
        data: collections,
        meta: { ...formatPagination(total, p, l), totalAmount: sumResult._sum.amount || 0 },
      });
    } catch (err) { next(err); }
  },

  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { leadId, studentName, amount, mode, receivedById, receiptNo, remarks, collectedAt } = req.body;
      if (!studentName || !amount) throw new AppError('Student name and amount are required', 400);

      const collection = await prisma.feeCollection.create({
        data: {
          leadId: leadId || undefined,
          studentName,
          amount: Number(amount),
          mode,
          receivedById,
          receiptNo: receiptNo || undefined,
          remarks,
          collectedAt: collectedAt ? new Date(collectedAt) : undefined,
        },
        include: { lead: true, receivedBy: { select: employeeSelect } },
      });
      res.status(201).json({ success: true, data: collection });
    } catch (err) { next(err); }
  },

  async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { studentName, amount, mode, receivedById, receiptNo, remarks } = req.body;
      const collection = await prisma.feeCollection.update({
        where: { id: req.params.id },
        data: {
          studentName, amount: amount !== undefined ? Number(amount) : undefined,
          mode, receivedById, receiptNo, remarks,
        },
        include: { lead: true, receivedBy: { select: employeeSelect } },
      });
      res.json({ success: true, data: collection });
    } catch (err) { next(err); }
  },

  async remove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.feeCollection.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Collection deleted' });
    } catch (err) { next(err); }
  },

  async stats(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const [totalAll, totalThisMonth, byMode, count] = await Promise.all([
        prisma.feeCollection.aggregate({ _sum: { amount: true } }),
        prisma.feeCollection.aggregate({ _sum: { amount: true }, where: { collectedAt: { gte: startOfMonth } } }),
        prisma.feeCollection.groupBy({ by: ['mode'], _sum: { amount: true } }),
        prisma.feeCollection.count(),
      ]);

      const modeTotals: Record<string, number> = {};
      for (const row of byMode) modeTotals[row.mode] = row._sum.amount || 0;

      res.json({
        success: true,
        data: {
          totalCollected: totalAll._sum.amount || 0,
          collectedThisMonth: totalThisMonth._sum.amount || 0,
          modeTotals,
          totalTransactions: count,
        },
      });
    } catch (err) { next(err); }
  },

  // ── Fee declarations: Full / Part-payment / EMI plans ───────────────────
  // Deliberately keyed off Lead (not Student) — see schema.prisma comment on
  // FeePaymentPlan — so a dropped admission or refund never has to touch
  // enrollment data. A new intake ("quick add") just creates the Lead here;
  // Production later does the real enrollment + assigns a proper studentCode
  // once the batch/course is confirmed, using the same Lead via leadId.

  async searchLeads(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ success: true, data: [] });
      const leads = await prisma.lead.findMany({
        where: { OR: [{ name: { contains: q } }, { phone: { contains: q } }, { email: { contains: q } }] },
        select: { ...leadSelect, assignedTo: { select: employeeSelect } },
        orderBy: { createdAt: 'desc' },
        take: 15,
      });
      res.json({ success: true, data: leads });
    } catch (err) { next(err); }
  },

  async listPlans(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status, search } = req.query;
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (search) {
        where.lead = { OR: [{ name: { contains: String(search) } }, { phone: { contains: String(search) } }] };
      }
      const plans = await prisma.feePaymentPlan.findMany({
        where,
        include: planInclude,
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: plans });
    } catch (err) { next(err); }
  },

  async planDetail(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const plan = await prisma.feePaymentPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
      if (!plan) throw new AppError('Fee plan not found', 404);
      res.json({ success: true, data: plan });
    } catch (err) { next(err); }
  },

  /**
   * Create a fee declaration: Full payment (one PAID installment, nothing
   * pending), Part-payment (first payment PAID + a caller-supplied schedule
   * of future installments), or EMI (same shape as Part-payment — the
   * interest amount is left null for whoever handles EMI cases to fill in
   * afterward via updatePlan, per how Sales actually runs EMI here).
   */
  async createPlan(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { leadId: existingLeadId, newLead, courseName, totalFee, planType, firstPayment, installments } = req.body;
      if (!courseName || !totalFee) throw new AppError('courseName and totalFee are required', 400);
      if (!firstPayment || !firstPayment.amount) throw new AppError('The first payment amount is required', 400);
      const total = Number(totalFee);
      const firstAmount = Number(firstPayment.amount);
      if (firstAmount > total) throw new AppError('The first payment cannot exceed the total fee', 400);

      const type = (planType || 'FULL') as 'FULL' | 'PART' | 'EMI';
      if (type !== 'FULL' && (!Array.isArray(installments) || installments.length === 0)) {
        throw new AppError('Part-payment and EMI plans need at least one scheduled installment', 400);
      }

      let leadId = existingLeadId as string | undefined;
      if (!leadId) {
        const name = (newLead?.name || '').trim();
        const phone = (newLead?.phone || '').trim();
        const email = (newLead?.email || '').trim();
        if (!name || !phone || !email) throw new AppError('New student intake requires name, phone, and email', 400);
        const lead = await prisma.lead.create({
          data: { name, phone, email, status: 'ENROLLED', courseInterest: courseName, assignedToId: req.user?.employeeId || undefined },
        });
        leadId = lead.id;
      } else {
        // Map this lead to whoever's adding the payment, but only if nobody
        // already owns it — don't clobber an existing assignment.
        const existing = await prisma.lead.findUnique({ where: { id: leadId }, select: { assignedToId: true } });
        await prisma.lead.update({
          where: { id: leadId },
          data: { status: 'ENROLLED', assignedToId: existing?.assignedToId ?? (req.user?.employeeId || undefined) },
        }).catch(() => {});
      }

      const paymentDate = firstPayment.collectedAt ? new Date(firstPayment.collectedAt) : new Date();
      const receivedById = firstPayment.receivedById || req.user?.employeeId || undefined;

      const plan = await prisma.$transaction(async (tx) => {
        const created = await tx.feePaymentPlan.create({
          data: {
            leadId: leadId!,
            courseName,
            totalFee: total,
            planType: type,
            createdById: req.user?.employeeId,
          },
        });

        // The advance sits as PENDING_APPROVAL — no ledger row yet, no
        // receipt yet. It only becomes real (FeeCollection created, status
        // flips to PAID, receipt emailed) once Admin approves it.
        await tx.feeInstallment.create({
          data: {
            planId: created.id,
            dueDate: paymentDate,
            amount: firstAmount,
            status: 'PENDING_APPROVAL',
            paidAt: paymentDate,
            mode: firstPayment.mode || 'UPI',
            receivedById,
          },
        });

        if (Array.isArray(installments)) {
          for (const inst of installments) {
            if (!inst.dueDate || !inst.amount) continue;
            // eslint-disable-next-line no-await-in-loop
            await tx.feeInstallment.create({
              data: { planId: created.id, dueDate: new Date(inst.dueDate), amount: Number(inst.amount), status: 'PENDING' },
            });
          }
        }

        return created;
      });

      const full = await prisma.feePaymentPlan.findUnique({ where: { id: plan.id }, include: planInclude });
      res.status(201).json({ success: true, data: full, message: 'Student registered. Awaiting Admin approval of the advance before the receipt is emailed.' });
    } catch (err) { next(err); }
  },

  async updatePlan(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { courseName, totalFee, planType, interestAmount, status } = req.body;
      const plan = await prisma.feePaymentPlan.update({
        where: { id: req.params.id },
        data: {
          courseName, planType, status,
          totalFee: totalFee !== undefined ? Number(totalFee) : undefined,
          interestAmount: interestAmount !== undefined ? (interestAmount === null || interestAmount === '' ? null : Number(interestAmount)) : undefined,
        },
        include: planInclude,
      });
      res.json({ success: true, data: plan });
    } catch (err) { next(err); }
  },

  /** Cancels the plan and waives every installment still pending — covers a
   * dropped admission, refund, or track "flip" without touching any
   * enrollment data, and stops the reminder cron picking it up again. */
  async cancelPlan(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.$transaction([
        prisma.feePaymentPlan.update({ where: { id: req.params.id }, data: { status: 'CANCELLED' } }),
        prisma.feeInstallment.updateMany({ where: { planId: req.params.id, status: { in: ['PENDING', 'OVERDUE'] } }, data: { status: 'WAIVED' } }),
      ]);
      const plan = await prisma.feePaymentPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
      res.json({ success: true, data: plan });
    } catch (err) { next(err); }
  },

  async addInstallment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { dueDate, amount } = req.body;
      if (!dueDate || !amount) throw new AppError('dueDate and amount are required', 400);
      const installment = await prisma.feeInstallment.create({
        data: { planId: req.params.id, dueDate: new Date(dueDate), amount: Number(amount), status: 'PENDING' },
      });
      res.status(201).json({ success: true, data: installment });
    } catch (err) { next(err); }
  },

  /** Editable after creation, per how this is meant to work — amount/date
   * can be adjusted any time; mode/paidAt only make sense once collected. */
  async updateInstallment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { dueDate, amount, mode, paidAt } = req.body;
      const installment = await prisma.feeInstallment.update({
        where: { id: req.params.id },
        data: {
          dueDate: dueDate !== undefined ? new Date(dueDate) : undefined,
          amount: amount !== undefined ? Number(amount) : undefined,
          mode: mode !== undefined ? mode : undefined,
          paidAt: paidAt !== undefined ? new Date(paidAt) : undefined,
        },
      });
      res.json({ success: true, data: installment });
    } catch (err) { next(err); }
  },

  async removeInstallment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const installment = await prisma.feeInstallment.findUnique({ where: { id: req.params.id } });
      if (!installment) throw new AppError('Installment not found', 404);
      if (installment.status === 'PAID' || installment.status === 'PENDING_APPROVAL') {
        throw new AppError('A collected installment cannot be deleted — cancel the plan instead if this was a mistake', 400);
      }
      await prisma.feeInstallment.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Installment removed' });
    } catch (err) { next(err); }
  },

  /** Sales marks an installment collected — holds it at PENDING_APPROVAL with
   * the amount/mode/collector recorded. No ledger row and no receipt yet;
   * those only happen once Admin approves it via approveInstallment. */
  async collectInstallment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const installment = await prisma.feeInstallment.findUnique({
        where: { id: req.params.id },
        include: { plan: { include: { lead: { select: { id: true, assignedToId: true } } } } },
      });
      if (!installment) throw new AppError('Installment not found', 404);
      if (installment.status === 'PAID' || installment.status === 'PENDING_APPROVAL') {
        throw new AppError('This installment has already been collected', 400);
      }

      const { amount, mode, collectedAt } = req.body;
      const paidAmount = amount !== undefined ? Number(amount) : installment.amount;
      const paymentDate = collectedAt ? new Date(collectedAt) : new Date();
      const receiver = req.user?.employeeId || undefined;

      if (!installment.plan.lead.assignedToId && receiver) {
        await prisma.lead.update({ where: { id: installment.plan.leadId }, data: { assignedToId: receiver } }).catch(() => {});
      }

      await prisma.feeInstallment.update({
        where: { id: installment.id },
        data: { status: 'PENDING_APPROVAL', paidAt: paymentDate, amount: paidAmount, mode: mode || 'UPI', receivedById: receiver },
      });

      const plan = await prisma.feePaymentPlan.findUnique({ where: { id: installment.planId }, include: planInclude });
      res.json({ success: true, data: plan, message: 'Payment recorded. Awaiting Admin approval before the receipt is emailed.' });
    } catch (err) { next(err); }
  },

  /** Lists every installment collected by Sales but not yet confirmed by
   * Admin — the approval queue. */
  async listApprovals(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const installments = await prisma.feeInstallment.findMany({
        where: { status: 'PENDING_APPROVAL' },
        include: {
          receivedBy: { select: employeeSelect },
          plan: { select: { id: true, courseName: true, totalFee: true, planType: true, lead: { select: leadSelect } } },
        },
        orderBy: { paidAt: 'asc' },
      });
      res.json({ success: true, data: installments });
    } catch (err) { next(err); }
  },

  /** Admin confirms money was actually received: creates the FeeCollection
   * ledger row (so stats/ledger only ever reflect confirmed collections),
   * flips the installment to PAID, marks the plan COMPLETED if nothing's
   * left outstanding, and emails the receipt — CC'd to Ops + the sales
   * person mapped to the student. */
  async approveInstallment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const installment = await prisma.feeInstallment.findUnique({
        where: { id: req.params.id },
        include: { plan: { include: { lead: { select: { name: true } } } } },
      });
      if (!installment) throw new AppError('Installment not found', 404);
      if (installment.status !== 'PENDING_APPROVAL') throw new AppError('This installment is not awaiting approval', 400);

      const paymentDate = installment.paidAt || new Date();

      await prisma.$transaction(async (tx) => {
        const collection = await tx.feeCollection.create({
          data: {
            leadId: installment.plan.leadId,
            studentName: installment.plan.lead.name,
            amount: installment.amount,
            mode: installment.mode || 'UPI',
            receivedById: installment.receivedById || undefined,
            collectedAt: paymentDate,
            remarks: `Fee plan: ${installment.plan.courseName}`,
          },
        });
        await tx.feeInstallment.update({
          where: { id: installment.id },
          data: { status: 'PAID', collectionId: collection.id, approvedById: req.user?.employeeId, approvedAt: new Date() },
        });

        const remaining = await tx.feeInstallment.count({ where: { planId: installment.planId, status: { in: ['PENDING', 'OVERDUE', 'PENDING_APPROVAL'] } } });
        if (remaining === 0) {
          await tx.feePaymentPlan.update({ where: { id: installment.planId }, data: { status: 'COMPLETED' } });
        }
      });

      emailReceipt(installment.planId, paymentDate);

      const plan = await prisma.feePaymentPlan.findUnique({ where: { id: installment.planId }, include: planInclude });
      res.json({ success: true, data: plan, message: 'Payment approved. Receipt emailed.' });
    } catch (err) { next(err); }
  },
};
