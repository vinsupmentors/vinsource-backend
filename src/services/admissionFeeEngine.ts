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

export const MAX_COUPONS_PER_ADMISSION = 3;

export interface CalculateFeeInput {
  courseId: string;
  track: string; // StudentTrack value, e.g. "JRP_RECORDED"
  scheduleId?: string; // needed to check the EMI batch-start-date cutoff and coupon schedule-scoping
  couponCodes?: string[]; // up to MAX_COUPONS_PER_ADMISSION, stacked
  paymentMethod: PaymentMethod;
  emiMonths?: number; // required when paymentMethod === 'EMI'
  salespersonId?: string; // for per-salesperson coupon usage limits
  // PART only — Sales enters whatever registration amount suits the
  // student's situation instead of a fixed number; falls back to
  // AdmissionConfig.registrationFee (the admin-set default) when omitted.
  // Must be > 0 and can't exceed the net course fee.
  registrationFee?: number;
}

export interface FeeBreakdown {
  courseId: string;
  track: string;
  baseFee: number;
  // Up to 3 coupons can be stacked on one admission — each is validated and
  // priced independently against the ORIGINAL baseFee (not sequentially),
  // then their discounts are summed into couponDiscount below.
  couponCodes: string[];
  couponBreakdown: { couponId: string; code: string; discount: number }[];
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

/**
 * Max EMI months for a track, checking the course's own override first
 * (AcademyCourse.emiMonthLimits) before falling back to the global
 * AdmissionConfig value. Lets one course (e.g. Dataverse) offer a longer
 * EMI window on a track than every other course, without changing the
 * global default for everyone else.
 */
export function resolveEmiLimit(
  track: string,
  courseEmiLimits: unknown,
  config: { trackEmiMonthLimits: unknown }
): number {
  const courseLimits = courseEmiLimits as Record<string, number> | null | undefined;
  const override = courseLimits?.[track];
  if (typeof override === 'number') return override;
  return getTrackEmiLimit(config, track);
}

/**
 * Interest % for an exact EMI tenure, from the admin-configured
 * emiInterestByMonth table (e.g. { "2": 3, "3": 5, "4": 7, "5": 10, "6": 10 }).
 * Falls back to the highest configured tenure at or below the requested one
 * if there's no exact entry — defensive only; in normal operation the
 * requested tenure is already capped by getTrackEmiLimit/resolveEmiLimit to
 * something the admin configured a rate for.
 */
export function getEmiInterestRate(config: { emiInterestByMonth: unknown }, months: number): number {
  const table = (config.emiInterestByMonth as Record<string, number>) || {};
  const direct = table[String(months)];
  if (typeof direct === 'number') return direct;
  const lowerTenures = Object.keys(table)
    .map(Number)
    .filter((m) => !Number.isNaN(m) && m <= months)
    .sort((a, b) => b - a);
  if (lowerTenures.length) return table[String(lowerTenures[0])];
  throw new AppError(`No EMI interest rate is configured for a ${months}-month tenure.`, 400);
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
  if (coupon.restrictedToEmployeeId && coupon.restrictedToEmployeeId !== opts.salespersonId) {
    throw new AppError('This coupon is restricted to a specific salesperson and cannot be applied by you.', 400);
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

  // Each coupon is validated and priced independently against the original
  // baseFee (not stacked sequentially off an already-reduced amount) — so
  // e.g. two 10%-off coupons together take 20% off the original fee, not
  // 10% then 10% of what's left. Their discounts are then summed and
  // capped so the total never exceeds the fee itself.
  let couponDiscount = 0;
  const couponBreakdown: { couponId: string; code: string; discount: number }[] = [];
  const requestedCodes = Array.from(
    new Set((input.couponCodes || []).map((c) => c.trim().toUpperCase()).filter(Boolean))
  );
  if (requestedCodes.length > MAX_COUPONS_PER_ADMISSION) {
    throw new AppError(`A maximum of ${MAX_COUPONS_PER_ADMISSION} coupons can be applied to one admission.`, 400);
  }
  for (const code of requestedCodes) {
    const priced = await validateAndPriceCoupon({
      code,
      courseId: input.courseId,
      track: input.track,
      scheduleId: input.scheduleId,
      netFeeBeforeCoupon: baseFee,
      salespersonId: input.salespersonId,
    });
    couponBreakdown.push({ couponId: priced.couponId, code, discount: priced.discount });
    couponDiscount += priced.discount;
  }
  couponDiscount = roundMoney(Math.min(couponDiscount, baseFee));

  const netCourseFee = roundMoney(baseFee - couponDiscount);

  const breakdown: FeeBreakdown = {
    courseId: input.courseId,
    track: input.track,
    baseFee,
    couponCodes: couponBreakdown.map((c) => c.code),
    couponBreakdown,
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
      // Sales can enter whatever registration amount fits the student's
      // situation instead of a fixed number — falls back to the
      // admin-configured default (AdmissionConfig.registrationFee) when not
      // provided, so old callers and the Config tab's default keep working.
      let registrationFee = config.registrationFee;
      if (input.registrationFee != null) {
        registrationFee = roundMoney(Number(input.registrationFee));
        if (!(registrationFee > 0)) {
          throw new AppError('Registration fee must be a positive amount.', 400);
        }
        if (registrationFee > netCourseFee) {
          throw new AppError(`Registration fee can't exceed the net course fee (${netCourseFee}).`, 400);
        }
      }
      breakdown.registrationFee = registrationFee;
      breakdown.orientationBalance = roundMoney(netCourseFee - registrationFee);
      return breakdown;
    }

    case 'EMI': {
      const months = input.emiMonths;
      if (!months || months < 1) throw new AppError('EMI duration is required.', 400);

      const courseForEmi = await prisma.academyCourse.findUnique({
        where: { id: input.courseId },
        select: { emiMonthLimits: true },
      });
      const limit = resolveEmiLimit(input.track, courseForEmi?.emiMonthLimits, config);
      if (months > limit) {
        throw new AppError(`${input.track} allows a maximum EMI duration of ${limit} months.`, 400);
      }

      if (input.scheduleId) {
        const schedule = await prisma.batchCourseSchedule.findUnique({ where: { id: input.scheduleId } });
        if (schedule && new Date() >= schedule.startDate) {
          throw new AppError('EMI cannot be initiated after the batch has started.', 400);
        }
      }

      // Down payment is a flat % of the course fee itself — interest is
      // then charged only on what's left to finance (the remaining
      // balance), never on the full fee. (This used to compute interest
      // on the full fee first and take the down payment as a % of
      // fee-plus-interest — fixed per Gaurav's Sept 2026 interest slab.)
      const downPayment = roundMoney(netCourseFee * (config.downPaymentPct / 100));
      const financedAmount = roundMoney(netCourseFee - downPayment);

      const interestPct = getEmiInterestRate(config, months);
      const interestAmount = roundMoney(financedAmount * (interestPct / 100));
      const emiTotal = roundMoney(netCourseFee + interestAmount);
      const emiBalance = roundMoney(emiTotal - downPayment); // = financedAmount + interestAmount — the part actually split into monthly installments

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

export type SeatStatus = 'OPEN' | 'LIMITED' | 'ALMOST_FULL' | 'FULL';

export interface SeatBand {
  rawTotal: number | null; // real physical/online room capacity, unadjusted
  held: number; // seats genuinely withheld from booking right now (e.g. reserved for a pending college enrollment)
  total: number | null; // bookable total = rawTotal - held — what "available" and the booking lock are computed against
  booked: number;
  available: number | null;
  status: SeatStatus;
  /** Real-count-based urgency copy — "Only 1 seat left!", "12 seats available", etc. Reflects genuinely bookable seats only — never a fabricated number, and a hold is a real, admin-set withholding, not a display trick. */
  label: string;
}

export interface SeatAvailability extends SeatBand {
  scheduleId: string;
  mode: 'ONLINE' | 'OFFLINE' | 'HYBRID';
  /** Present only when mode === 'HYBRID' — the same numbers broken out per delivery mode. */
  online?: SeatBand;
  offline?: SeatBand;
}

function computeBand(rawTotal: number | null, held: number, booked: number): SeatBand {
  if (rawTotal == null) {
    return { rawTotal: null, held, total: null, booked, available: null, status: 'OPEN', label: 'Unlimited seats' };
  }
  const total = Math.max(0, rawTotal - held);
  const available = Math.max(0, total - booked);
  const pctBooked = total === 0 ? 1 : booked / total;
  let status: SeatStatus;
  let label: string;
  if (available <= 0) {
    status = 'FULL';
    label = held > 0 ? 'Sold out (some seats held back)' : 'Sold out';
  } else if (available === 1) {
    status = 'ALMOST_FULL';
    label = 'Only 1 seat left!';
  } else if (available <= 3) {
    status = 'ALMOST_FULL';
    label = `Only ${available} seats left`;
  } else if (pctBooked >= 0.75) {
    status = 'LIMITED';
    label = `Filling fast — ${available} seats left`;
  } else {
    status = 'OPEN';
    label = `${available} seats available`;
  }
  return { rawTotal, held, total, booked, available, status, label };
}

/**
 * Locks the BatchCourseSchedule row for the duration of the transaction
 * (`SELECT ... FOR UPDATE`) so two salespeople confirming an admission into
 * the same schedule at the same moment are serialized — the second one to
 * reach this point re-counts seats AFTER the first has committed, not
 * against a stale number read before either transaction started. Must be
 * called from inside a `prisma.$transaction(async (tx) => { ... })` block,
 * and the caller must pass that same `tx` in.
 *
 * `deliveryMode` is required when the schedule is HYBRID (the admission must
 * say which seat pool — Online or Offline — it's booking into) and ignored
 * otherwise, since an ONLINE-only/OFFLINE-only schedule's mode already says
 * which one it is.
 *
 * "Booked" is always counted live (admissionStatus not in
 * CANCELLED/REFUNDED/DRAFT), never a cached counter column, for the same
 * reason the onboarding-status fix earlier removed a cached/self-healing
 * flag: a stored count can drift from reality, a live count cannot.
 */
export async function reserveSeat(
  tx: Prisma.TransactionClient,
  scheduleId: string,
  deliveryMode?: 'ONLINE' | 'OFFLINE' | 'HYBRID'
): Promise<void> {
  const locked = await tx.$queryRaw<
    Array<{
      id: string; mode: string;
      capacity: number | null; onlineCapacity: number | null; offlineCapacity: number | null;
      heldSeats: number | null; heldOnlineSeats: number | null; heldOfflineSeats: number | null;
    }>
  >`
    SELECT id, mode, capacity, onlineCapacity, offlineCapacity, heldSeats, heldOnlineSeats, heldOfflineSeats
    FROM BatchCourseSchedule WHERE id = ${scheduleId} FOR UPDATE
  `;
  const schedule = locked[0];
  if (!schedule) throw new AppError('Batch/schedule not found.', 404);

  if (schedule.mode === 'HYBRID') {
    if (deliveryMode !== 'ONLINE' && deliveryMode !== 'OFFLINE') {
      throw new AppError('This is a Hybrid batch — please choose Online or Offline for this admission.', 400);
    }
    const rawCap = deliveryMode === 'ONLINE' ? schedule.onlineCapacity : schedule.offlineCapacity;
    if (rawCap == null) return; // no cap configured for this pool — unlimited
    const held = (deliveryMode === 'ONLINE' ? schedule.heldOnlineSeats : schedule.heldOfflineSeats) ?? 0;
    const cap = Math.max(0, rawCap - held);
    const booked = await tx.feePaymentPlan.count({
      where: { scheduleId, deliveryMode, admissionStatus: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] } },
    });
    if (booked >= cap) {
      throw new AppError(`This batch's ${deliveryMode === 'ONLINE' ? 'Online' : 'Offline'} seats are now full. Please select another batch or mode.`, 409);
    }
    return;
  }

  if (schedule.capacity == null) return; // no cap configured — unlimited seats
  const cap = Math.max(0, schedule.capacity - (schedule.heldSeats ?? 0));
  const booked = await tx.feePaymentPlan.count({
    where: { scheduleId, admissionStatus: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] } },
  });
  if (booked >= cap) {
    throw new AppError('This batch is now full. Please select another batch.', 409);
  }
}

/** Live seat-availability for one schedule — used by the Upcoming Batches screen and the New Admission batch picker. */
export async function getSeatAvailability(scheduleId: string): Promise<SeatAvailability> {
  const schedule = await prisma.batchCourseSchedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) throw new AppError('Batch/schedule not found.', 404);

  if (schedule.mode === 'HYBRID') {
    const [onlineBooked, offlineBooked] = await Promise.all([
      prisma.feePaymentPlan.count({ where: { scheduleId, deliveryMode: 'ONLINE', admissionStatus: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] } } }),
      prisma.feePaymentPlan.count({ where: { scheduleId, deliveryMode: 'OFFLINE', admissionStatus: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] } } }),
    ]);
    const heldOnline = schedule.heldOnlineSeats ?? 0;
    const heldOffline = schedule.heldOfflineSeats ?? 0;
    const online = computeBand(schedule.onlineCapacity, heldOnline, onlineBooked);
    const offline = computeBand(schedule.offlineCapacity, heldOffline, offlineBooked);
    const combinedRawTotal = schedule.onlineCapacity == null && schedule.offlineCapacity == null
      ? null
      : (schedule.onlineCapacity ?? 0) + (schedule.offlineCapacity ?? 0);
    const combined = computeBand(combinedRawTotal, heldOnline + heldOffline, onlineBooked + offlineBooked);
    return { scheduleId, mode: 'HYBRID', ...combined, online, offline };
  }

  const booked = await prisma.feePaymentPlan.count({
    where: { scheduleId, admissionStatus: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] } },
  });
  const band = computeBand(schedule.capacity, schedule.heldSeats ?? 0, booked);
  return { scheduleId, mode: schedule.mode as 'ONLINE' | 'OFFLINE', ...band };
}

/**
 * Approves a SeatHoldRequest: verifies enough seats are actually still held
 * back for the requested pool, then lowers that hold by seatsRequested —
 * the release is real (the booking lock in reserveSeat reads the same
 * columns), not a display change.
 */
export async function approveSeatHoldRequest(requestId: string, respondedById?: string, responseNote?: string) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const request = await tx.seatHoldRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new AppError('Seat request not found.', 404);
    if (request.status !== 'PENDING') throw new AppError('This request has already been responded to.', 400);

    const locked = await tx.$queryRaw<Array<{ id: string; mode: string; heldSeats: number | null; heldOnlineSeats: number | null; heldOfflineSeats: number | null }>>`
      SELECT id, mode, heldSeats, heldOnlineSeats, heldOfflineSeats FROM BatchCourseSchedule WHERE id = ${request.scheduleId} FOR UPDATE
    `;
    const schedule = locked[0];
    if (!schedule) throw new AppError('Batch/schedule not found.', 404);

    if (schedule.mode === 'HYBRID') {
      const field = request.deliveryMode === 'ONLINE' ? 'heldOnlineSeats' : 'heldOfflineSeats';
      const current = (request.deliveryMode === 'ONLINE' ? schedule.heldOnlineSeats : schedule.heldOfflineSeats) ?? 0;
      if (current < request.seatsRequested) {
        throw new AppError(`Only ${current} seat(s) are currently held back for this pool — cannot release ${request.seatsRequested}.`, 400);
      }
      await tx.batchCourseSchedule.update({ where: { id: schedule.id }, data: { [field]: current - request.seatsRequested } });
    } else {
      const current = schedule.heldSeats ?? 0;
      if (current < request.seatsRequested) {
        throw new AppError(`Only ${current} seat(s) are currently held back — cannot release ${request.seatsRequested}.`, 400);
      }
      await tx.batchCourseSchedule.update({ where: { id: schedule.id }, data: { heldSeats: current - request.seatsRequested } });
    }

    return tx.seatHoldRequest.update({
      where: { id: requestId },
      data: { status: 'APPROVED', respondedById, respondedAt: new Date(), responseNote },
    });
  });
}

/** Rejects a pending SeatHoldRequest — no seats move, held count is untouched. */
export async function rejectSeatHoldRequest(requestId: string, respondedById?: string, responseNote?: string) {
  const request = await prisma.seatHoldRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new AppError('Seat request not found.', 404);
  if (request.status !== 'PENDING') throw new AppError('This request has already been responded to.', 400);
  return prisma.seatHoldRequest.update({
    where: { id: requestId },
    data: { status: 'REJECTED', respondedById, respondedAt: new Date(), responseNote },
  });
}

/**
 * Admin sets exactly how many seats are held back for a schedule (direct
 * set, not a delta) — e.g. "hold 4 of the 15 offline seats for a pending
 * college enrollment." Validated against the schedule's real raw capacity
 * so an admin can never hold back more seats than physically exist, and
 * against seats already booked so an existing admission can never be
 * silently squeezed out by a hold applied after the fact.
 */
export async function setHeldSeats(
  scheduleId: string,
  updates: { heldSeats?: number; heldOnlineSeats?: number; heldOfflineSeats?: number }
) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const locked = await tx.$queryRaw<
      Array<{ id: string; mode: string; capacity: number | null; onlineCapacity: number | null; offlineCapacity: number | null }>
    >`
      SELECT id, mode, capacity, onlineCapacity, offlineCapacity FROM BatchCourseSchedule WHERE id = ${scheduleId} FOR UPDATE
    `;
    const schedule = locked[0];
    if (!schedule) throw new AppError('Batch/schedule not found.', 404);

    const data: Record<string, number> = {};

    if (schedule.mode === 'HYBRID') {
      if (updates.heldOnlineSeats != null) {
        if (schedule.onlineCapacity == null) throw new AppError('This batch has no configured Online seat capacity to hold seats against.', 400);
        const onlineBooked = await tx.feePaymentPlan.count({ where: { scheduleId, deliveryMode: 'ONLINE', admissionStatus: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] } } });
        if (updates.heldOnlineSeats < 0 || schedule.onlineCapacity - updates.heldOnlineSeats < onlineBooked) {
          throw new AppError(`Cannot hold ${updates.heldOnlineSeats} Online seats — only ${schedule.onlineCapacity - onlineBooked} of ${schedule.onlineCapacity} are unbooked.`, 400);
        }
        data.heldOnlineSeats = updates.heldOnlineSeats;
      }
      if (updates.heldOfflineSeats != null) {
        if (schedule.offlineCapacity == null) throw new AppError('This batch has no configured Offline seat capacity to hold seats against.', 400);
        const offlineBooked = await tx.feePaymentPlan.count({ where: { scheduleId, deliveryMode: 'OFFLINE', admissionStatus: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] } } });
        if (updates.heldOfflineSeats < 0 || schedule.offlineCapacity - updates.heldOfflineSeats < offlineBooked) {
          throw new AppError(`Cannot hold ${updates.heldOfflineSeats} Offline seats — only ${schedule.offlineCapacity - offlineBooked} of ${schedule.offlineCapacity} are unbooked.`, 400);
        }
        data.heldOfflineSeats = updates.heldOfflineSeats;
      }
    } else if (updates.heldSeats != null) {
      if (schedule.capacity == null) throw new AppError('This batch has no configured seat capacity to hold seats against.', 400);
      const booked = await tx.feePaymentPlan.count({ where: { scheduleId, admissionStatus: { notIn: ['CANCELLED', 'REFUNDED', 'DRAFT'] } } });
      if (updates.heldSeats < 0 || schedule.capacity - updates.heldSeats < booked) {
        throw new AppError(`Cannot hold ${updates.heldSeats} seats — only ${schedule.capacity - booked} of ${schedule.capacity} are unbooked.`, 400);
      }
      data.heldSeats = updates.heldSeats;
    }

    if (Object.keys(data).length === 0) return schedule;
    return tx.batchCourseSchedule.update({ where: { id: scheduleId }, data });
  });
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
