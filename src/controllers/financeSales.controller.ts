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
      const { status, search, salesPersonId, courseName, planType, from, to } = req.query;
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (planType) where.planType = planType;
      if (courseName) where.courseName = String(courseName);
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(String(from));
        if (to) { const end = new Date(String(to)); end.setHours(23, 59, 59, 999); range.lte = end; }
        where.createdAt = range;
      }
      const leadWhere: Record<string, unknown> = {};
      if (salesPersonId) leadWhere.assignedToId = String(salesPersonId);
      if (search) leadWhere.OR = [{ name: { contains: String(search) } }, { phone: { contains: String(search) } }];
      if (Object.keys(leadWhere).length) where.lead = leadWhere;

      const plans = await prisma.feePaymentPlan.findMany({
        where,
        include: planInclude,
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: plans });
    } catch (err) { next(err); }
  },

  /** Cross-cutting KPI dashboard: revenue collected/outstanding overall, by
   * sales person, and by course (the closest thing to a "batch" fee
   * declarations actually capture — courseName is free text entered at
   * intake, there's no FK to the real Batch/enrollment tables from here),
   * plus EMI default tracking. Deliberately aggregated in JS off one query
   * rather than several groupBys — sales-person/course breakdowns need the
   * Lead relation, which Prisma's groupBy can't traverse, and the dataset
   * size here doesn't warrant raw SQL. */
  async dashboard(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { from, to } = req.query;
      const where: Record<string, unknown> = {};
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(String(from));
        if (to) { const end = new Date(String(to)); end.setHours(23, 59, 59, 999); range.lte = end; }
        where.createdAt = range;
      }

      const plans = await prisma.feePaymentPlan.findMany({
        where,
        include: {
          lead: { select: { assignedToId: true, assignedTo: { select: employeeSelect }, name: true, phone: true } },
          installments: true,
        },
        orderBy: { createdAt: 'desc' },
      });

      const overview = {
        totalStudents: plans.length,
        activeCount: 0, completedCount: 0, cancelledCount: 0, refundedCount: 0,
        totalFeeValue: 0, totalCollected: 0, totalAwaitingApproval: 0, totalOutstanding: 0, totalRefunded: 0,
        pendingApprovalsCount: 0, pendingRefundRequests: 0, pendingDeletionRequests: 0,
      };

      type Bucket = { key: string; label: string; sub?: string; studentCount: number; totalFeeValue: number; collected: number; awaitingApproval: number; outstanding: number };
      const bySalesPerson = new Map<string, Bucket>();
      const byCourse = new Map<string, Bucket>();

      const overdueInstallments: Array<{ id: string; studentName: string; studentPhone: string; courseName: string; amount: number; dueDate: Date; assignedTo: { firstName: string; lastName: string } | null }> = [];
      let emiTotalDueSoFar = 0, emiOverdue = 0, emiPlansCount = 0;

      for (const plan of plans) {
        if (plan.status === 'ACTIVE') overview.activeCount++;
        else if (plan.status === 'COMPLETED') overview.completedCount++;
        else if (plan.status === 'CANCELLED') overview.cancelledCount++;
        else if (plan.status === 'REFUNDED') overview.refundedCount++;

        const collected = plan.installments.filter((i) => i.status === 'PAID').reduce((s, i) => s + i.amount, 0);
        const awaiting = plan.installments.filter((i) => i.status === 'PENDING_APPROVAL').reduce((s, i) => s + i.amount, 0);
        const outstanding = plan.status === 'ACTIVE' ? Math.max(0, plan.totalFee - collected - awaiting) : 0;

        overview.totalFeeValue += plan.totalFee;
        overview.totalCollected += collected;
        overview.totalAwaitingApproval += awaiting;
        overview.totalOutstanding += outstanding;
        if (plan.status === 'REFUNDED' && plan.refundAmount) overview.totalRefunded += plan.refundAmount;
        overview.pendingApprovalsCount += plan.installments.filter((i) => i.status === 'PENDING_APPROVAL').length;
        if (plan.refundRequestedAt && !plan.refundCompletedAt) overview.pendingRefundRequests++;
        if (plan.deletionRequestedAt) overview.pendingDeletionRequests++;

        const spId = plan.lead.assignedToId || '__unassigned__';
        const spLabel = plan.lead.assignedTo ? `${plan.lead.assignedTo.firstName} ${plan.lead.assignedTo.lastName}` : 'Unassigned';
        if (!bySalesPerson.has(spId)) bySalesPerson.set(spId, { key: spId, label: spLabel, sub: plan.lead.assignedTo?.employeeCode, studentCount: 0, totalFeeValue: 0, collected: 0, awaitingApproval: 0, outstanding: 0 });
        const spBucket = bySalesPerson.get(spId)!;
        spBucket.studentCount++; spBucket.totalFeeValue += plan.totalFee; spBucket.collected += collected; spBucket.awaitingApproval += awaiting; spBucket.outstanding += outstanding;

        const courseKey = plan.courseName || 'Unspecified';
        if (!byCourse.has(courseKey)) byCourse.set(courseKey, { key: courseKey, label: courseKey, studentCount: 0, totalFeeValue: 0, collected: 0, awaitingApproval: 0, outstanding: 0 });
        const courseBucket = byCourse.get(courseKey)!;
        courseBucket.studentCount++; courseBucket.totalFeeValue += plan.totalFee; courseBucket.collected += collected; courseBucket.awaitingApproval += awaiting; courseBucket.outstanding += outstanding;

        if (plan.planType === 'EMI') {
          emiPlansCount++;
          const now = new Date();
          for (const inst of plan.installments) {
            const isDue = inst.dueDate <= now;
            if (!isDue) continue;
            if (inst.status === 'PAID') { emiTotalDueSoFar++; }
            else if (inst.status === 'OVERDUE' || inst.status === 'PENDING') {
              emiTotalDueSoFar++; emiOverdue++;
              overdueInstallments.push({
                id: inst.id, studentName: plan.lead.name, studentPhone: plan.lead.phone, courseName: plan.courseName,
                amount: inst.amount, dueDate: inst.dueDate, assignedTo: plan.lead.assignedTo,
              });
            }
          }
        }
      }

      overdueInstallments.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

      res.json({
        success: true,
        data: {
          overview,
          bySalesPerson: Array.from(bySalesPerson.values()).sort((a, b) => b.outstanding - a.outstanding),
          byCourse: Array.from(byCourse.values()).sort((a, b) => b.outstanding - a.outstanding),
          emi: {
            emiPlansCount,
            totalDueSoFar: emiTotalDueSoFar,
            overdueCount: emiOverdue,
            defaultRatePct: emiTotalDueSoFar > 0 ? Math.round((emiOverdue / emiTotalDueSoFar) * 1000) / 10 : 0,
            overdueInstallments: overdueInstallments.slice(0, 100),
          },
        },
      });
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

  /** History of every installment an Admin has approved. */
  async listApprovalHistory(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const installments = await prisma.feeInstallment.findMany({
        where: { approvedAt: { not: null } },
        include: {
          receivedBy: { select: employeeSelect },
          approvedBy: { select: employeeSelect },
          plan: { select: { id: true, courseName: true, totalFee: true, planType: true, lead: { select: leadSelect } } },
        },
        orderBy: { approvedAt: 'desc' },
        take: 200,
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

  // ── Refund: Sales requests it, Admin does the transfer outside the app
  // and marks it completed. ────────────────────────────────────────────────

  async requestRefund(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { amount, reason } = req.body;
      const plan = await prisma.feePaymentPlan.findUnique({ where: { id: req.params.id } });
      if (!plan) throw new AppError('Fee plan not found', 404);
      if (plan.refundRequestedAt && !plan.refundCompletedAt) {
        throw new AppError('A refund request for this plan is already pending admin approval.', 409);
      }
      const updated = await prisma.feePaymentPlan.update({
        where: { id: req.params.id },
        data: {
          refundRequestedAt: new Date(),
          refundRequestedById: req.user?.employeeId || null,
          refundAmount: amount !== undefined && amount !== '' && amount !== null ? Number(amount) : null,
          refundReason: (reason && String(reason).trim()) || null,
          refundCompletedAt: null,
          refundCompletedById: null,
        },
        include: planInclude,
      });
      res.json({ success: true, data: updated, message: 'Refund request submitted for admin approval.' });
    } catch (err) { next(err); }
  },

  async listRefundRequests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const plans = await prisma.feePaymentPlan.findMany({
        where: { refundRequestedAt: { not: null }, refundCompletedAt: null },
        include: { ...planInclude, refundRequestedBy: { select: employeeSelect } },
        orderBy: { refundRequestedAt: 'desc' },
      });
      res.json({ success: true, data: plans });
    } catch (err) { next(err); }
  },

  /** Admin confirms the money's actually been transferred back — waives
   * whatever was still scheduled and flips the plan to REFUNDED. */
  async completeRefund(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const plan = await prisma.feePaymentPlan.findUnique({ where: { id: req.params.id } });
      if (!plan) throw new AppError('Fee plan not found', 404);
      if (!plan.refundRequestedAt || plan.refundCompletedAt) {
        throw new AppError('This plan has no pending refund request.', 409);
      }
      await prisma.$transaction([
        prisma.feePaymentPlan.update({
          where: { id: req.params.id },
          data: { status: 'REFUNDED', refundCompletedAt: new Date(), refundCompletedById: req.user?.employeeId },
        }),
        prisma.feeInstallment.updateMany({
          where: { planId: req.params.id, status: { in: ['PENDING', 'OVERDUE'] } },
          data: { status: 'WAIVED' },
        }),
      ]);
      const full = await prisma.feePaymentPlan.findUnique({ where: { id: req.params.id }, include: planInclude });
      res.json({ success: true, data: full, message: 'Refund marked as completed.' });
    } catch (err) { next(err); }
  },

  /** History of every completed refund. */
  async listRefundHistory(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const plans = await prisma.feePaymentPlan.findMany({
        where: { refundCompletedAt: { not: null } },
        include: { ...planInclude, refundRequestedBy: { select: employeeSelect }, refundCompletedBy: { select: employeeSelect } },
        orderBy: { refundCompletedAt: 'desc' },
        take: 200,
      });
      res.json({ success: true, data: plans });
    } catch (err) { next(err); }
  },

  async rejectRefund(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const plan = await prisma.feePaymentPlan.findUnique({ where: { id: req.params.id } });
      if (!plan) throw new AppError('Fee plan not found', 404);
      if (!plan.refundRequestedAt || plan.refundCompletedAt) {
        throw new AppError('This plan has no pending refund request.', 409);
      }
      await prisma.feePaymentPlan.update({
        where: { id: req.params.id },
        data: { refundRequestedAt: null, refundRequestedById: null, refundAmount: null, refundReason: null },
      });
      res.json({ success: true, message: 'Refund request rejected.' });
    } catch (err) { next(err); }
  },

  // ── Delete: Sales requests it, only Admin-level access can actually
  // remove the plan — same pattern as Student deletion elsewhere. ──────────

  async requestDeletePlan(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { reason } = req.body;
      const plan = await prisma.feePaymentPlan.findUnique({ where: { id: req.params.id } });
      if (!plan) throw new AppError('Fee plan not found', 404);
      if (plan.deletionRequestedAt) {
        throw new AppError('A deletion request for this plan is already pending admin approval.', 409);
      }
      await prisma.feePaymentPlan.update({
        where: { id: req.params.id },
        data: {
          deletionRequestedAt: new Date(),
          deletionRequestedById: req.user?.employeeId || null,
          deletionReason: (reason && String(reason).trim()) || null,
        },
      });
      res.json({ success: true, message: 'Deletion request submitted for admin approval.' });
    } catch (err) { next(err); }
  },

  async listDeletionRequests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const plans = await prisma.feePaymentPlan.findMany({
        where: { deletionRequestedAt: { not: null } },
        include: { ...planInclude, deletionRequestedBy: { select: employeeSelect } },
        orderBy: { deletionRequestedAt: 'desc' },
      });
      res.json({ success: true, data: plans });
    } catch (err) { next(err); }
  },

  async approveDeletePlan(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const plan = await prisma.feePaymentPlan.findUnique({
        where: { id: req.params.id },
        include: { lead: { select: { name: true, phone: true } }, installments: { where: { status: 'PAID' } } },
      });
      if (!plan) throw new AppError('Fee plan not found', 404);
      if (!plan.deletionRequestedAt) throw new AppError('This plan has no pending deletion request.', 409);

      const totalPaid = plan.installments.reduce((sum, i) => sum + i.amount, 0);

      await prisma.$transaction([
        // Snapshot first — the plan row (and the requester/approver info
        // living on it) is about to be gone for good.
        prisma.feePlanDeletionLog.create({
          data: {
            planId: plan.id,
            leadName: plan.lead.name,
            leadPhone: plan.lead.phone,
            courseName: plan.courseName,
            totalFee: plan.totalFee,
            planType: plan.planType,
            status: plan.status,
            totalPaid,
            deletionReason: plan.deletionReason,
            requestedAt: plan.deletionRequestedAt,
            requestedById: plan.deletionRequestedById,
            approvedById: req.user?.employeeId,
          },
        }),
        // Cascades to FeeInstallment/FeeReminderLog. FeeCollection ledger
        // rows are left in place (nothing references them from this side)
        // so the Collections Ledger / stats history stays intact even after
        // the plan itself is gone.
        prisma.feePaymentPlan.delete({ where: { id: req.params.id } }),
      ]);
      res.json({ success: true, message: 'Fee plan deleted.' });
    } catch (err) { next(err); }
  },

  /** Permanent audit trail of deleted fee declarations — the plan rows
   * themselves are gone, this reads from the snapshot log instead. */
  async listDeletionLog(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const logs = await prisma.feePlanDeletionLog.findMany({
        include: {
          requestedBy: { select: employeeSelect },
          approvedBy: { select: employeeSelect },
        },
        orderBy: { approvedAt: 'desc' },
        take: 200,
      });
      res.json({ success: true, data: logs });
    } catch (err) { next(err); }
  },

  async rejectDeletePlan(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const plan = await prisma.feePaymentPlan.findUnique({ where: { id: req.params.id } });
      if (!plan) throw new AppError('Fee plan not found', 404);
      if (!plan.deletionRequestedAt) throw new AppError('This plan has no pending deletion request.', 409);
      await prisma.feePaymentPlan.update({
        where: { id: req.params.id },
        data: { deletionRequestedAt: null, deletionRequestedById: null, deletionReason: null },
      });
      res.json({ success: true, message: 'Deletion request rejected.' });
    } catch (err) { next(err); }
  },
};
