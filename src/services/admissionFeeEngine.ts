/**
 * Centralized Admission Fee Calculation Engine.
 *
 * Every screen that needs to show or charge a fee — New Admission, Admission
 * Edit, the Payment screen, the EMI screen, the receipt, reports, the
 * Admission Summary — MUST call into this file rather than recomputing
 * anything itself. That's the whole point of it existing: one calculation,
 * used everywhere, so the number Sales sees, Finance sees, and the receipt
 * prints are always the same number.
 *
 * Money handling: the rest of this codebase stores monetary fields as
 * `Float` (MySQL DOUBLE) throughout — SalaryStructure, Payslip, AdminExpense,
 * FeePaymentPlan.totalFee, etc. Converting all of that to DECIMAL is a much
 * bigger, separate migration and out of scope for the Admission module
 * alone, so these new fields stay Float for consistency with everything
 * else already in this schema. What actually prevents rounding drift is
 * doing every intermediate calculation in integer PAISE (rupees * 100) and
 * only converting back to a rupee float at the very end — see `roundMoney`
 * and `splitIntoInstallments` below. The last installment always absorbs
 * whatever paisa is left over, per spec, so the parts always sum exactly to
 * the whole.
 */
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';

export type PaymentMethod = 'SPOT' | 'FULL' | 'PART' | 'EMI';

export interface CalculateFeeInput {
  courseId: string;
  track: string; // StudentTrack value, e.g. "JRP_RECORDED"
  scheduleId?: string; // needed to check the EMI batch-start-date cutoff and coupon schedule-scoping
  couponCode?: string;
  paymentMethod: PaymentMethod;
  emiMonths?: number; // required when paymentMethod === 'EMI'
  salespersonId?: string; // for per-salesperson coupon usage limits
}

export interface FeeBreakdown {
  courseId: string;
  track: string;
  baseFee: number;
  couponCode: string | null;
  couponDiscount: number;
  netCourseFee: number; // baseFee - couponDiscount
  paymentMethod: PaymentMethod;

  // SPOT / FULL only
  paymentDiscountPct?: number;
  paymentDiscountAmount?: number;
  finalPayable?: number; // SPOT/FULL: what's due right now, in full

  // PART only
  registrationFee?: number;
  orientationBalance?: number;

  // EMI only
  interestRatePct?: number;
  interestAmount?: number;
  emiTotal?: number;
  downPaymentPct?: number;
  downPayment?: number;
  emiBalance?: number;
  emiMonths?: number;
  monthlyInstallments?: number[]; // length === emiMonths, last one absorbs rounding
}

/** rupees, rounded to 2 decimals — the only place a float rounding happens */
function roundMoney(rupees: number): number {
  return Math.round(rupees * 100) / 100;
}

/**
 * Splits `totalRupees` into `count` installments that sum EXACTLY to
 * totalRupees, with every installment equal except the last, which absorbs
 * whatever paisa remainder the even split left over. Done in integer paise
 * so there's no floating-point drift to accumulate across installments.
 */
export function splitIntoInstallments(totalRupees: number, count: number): number[] {
  if (count < 1) throw new AppError('Installment count must be at least 1', 400);
  const totalPaise = Math.round(totalRupees * 100);
  const basePaise = Math.floor(totalPaise / count);
  const remainderPaise = totalPaise - basePaise * count;
  const installments: number[] = [];
  for (let i = 0; i < count; i++) {
    const paise = i === count - 1 ? basePaise + remainderPaise : basePaise;
    installments.push(paise / 100);
  }
  return installments;
}

/** Fetches the currently-configured Admission business rules — never hard-coded. */
export async function getAdmissionConfig() {
  const config = await prisma.admissionConfig.findUnique({ where: { id: 'default' } });
  if (!config) throw new AppError('Admission configuration has not been set up yet.', 500);
  return config;
}

/** Max EMI months allowed for a track, per the admin-configured limits. */
export function getTrackEmiLimit(config: { trackEmiMonthLimits: unknown }, track: string): number {
  const limits = config.trackEmiMonthLimits as Record<string, number>;
  const limit = limits?.[track];
  if (typeof limit !== 'number') {
    throw new AppError(`No EMI month limit configured for track ${track}.`, 400);
  }
  return limit;
}

/** The latest active CourseTrackFee row for a course+track, as of today. */
export async function getBaseFee(courseId: string, track: string): Promise<number> {
  const row = await prisma.courseTrackFee.findFirst({
    where: { courseId, track: track as any, isActive: true, effectiveDate: { lte: new Date() } },
    orderBy: { effectiveDate: 'desc' },
  });
  if (!row) {
    throw new AppError(`No fee is configured for this course/track combination yet. Ask an admin to set one up under Admission → Course Fees.`, 400);
  }
  return row.baseFee;
}

/**
 * Validates a coupon against course/track/batch/expiry/usage-limit rules
 * and returns the rupee discount it should apply against `netFeeBeforeCoupon`.
 * Throws AppError with a clear reason on any failed check — callers should
 * surface `err.message` directly to the salesperson.
 */
export async function validateAndPriceCoupon(opts: {
  code: string;
  courseId: string;
  track: string;
  scheduleId?: string;
  netFeeBeforeCoupon: number;
  salespersonId?: string;
}): Promise<{ couponId: string; discount: number }> {
  const coupon = await prisma.coupon.findUnique({ where: { code: opts.code.trim().toUpperCase() } });
  if (!coupon) throw new AppError('Invalid coupon code.', 400);
  if (coupon.status !== 'ACTIVE') throw new AppError('This coupon is not active.', 400);

  const now = new Date();
  if (now < coupon.validFrom) throw new AppError('This coupon is not valid yet.', 400);
  if (now > coupon.validUntil) throw new AppError('This coupon has expired.', 400);

  if (coupon.courseId && coupon.courseId !== opts.courseId) {
    throw new AppError('This coupon does not apply to the selected course.', 400);
  }
  if (coupon.track && coupon.track !== (opts.track as any)) {
    throw new AppError('This coupon does not apply to the selected track.', 400);
  }
  if (coupon.scheduleId && opts.scheduleId && coupon.scheduleId !== opts.scheduleId) {
    throw new AppError('This coupon does not apply to the selected batch.', 400);
  }

  if (coupon.minimumFee != null && opts.netFeeBeforeCoupon < coupon.minimumFee) {
    throw new AppError(`This coupon requires a minimum fee of ₹${coupon.minimumFee}.`, 400);
  }

  if (coupon.maxUsage != null) {
    const totalUsage = await prisma.couponUsage.count({ where: { couponId: coupon.id } });
    if (totalUsage >= coupon.maxUsage) throw new AppError('This coupon has reached its maximum usage limit.', 400);
  }
  if (coupon.perSalespersonUsageLimit != null && opts.salespersonId) {
    const personUsage = await prisma.couponUsage.count({ where: { couponId: coupon.id, salespersonId: opts.salespersonId } });
    if (personUsage >= coupon.perSalespersonUsageLimit) {
      throw new AppError('You have reached your personal usage limit for this coupon.', 400);
    }
  }

  let discount =
    coupon.discountType === 'FIXED' ? coupon.discountValue : opts.netFeeBeforeCoupon * (coupon.discountValue / 100);
  if (coupon.maximumDiscount != null) discount = Math.min(discount, coupon.maximumDiscount);
  discount = Math.min(discount, opts.netFeeBeforeCoupon); // never discount below zero
  return { couponId: coupon.id, discount: roundMoney(discount) };
}

/**
 * The single source of truth for "what does this admission cost" — used by
 * both POST /api/admissions/calculate-fee (live calculator) and
 * POST /api/admissions (create), so the number shown before confirming is
 * guaranteed identical to the number actually charged.
 */
export async function calculateFee(input: CalculateFeeInput): Promise<FeeBreakdown> {
  const config = await getAdmissionConfig();
  const baseFee = await getBaseFee(input.courseId, input.track);

  let couponDiscount = 0;
  let couponCode: string | null = null;
  if (input.couponCode) {
    const priced = await validateAndPriceCoupon({
      code: input.couponCode,
      courseId: input.courseId,
      track: input.track,
      scheduleId: input.scheduleId,
      netFeeBeforeCoupon: baseFee,
      salespersonId: input.salespersonId,
    });
    couponDiscount = priced.discount;
    couponCode = input.couponCode.trim().toUpperCase();
  }

  const netCourseFee = roundMoney(baseFee - couponDiscount);

  const breakdown: FeeBreakdown = {
    courseId: input.courseId,
    track: input.track,
    baseFee,
    couponCode,
    couponDiscount,
    netCourseFee,
    paymentMethod: input.paymentMethod,
  };

  switch (input.paymentMethod) {
    case 'SPOT': {
      const pct = config.spotDiscountPct;
      const discountAmount = roundMoney(netCourseFee * (pct / 100));
      breakdown.paymentDiscountPct = pct;
      breakdown.paymentDiscountAmount = discountAmount;
      breakdown.finalPayable = roundMoney(netCourseFee - discountAmount);
      return breakdown;
    }

    case 'FULL': {
      const pct = config.fullDiscountPct;
      const discountAmount = roundMoney(netCourseFee * (pct / 100));
      breakdown.paymentDiscountPct = pct;
      breakdown.paymentDiscountAmount = discountAmount;
      breakdown.finalPayable = roundMoney(netCourseFee - discountAmount);
      return breakdown;
    }

    case 'PART': {
      const registrationFee = config.registrationFee;
      breakdown.registrationFee = registrationFee;
      breakdown.orientationBalance = roundMoney(netCourseFee - registrationFee);
      return breakdown;
    }

    case 'EMI': {
      const months = input.emiMonths;
      if (!months || months < 1) throw new AppError('EMI duration is required.', 400);

      const limit = getTrackEmiLimit(config, input.track);
      if (months > limit) {
        throw new AppError(`${input.track} allows a maximum EMI duration of ${limit} months.`, 400);
      }

      if (input.scheduleId) {
        const schedule = await prisma.batchCourseSchedule.findUnique({ where: { id: input.scheduleId } });
        if (schedule && new Date() >= schedule.startDate) {
          throw new AppError('EMI cannot be initiated after the batch has started.', 400);
        }
      }

      const interestPct = months <= 4 ? config.emiInterest3To4MonthPct : config.emiInterest5PlusMonthPct;
      const interestAmount = roundMoney(netCourseFee * (interestPct / 100));
      const emiTotal = roundMoney(netCourseFee + interestAmount);
      const downPayment = roundMoney(emiTotal * (config.downPaymentPct / 100));
      const emiBalance = roundMoney(emiTotal - downPayment);

      breakdown.interestRatePct = interestPct;
      breakdown.interestAmount = interestAmount;
      breakdown.emiTotal = emiTotal;
      breakdown.downPaymentPct = config.downPaymentPct;
      breakdown.downPayment = downPayment;
      breakdown.emiBalance = emiBalance;
      breakdown.emiMonths = months;
      breakdown.monthlyInstallments = splitIntoInstallments(emiBalance, months);
      return breakdown;
    }

    default:
      throw new AppError('Unknown payment method.', 400);
  }
}

// ─── Seat locking ─────────────────────────────────────────────────────────

/**
 * Locks the BatchCourseSchedule row for the duration of the transaction
 * (`SELECT ... FOR UPDATE`) so two salespeople confirming an admission into
 * the same schedule at the same moment are serialized — the second one to
 * reach this point re-counts seats AFTER the first has committed, not
 * against a stale number read before either transaction started. Must be
 * called from inside a `prisma.$transaction(async (tx) => { ... })` block,
 * and the caller must pass that same `tx` in.
 *
 * "Booked" is always counted live (admissionStatus not in
 * CANCELLED/REFUNDED/DRAFT), never a cached counter column, for the same
 * reason the onboarding-status fix earlier removed a cached/self-healing
 * flag: a stored count can drift from reality, a live count cannot.
 */
export async function reserveSeat(tx: Prisma.TransactionClient, scheduleId: string): Promise<void> {
  const locked = await tx.$queryRaw<Array<{ id: string; capacity: number | null }>>`
    SELECT id, capacity FROM BatchCourseSchedule WHERE id = ${scheduleId} FOR UPDATE
  `;
  const schedule = locked[0];
  if (!schedule) throw new AppError('Batch/schedule not found.', 404);
  if (schedule.capacity == null) return; // no cap configured — unlimited seats

  const booked = await tx.feePaymentPlan.count({
    where: {
      scheduleId,
      admissionStatus: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] },
    },
  });

  if (booked >= schedule.capacity) {
    throw new AppError('This batch is now full. Please select another batch.', 409);
  }
}

/** Live seat-availability for one schedule — used by the Upcoming Batches screen. */
export async function getSeatAvailability(scheduleId: string) {
  const schedule = await prisma.batchCourseSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw new AppError('Batch/schedule not found.', 404);
  const booked = await prisma.feePaymentPlan.count({
    where: { scheduleId, admissionStatus: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] } },
  });
  const total = schedule.capacity ?? null;
  let available: number | null = null;
  let status: 'OPEN' | 'LIMITED' | 'ALMOST_FULL' | 'FULL' = 'OPEN';
  if (total != null) {
    available = Math.max(0, total - booked);
    const pctBooked = total === 0 ? 1 : booked / total;
    if (available <= 0) status = 'FULL';
    else if (pctBooked >= 0.9) status = 'ALMOST_FULL';
    else if (pctBooked >= 0.75) status = 'LIMITED';
  }
  return { scheduleId, total, booked, available, status };
}

// ─── Foreclosure ──────────────────────────────────────────────────────────

export interface ForeclosureResult {
  policyApplied: string;
  paidSoFar: number;
  foreclosureAmount: number;
  emiPaidCount: number;
}

/**
 * Case 1 (no EMI installment paid yet) vs Case 2 (>=1 EMI paid) is decided
 * here by checking installments, per AdmissionConfig's two configurable
 * policies — never hard-coded, and never "just remove interest because the
 * student wants to close early" regardless of case, per spec section 26.
 */
export async function calculateForeclosure(admissionId: string): Promise<ForeclosureResult> {
  const plan = await prisma.feePaymentPlan.findUnique({
    where: { id: admissionId },
    include: { installments: true },
  });
  if (!plan) throw new AppError('Admission not found.', 404);
  if (plan.planType !== 'EMI') throw new AppError('Foreclosure only applies to EMI admissions.', 400);

  const config = await getAdmissionConfig();
  const installments: Array<{ status: string; kind: string | null; amount: number }> = plan.installments;
  const paidInstallments = installments.filter((i) => i.status === 'PAID');
  const emiPaidCount = paidInstallments.filter((i) => i.kind === 'EMI').length;
  const paidSoFar = roundMoney(paidInstallments.reduce((sum: number, i) => sum + i.amount, 0));

  const policy = emiPaidCount === 0 ? config.foreclosureBeforeFirstEmiPolicy : config.foreclosureAfterFirstEmiPolicy;
  const netCourseFee = roundMoney((plan.totalFee ?? 0) - (plan.couponDiscount ?? 0));
  const emiTotal = plan.interestAmount != null ? roundMoney(netCourseFee + plan.interestAmount) : netCourseFee;

  let payableTotal: number;
  if (policy === 'NO_INTEREST') {
    payableTotal = netCourseFee;
  } else if (policy === 'PRORATED' && plan.emiMonths) {
    const elapsedFraction = Math.min(1, emiPaidCount / plan.emiMonths);
    const interest = plan.interestAmount ?? 0;
    payableTotal = roundMoney(netCourseFee + interest * elapsedFraction);
  } else {
    // FULL_INTEREST (default/fallback)
    payableTotal = emiTotal;
  }

  const foreclosureAmount = roundMoney(Math.max(0, payableTotal - paidSoFar));
  return { policyApplied: policy, paidSoFar, foreclosureAmount, emiPaidCount };
}
