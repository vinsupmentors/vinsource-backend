import { Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { getEffectiveAccess } from '../utils/moduleAccess';
import { generateSubBatchCode } from './production.controller';
import {
  calculateFee,
  getAdmissionConfig,
  getSeatAvailability,
  reserveSeat,
  validateAndPriceCoupon,
  setHeldSeats,
  approveSeatHoldRequest,
  rejectSeatHoldRequest,
  type CalculateFeeInput,
} from '../services/admissionFeeEngine';

/** True if this caller has ADMIN-level ADMISSION access (coupons/course fees/config/all-admissions are admin-only). */
async function isAdmissionAdmin(req: AuthRequest): Promise<boolean> {
  if (!req.user) return false;
  if (req.user.role === 'SUPER_ADMIN') return true;
  const access = await getEffectiveAccess(req.user.userId);
  return access.ADMISSION === 'ADMIN';
}

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };
const leadSelect = { id: true, name: true, phone: true, email: true, city: true, assignedToId: true };

const admissionInclude = {
  lead: { select: leadSelect },
  createdBy: { select: employeeSelect },
  course: { select: { id: true, name: true } },
  schedule: { select: { id: true, code: true, timing: true, startTime: true, endTime: true, startDate: true, batch: { select: { id: true, code: true } } } },
  // couponUsages covers 0, 1, or up to 3 stacked coupons uniformly — prefer
  // this over the legacy singular `coupon` relation below when displaying
  // "what coupons applied here" (that one is only ever set for the
  // exactly-one-coupon case, kept for backward-compat filtering/joins).
  couponUsages: { include: { coupon: { select: { id: true, code: true, name: true } } } },
  coupon: { select: { id: true, code: true, name: true } },
  installments: {
    orderBy: { dueDate: 'asc' as const },
    include: { receivedBy: { select: employeeSelect } },
  },
};

/**
 * Payment status is deliberately NEVER stored — computed live off the
 * installments every time, exactly like onboarding status was fixed to do
 * after the earlier self-heal incident. A stored/cached status can drift
 * from reality; a live one cannot.
 */
function derivePaymentStatus(installments: Array<{ status: string; amount: number }>): string {
  if (installments.length === 0) return 'UNPAID';
  const paid = installments.filter((i) => i.status === 'PAID');
  const overdue = installments.some((i) => i.status === 'OVERDUE');
  if (overdue) return 'OVERDUE';
  if (paid.length === 0) return 'UNPAID';
  if (paid.length === installments.length) return 'PAID';
  return 'PARTIALLY_PAID';
}

function totalPaid(installments: Array<{ status: string; amount: number }>): number {
  return installments.filter((i) => i.status === 'PAID').reduce((sum, i) => sum + i.amount, 0);
}

async function nextAdmissionId(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.feePaymentPlan.count({ where: { admissionId: { not: null } } });
  let seq = count + 1;
  for (let attempt = 0; attempt < 25; attempt++) {
    const candidate = `ADM-${year}-${String(seq).padStart(6, '0')}`;
    // eslint-disable-next-line no-await-in-loop
    const exists = await prisma.feePaymentPlan.findUnique({ where: { admissionId: candidate } });
    if (!exists) return candidate;
    seq++;
  }
  return `ADM-${year}-${Date.now()}`;
}

function addMonths(date: Date, months: number): Date {
  const d = new Date(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/** "09:30" -> "9:30 AM" */
function formatTime(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h % 12 === 0 ? 12 : h % 12;
  return `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

/** Exact slot label when recorded, else the coarse bucket — mirrors the frontend's timingLabel(). */
function slotLabel(s: { timing: string; startTime: string | null; endTime: string | null }): string {
  if (s.startTime && s.endTime) return `${formatTime(s.startTime)} – ${formatTime(s.endTime)}`;
  return s.timing.charAt(0) + s.timing.slice(1).toLowerCase();
}

/**
 * Schedules that can still take a new admission: UPCOMING status AND an
 * actual start date that hasn't passed. `status` alone isn't trustworthy —
 * see the comment in listUpcomingBatches — so both this function and that
 * one apply the same live date check rather than one trusting a possibly
 * stale field the other double-checks.
 */
function openScheduleWhere(courseId?: string): Record<string, unknown> {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const where: Record<string, unknown> = { status: 'UPCOMING', startDate: { gte: startOfToday } };
  if (courseId) where.courseId = courseId;
  return where;
}

export const admissionController = {
  // ── Fee Calculation Engine (live calculator) ─────────────────────────────

  async calculateFeeEndpoint(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { courseId, track, scheduleId, couponCodes, paymentMethod, emiMonths, registrationFee } = req.body as CalculateFeeInput;
      if (!courseId || !track || !paymentMethod) {
        throw new AppError('courseId, track, and paymentMethod are required', 400);
      }
      const breakdown = await calculateFee({
        courseId,
        track,
        scheduleId,
        couponCodes,
        paymentMethod,
        emiMonths: emiMonths ? Number(emiMonths) : undefined,
        registrationFee: registrationFee != null && registrationFee !== ('' as unknown) ? Number(registrationFee) : undefined,
        salespersonId: req.user?.employeeId,
      });
      res.json({ success: true, data: breakdown });
    } catch (err) { next(err); }
  },

  // ── Employees (for the employee-restricted coupon picker) ────────────────

  async searchEmployees(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.json({ success: true, data: [] });
      const employees = await prisma.employee.findMany({
        where: {
          OR: [
            { firstName: { contains: q } },
            { lastName: { contains: q } },
            { employeeCode: { contains: q } },
          ],
        },
        select: employeeSelect,
        take: 10,
      });
      res.json({ success: true, data: employees });
    } catch (err) { next(err); }
  },

  // ── Courses (for the New Admission course/track picker) ──────────────────

  async listCourses(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const courses = await prisma.academyCourse.findMany({
        where: { isActive: true },
        select: { id: true, name: true, emiMonthLimits: true },
        orderBy: { name: 'asc' },
      });
      res.json({ success: true, data: courses });
    } catch (err) { next(err); }
  },

  /** Admin-only: set/clear a course's per-track EMI month-limit override. */
  async updateCourseEmiLimits(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { emiMonthLimits } = req.body;
      const course = await prisma.academyCourse.update({
        where: { id: req.params.id },
        data: { emiMonthLimits: emiMonthLimits ?? Prisma.JsonNull },
        select: { id: true, name: true, emiMonthLimits: true },
      });
      res.json({ success: true, data: course });
    } catch (err) { next(err); }
  },

  // ── Upcoming Batches / seat availability ──────────────────────────────────

  async listUpcomingBatches(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { courseId, includeFull } = req.query;
      const schedules = await prisma.batchCourseSchedule.findMany({
        where: openScheduleWhere(courseId ? String(courseId) : undefined),
        include: {
          batch: { select: { id: true, code: true, startDate: true, status: true } },
          course: { select: { id: true, name: true } },
        },
        orderBy: { startDate: 'asc' },
      });

      const withSeats = await Promise.all(
        schedules.map(async (s: (typeof schedules)[number]) => ({
          ...s,
          seats: await getSeatAvailability(s.id),
        }))
      );

      // Default view for the admission flow's batch picker hides FULL
      // batches — pass ?includeFull=true for the admin batch-management
      // screen (Phase 3), which needs to show everything.
      const result = includeFull === 'true' ? withSeats : withSeats.filter((s: (typeof withSeats)[number]) => s.seats.status !== 'FULL');
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  async seatAvailability(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const data = await getSeatAvailability(req.params.scheduleId);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /** Existing (non-completed/cancelled) Batches, for the "add to an existing batch" picker in Create Batch. Admin only. */
  async listBatchGroups(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const batches = await prisma.batch.findMany({
        where: { status: { in: ['UPCOMING', 'ONGOING'] } },
        select: { id: true, code: true, status: true, startDate: true },
        orderBy: { startDate: 'desc' },
      });
      res.json({ success: true, data: batches });
    } catch (err) { next(err); }
  },

  /**
   * A deliberately lightweight batch/schedule creator scoped to what
   * Admission actually needs (course, timing, day pattern, mode, seats,
   * start date) — not the fuller Production batch-builder (trainers,
   * feedback forms, etc.), so a Sales-side admin without Production access
   * isn't blocked from opening a new intake batch. Either attaches a new
   * BatchCourseSchedule to an existing Batch (batchId) or creates a brand
   * new Batch on the fly (newBatchCode). Admin only.
   */
  async createBatchSchedule(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const {
        batchId, newBatchCode, courseId, startTime, endTime, dayPattern, mode,
        startDate, capacity, onlineCapacity, offlineCapacity,
      } = req.body;

      if (!courseId || !startTime || !endTime || !mode || !startDate) {
        throw new AppError('Course, start/end time, mode, and start date are required.', 400);
      }
      if (!batchId && !newBatchCode) {
        throw new AppError('Choose an existing batch or provide a name for a new one.', 400);
      }
      if (mode === 'HYBRID' && onlineCapacity == null && offlineCapacity == null) {
        throw new AppError('Enter seat counts for at least one of Online / Offline for a Hybrid batch.', 400);
      }

      // "Morning" now covers more than one real slot (e.g. 9:30-11:30 and
      // 12:00-2:00 are both run as separate Morning batches), so the coarse
      // BatchTiming bucket other modules key off is derived from the exact
      // start time rather than asked for directly — Admission always
      // records the real range, and the bucket is just what Production's
      // sub-batch-code convention and existing filters need underneath.
      const startHour = Number(String(startTime).split(':')[0]);
      const timing: 'MORNING' | 'AFTERNOON' | 'EVENING' =
        startHour < 12 ? 'MORNING' : startHour < 17 ? 'AFTERNOON' : 'EVENING';

      const resolvedBatchId = batchId || (await prisma.batch.create({
        data: { code: newBatchCode, startDate: new Date(startDate), createdById: req.user?.employeeId },
      })).id;

      const code = await generateSubBatchCode(prisma, resolvedBatchId, courseId, timing);

      const schedule = await prisma.batchCourseSchedule.create({
        data: {
          code,
          batchId: resolvedBatchId,
          courseId,
          timing,
          startTime, endTime,
          dayPattern: dayPattern || 'MON_SAT',
          mode,
          startDate: new Date(startDate),
          capacity: mode === 'HYBRID' ? undefined : (capacity != null ? Number(capacity) : undefined),
          onlineCapacity: mode === 'HYBRID' && onlineCapacity != null ? Number(onlineCapacity) : undefined,
          offlineCapacity: mode === 'HYBRID' && offlineCapacity != null ? Number(offlineCapacity) : undefined,
        },
        include: { batch: { select: { id: true, code: true } }, course: { select: { id: true, name: true } } },
      });

      if (req.user?.userId) {
        await prisma.auditLog.create({
          data: {
            userId: req.user.userId,
            action: 'CREATE',
            module: 'ADMISSION',
            entityId: schedule.id,
            entityType: 'BatchCourseSchedule',
            newData: schedule as object,
          },
        });
      }

      res.status(201).json({ success: true, data: { ...schedule, seats: await getSeatAvailability(schedule.id) } });
    } catch (err) { next(err); }
  },

  /**
   * Edit an existing batch schedule from the Admission side (Upcoming
   * Batches tab) — same lightweight scope as createBatchSchedule (timing,
   * day pattern, start date, seat capacity). Admin only.
   *
   * Delivery mode can only be changed while the schedule has zero bookings
   * in any pool — switching Hybrid <-> Online/Offline after students are
   * already enrolled against a specific pool would orphan their seat.
   * Capacity can be lowered, but never below what's already booked.
   */
  async updateBatchSchedule(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduleId } = req.params;
      const { startTime, endTime, dayPattern, mode, startDate, capacity, onlineCapacity, offlineCapacity } = req.body;

      const existing = await prisma.batchCourseSchedule.findUnique({ where: { id: scheduleId } });
      if (!existing) throw new AppError('Batch schedule not found', 404);

      const seats = await getSeatAvailability(scheduleId);
      const effectiveMode: 'ONLINE' | 'OFFLINE' | 'HYBRID' = mode || existing.mode;

      if (mode && mode !== existing.mode) {
        const totalBooked = existing.mode === 'HYBRID'
          ? (seats.online?.booked ?? 0) + (seats.offline?.booked ?? 0)
          : seats.booked ?? 0;
        if (totalBooked > 0) {
          throw new AppError('Cannot change delivery mode — students are already booked against this batch. Create a new batch instead.', 400);
        }
      }

      if (effectiveMode === 'HYBRID') {
        if (onlineCapacity !== undefined && onlineCapacity !== null && onlineCapacity !== '') {
          const newCap = Number(onlineCapacity);
          const booked = seats.online?.booked ?? 0;
          if (newCap < booked) throw new AppError(`Cannot set Online seats to ${newCap} — ${booked} are already booked.`, 400);
        }
        if (offlineCapacity !== undefined && offlineCapacity !== null && offlineCapacity !== '') {
          const newCap = Number(offlineCapacity);
          const booked = seats.offline?.booked ?? 0;
          if (newCap < booked) throw new AppError(`Cannot set Offline seats to ${newCap} — ${booked} are already booked.`, 400);
        }
      } else if (capacity !== undefined && capacity !== null && capacity !== '') {
        const newCap = Number(capacity);
        const booked = seats.booked ?? 0;
        if (newCap < booked) throw new AppError(`Cannot set seats to ${newCap} — ${booked} are already booked.`, 400);
      }

      const startHour = startTime ? Number(String(startTime).split(':')[0]) : null;
      const timing: 'MORNING' | 'AFTERNOON' | 'EVENING' | undefined =
        startHour == null ? undefined : startHour < 12 ? 'MORNING' : startHour < 17 ? 'AFTERNOON' : 'EVENING';

      const schedule = await prisma.batchCourseSchedule.update({
        where: { id: scheduleId },
        data: {
          startTime: startTime || undefined,
          endTime: endTime || undefined,
          timing,
          dayPattern: dayPattern || undefined,
          mode: mode || undefined,
          startDate: startDate ? new Date(startDate) : undefined,
          capacity: effectiveMode !== 'HYBRID'
            ? (capacity === '' ? null : capacity != null ? Number(capacity) : undefined)
            : null,
          onlineCapacity: effectiveMode === 'HYBRID'
            ? (onlineCapacity === '' ? null : onlineCapacity != null ? Number(onlineCapacity) : undefined)
            : null,
          offlineCapacity: effectiveMode === 'HYBRID'
            ? (offlineCapacity === '' ? null : offlineCapacity != null ? Number(offlineCapacity) : undefined)
            : null,
        },
        include: { batch: { select: { id: true, code: true } }, course: { select: { id: true, name: true } } },
      });

      if (req.user?.userId) {
        await prisma.auditLog.create({
          data: {
            userId: req.user.userId,
            action: 'EDIT',
            module: 'ADMISSION',
            entityId: scheduleId,
            entityType: 'BatchCourseSchedule',
            oldData: existing as object,
            newData: schedule as object,
          },
        });
      }

      res.json({ success: true, data: { ...schedule, seats: await getSeatAvailability(scheduleId) } });
    } catch (err) { next(err); }
  },

  /**
   * Batch Plan — a Course x (Offline/Online x time-slot) matrix of live
   * booked/capacity, e.g. "5/10" under DA -> Offline -> 9:30-11:30. Built
   * entirely from real, live-computed seat counts (the same
   * getSeatAvailability used everywhere else in Admission) — nothing here
   * is approximated or padded to look fuller or emptier than it is.
   */
  async getBatchPlan(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const schedules = await prisma.batchCourseSchedule.findMany({
        where: openScheduleWhere(),
        include: { course: { select: { id: true, name: true } } },
        orderBy: [{ courseId: 'asc' }, { startTime: 'asc' }, { timing: 'asc' }],
      });

      type Cell = { booked: number; total: number | null };
      const courseOrder: string[] = [];
      const courses: Record<string, { id: string; name: string }> = {};
      const offlineSlotOrder: string[] = [];
      const onlineSlotOrder: string[] = [];
      const matrix: Record<string, { offline: Record<string, Cell>; online: Record<string, Cell> }> = {};

      const addSlot = (list: string[], slot: string) => { if (!list.includes(slot)) list.push(slot); };
      const addCell = (courseId: string, side: 'offline' | 'online', slot: string, booked: number, total: number | null) => {
        if (!matrix[courseId]) matrix[courseId] = { offline: {}, online: {} };
        const existing = matrix[courseId][side][slot];
        if (existing) {
          matrix[courseId][side][slot] = {
            booked: existing.booked + booked,
            total: existing.total == null || total == null ? null : existing.total + total,
          };
        } else {
          matrix[courseId][side][slot] = { booked, total };
        }
      };

      for (const s of schedules) {
        if (!courses[s.courseId]) { courses[s.courseId] = s.course; courseOrder.push(s.courseId); }
        const slot = slotLabel(s);
        const seats = await getSeatAvailability(s.id); // eslint-disable-line no-await-in-loop

        if (s.mode === 'HYBRID' && seats.online && seats.offline) {
          addSlot(offlineSlotOrder, slot);
          addCell(s.courseId, 'offline', slot, seats.offline.booked, seats.offline.total);
          addSlot(onlineSlotOrder, slot);
          addCell(s.courseId, 'online', slot, seats.online.booked, seats.online.total);
        } else if (s.mode === 'OFFLINE') {
          addSlot(offlineSlotOrder, slot);
          addCell(s.courseId, 'offline', slot, seats.booked, seats.total);
        } else {
          addSlot(onlineSlotOrder, slot);
          addCell(s.courseId, 'online', slot, seats.booked, seats.total);
        }
      }

      res.json({
        success: true,
        data: {
          courses: courseOrder.map((id) => courses[id]),
          offlineSlots: offlineSlotOrder,
          onlineSlots: onlineSlotOrder,
          matrix,
        },
      });
    } catch (err) { next(err); }
  },

  // ── Seat hold-back & release requests ─────────────────────────────────────
  // Real, admin-controlled seat withholding (e.g. reserving offline seats
  // for a pending college enrollment) with a rep request / admin release
  // workflow — NOT a cosmetic "looks full" display. The hold is enforced
  // inside reserveSeat()'s transaction, so a held seat genuinely cannot be
  // booked until an admin approves its release.

  /** Admin sets exactly how many seats are held back for a schedule. */
  async setHeldSeatsEndpoint(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { heldSeats, heldOnlineSeats, heldOfflineSeats } = req.body;
      const updated = await setHeldSeats(req.params.scheduleId, {
        heldSeats: heldSeats != null ? Number(heldSeats) : undefined,
        heldOnlineSeats: heldOnlineSeats != null ? Number(heldOnlineSeats) : undefined,
        heldOfflineSeats: heldOfflineSeats != null ? Number(heldOfflineSeats) : undefined,
      });

      if (req.user?.userId) {
        await prisma.auditLog.create({
          data: {
            userId: req.user.userId,
            action: 'EDIT',
            module: 'ADMISSION',
            entityId: req.params.scheduleId,
            entityType: 'BatchCourseSchedule.held',
            newData: { heldSeats, heldOnlineSeats, heldOfflineSeats },
          },
        });
      }

      res.json({ success: true, data: { schedule: updated, seats: await getSeatAvailability(req.params.scheduleId) } });
    } catch (err) { next(err); }
  },

  /** A rep asks for N of the held-back seats to be released so they can book. */
  async createSeatHoldRequest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduleId, deliveryMode, seatsRequested, reason } = req.body;
      if (!scheduleId) throw new AppError('scheduleId is required.', 400);
      const schedule = await prisma.batchCourseSchedule.findUnique({ where: { id: scheduleId } });
      if (!schedule) throw new AppError('Batch/schedule not found.', 404);
      if (schedule.mode === 'HYBRID' && deliveryMode !== 'ONLINE' && deliveryMode !== 'OFFLINE') {
        throw new AppError('This is a Hybrid batch — please specify Online or Offline.', 400);
      }

      const request = await prisma.seatHoldRequest.create({
        data: {
          scheduleId,
          deliveryMode: schedule.mode === 'HYBRID' ? deliveryMode : undefined,
          seatsRequested: seatsRequested != null ? Number(seatsRequested) : 1,
          reason: reason || undefined,
          requestedById: req.user?.employeeId,
        },
        include: {
          schedule: { select: { id: true, code: true, mode: true, course: { select: { id: true, name: true } } } },
          requestedBy: { select: employeeSelect },
        },
      });
      res.status(201).json({ success: true, data: request });
    } catch (err) { next(err); }
  },

  /** Admin sees all requests (optionally filtered by status); a rep sees only their own, enforced server-side. */
  async listSeatHoldRequests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status, scheduleId } = req.query;
      const where: Record<string, unknown> = {};
      const admin = await isAdmissionAdmin(req);
      if (!admin) where.requestedById = req.user?.employeeId;
      if (status) where.status = String(status);
      if (scheduleId) where.scheduleId = String(scheduleId);

      const requests = await prisma.seatHoldRequest.findMany({
        where,
        include: {
          schedule: { select: { id: true, code: true, mode: true, timing: true, startTime: true, endTime: true, course: { select: { id: true, name: true } } } },
          requestedBy: { select: employeeSelect },
          respondedBy: { select: employeeSelect },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: requests });
    } catch (err) { next(err); }
  },

  async approveSeatHoldRequestEndpoint(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const updated = await approveSeatHoldRequest(req.params.id, req.user?.employeeId, req.body?.responseNote);
      if (req.user?.userId) {
        await prisma.auditLog.create({
          data: { userId: req.user.userId, action: 'EDIT', module: 'ADMISSION', entityId: req.params.id, entityType: 'SeatHoldRequest', newData: { status: 'APPROVED' } },
        });
      }
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  async rejectSeatHoldRequestEndpoint(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const updated = await rejectSeatHoldRequest(req.params.id, req.user?.employeeId, req.body?.responseNote);
      if (req.user?.userId) {
        await prisma.auditLog.create({
          data: { userId: req.user.userId, action: 'EDIT', module: 'ADMISSION', entityId: req.params.id, entityType: 'SeatHoldRequest', newData: { status: 'REJECTED' } },
        });
      }
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  // ── Admissions ─────────────────────────────────────────────────────────

  async createAdmission(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const {
        leadId: existingLeadId,
        newLead, // { name, phone, email, city, passedOutYear, degree, college, currentStatus }
        courseId,
        track,
        scheduleId,
        couponCodes,
        paymentMethod,
        emiMonths,
        registrationFee, // PART only — Sales-entered override of the config default
        deliveryMode, // 'ONLINE' | 'OFFLINE' — required only when the chosen schedule is HYBRID
        payment, // { amount, mode, collectedAt } — the amount actually collected right now (spot/full/registration/down payment)
      } = req.body;

      if (!courseId || !track || !scheduleId) throw new AppError('Course, track, and batch are required', 400);
      if (!paymentMethod) throw new AppError('Payment method is required', 400);

      const salespersonId = req.user?.employeeId;

      // The backend re-derives the whole fee breakdown itself — the
      // frontend's numbers are for display only, never trusted for the
      // actual charge (spec: "backend response should be treated as the
      // source of truth").
      const breakdown = await calculateFee({
        courseId,
        track,
        scheduleId,
        couponCodes,
        paymentMethod,
        emiMonths: emiMonths ? Number(emiMonths) : undefined,
        registrationFee: registrationFee != null && registrationFee !== '' ? Number(registrationFee) : undefined,
        salespersonId,
      });

      let leadId = existingLeadId as string | undefined;
      if (!leadId) {
        const name = (newLead?.name || '').trim();
        const phone = (newLead?.phone || '').trim();
        if (!name || !phone) throw new AppError('Student name and mobile number are required', 400);
        const lead = await prisma.lead.create({
          data: {
            name,
            phone,
            email: newLead?.email || undefined,
            city: newLead?.city || undefined,
            passedOutYear: newLead?.passedOutYear ? Number(newLead.passedOutYear) : undefined,
            educationQualification: newLead?.degree || undefined,
            collegeName: newLead?.college || undefined,
            currentStatus: newLead?.currentStatus || undefined,
            status: 'ENROLLED',
            courseInterest: track,
            assignedToId: salespersonId || undefined,
          },
        });
        leadId = lead.id;
      }

      const schedule = await prisma.batchCourseSchedule.findUnique({ where: { id: scheduleId } });
      if (!schedule) throw new AppError('Selected batch not found.', 404);
      if (schedule.mode === 'HYBRID' && deliveryMode !== 'ONLINE' && deliveryMode !== 'OFFLINE') {
        throw new AppError('This is a Hybrid batch — please choose Online or Offline for this admission.', 400);
      }

      const admissionId = await nextAdmissionId();
      const now = payment?.collectedAt ? new Date(payment.collectedAt) : new Date();
      const receivedById = salespersonId;
      const mode = payment?.mode || 'UPI';

      const created = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Lock the schedule row + re-check seats INSIDE the transaction —
        // the count above (if any) was only for display; this is the real,
        // race-safe check.
        await reserveSeat(tx, scheduleId, schedule.mode === 'HYBRID' ? deliveryMode : undefined);

        const plan = await tx.feePaymentPlan.create({
          data: {
            leadId: leadId!,
            courseName: (await tx.academyCourse.findUnique({ where: { id: courseId }, select: { name: true } }))?.name || 'Course',
            courseId,
            track: track as any,
            scheduleId,
            deliveryMode: schedule.mode === 'HYBRID' ? deliveryMode : undefined,
            totalFee: breakdown.baseFee,
            planType: paymentMethod,
            // Legacy singular FK — only meaningful (and only set) when
            // exactly one coupon applied; 0 or 2-3 coupons leave this null
            // and rely on couponUsages below for the full list. couponDiscount
            // always stays the combined total regardless of coupon count.
            couponId: breakdown.couponBreakdown.length === 1 ? breakdown.couponBreakdown[0].couponId : undefined,
            couponDiscount: breakdown.couponDiscount || undefined,
            paymentDiscountAmount: breakdown.paymentDiscountAmount ?? undefined,
            registrationFee: breakdown.registrationFee ?? undefined,
            downPayment: breakdown.downPayment ?? undefined,
            emiMonths: breakdown.emiMonths ?? undefined,
            interestAmount: breakdown.interestAmount ?? undefined,
            interestRatePct: breakdown.interestRatePct ?? undefined,
            admissionId,
            admissionStatus: 'CONFIRMED',
            batchAllocatedAt: new Date(),
            createdById: salespersonId,
            salespersonLockedAt: new Date(),
          },
        });

        for (const applied of breakdown.couponBreakdown) {
          await tx.couponUsage.create({
            data: { couponId: applied.couponId, admissionId: plan.id, salespersonId, discountApplied: applied.discount },
          });
        }

        // Installments — money isn't real until an Admin approves it
        // (PENDING_APPROVAL), same gate as every other fee collection in
        // this app; scheduled future installments start as plain PENDING.
        if (paymentMethod === 'SPOT' || paymentMethod === 'FULL') {
          const amount = payment?.amount != null ? Number(payment.amount) : breakdown.finalPayable!;
          await tx.feeInstallment.create({
            data: {
              planId: plan.id,
              dueDate: now,
              amount,
              status: 'PENDING_APPROVAL',
              paidAt: now,
              mode,
              receivedById,
              kind: paymentMethod === 'SPOT' ? 'SPOT_PAYMENT' : 'FULL_PAYMENT',
            },
          });
        } else if (paymentMethod === 'PART') {
          const regAmount = payment?.amount != null ? Number(payment.amount) : breakdown.registrationFee!;
          await tx.feeInstallment.create({
            data: {
              planId: plan.id,
              dueDate: now,
              amount: regAmount,
              status: 'PENDING_APPROVAL',
              paidAt: now,
              mode,
              receivedById,
              kind: 'REGISTRATION_FEE',
            },
          });
          // Due date uses the schedule's start date as the orientation-day
          // proxy — BatchCourseSchedule doesn't yet have its own dedicated
          // orientationDate field (spec section 5 wants one); tracked as a
          // small follow-up migration when the Batch Management screen is
          // built in a later phase, rather than blocking Phase 2 on it.
          await tx.feeInstallment.create({
            data: {
              planId: plan.id,
              dueDate: schedule.startDate,
              amount: breakdown.orientationBalance!,
              status: 'PENDING',
              kind: 'ORIENTATION_BALANCE',
            },
          });
        } else if (paymentMethod === 'EMI') {
          const downAmount = payment?.amount != null ? Number(payment.amount) : breakdown.downPayment!;
          await tx.feeInstallment.create({
            data: {
              planId: plan.id,
              dueDate: now,
              amount: downAmount,
              status: 'PENDING_APPROVAL',
              paidAt: now,
              mode,
              receivedById,
              kind: 'DOWN_PAYMENT',
            },
          });
          const months = breakdown.monthlyInstallments || [];
          for (let i = 0; i < months.length; i++) {
            // eslint-disable-next-line no-await-in-loop
            await tx.feeInstallment.create({
              data: {
                planId: plan.id,
                dueDate: addMonths(schedule.startDate, i + 1),
                amount: months[i],
                status: 'PENDING',
                kind: 'EMI',
                emiMonthNumber: i + 1,
              },
            });
          }
        }

        return plan;
      });

      if (req.user?.userId) {
        await prisma.auditLog.create({
          data: {
            userId: req.user.userId,
            action: 'CREATE',
            module: 'ADMISSION',
            entityId: created.id,
            entityType: 'FeePaymentPlan',
            newData: { admissionId, courseId, track, scheduleId, paymentMethod, breakdown: breakdown as object },
          },
        });
      }

      const full = await prisma.feePaymentPlan.findUnique({ where: { id: created.id }, include: admissionInclude });
      res.status(201).json({
        success: true,
        data: full,
        message: 'Admission confirmed. The payment is awaiting Admin approval before the receipt is emailed.',
      });
    } catch (err) { next(err); }
  },

  async listAdmissions(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { salespersonId, courseId, track, scheduleId, paymentMethod, admissionStatus, couponCode, search, from, to } = req.query;
      const where: Record<string, unknown> = { admissionId: { not: null } }; // only rows created via this module

      // Non-admin (EDIT-level) callers only ever see their own admissions —
      // enforced here, not just hidden in the UI, so this holds even if
      // someone calls the API directly. Admins can optionally filter by
      // salesperson; everyone else is pinned to themselves regardless of
      // what they pass.
      const admin = await isAdmissionAdmin(req);
      if (!admin) {
        where.createdById = req.user?.employeeId;
      } else if (salespersonId) {
        where.createdById = String(salespersonId);
      }

      if (courseId) where.courseId = String(courseId);
      if (track) where.track = String(track);
      if (scheduleId) where.scheduleId = String(scheduleId);
      if (paymentMethod) where.planType = String(paymentMethod);
      if (admissionStatus) where.admissionStatus = String(admissionStatus);
      // couponUsages (not the legacy singular `coupon` FK) so this still
      // finds admissions where the code was one of several stacked coupons.
      if (couponCode) where.couponUsages = { some: { coupon: { code: String(couponCode).toUpperCase() } } };
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(String(from));
        if (to) range.lte = new Date(String(to));
        where.createdAt = range;
      }
      if (search) {
        const term = String(search);
        where.OR = [
          { admissionId: { contains: term } },
          { lead: { name: { contains: term } } },
          { lead: { phone: { contains: term } } },
          { lead: { email: { contains: term } } },
        ];
      }

      const plans = await prisma.feePaymentPlan.findMany({ where, include: admissionInclude, orderBy: { createdAt: 'desc' } });
      const data = plans.map((p: (typeof plans)[number]) => ({
        ...p,
        paymentStatus: derivePaymentStatus(p.installments),
        totalPaid: totalPaid(p.installments),
        balance: Math.max(0, p.totalFee - (p.couponDiscount || 0) - totalPaid(p.installments)),
      }));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async getAdmission(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const plan = await prisma.feePaymentPlan.findUnique({ where: { id: req.params.id }, include: admissionInclude });
      if (!plan || !plan.admissionId) throw new AppError('Admission not found.', 404);
      if (!(await isAdmissionAdmin(req)) && plan.createdById !== req.user?.employeeId) {
        throw new AppError('Admission not found.', 404); // same message as not-found — don't leak that it belongs to someone else
      }
      res.json({
        success: true,
        data: {
          ...plan,
          paymentStatus: derivePaymentStatus(plan.installments),
          totalPaid: totalPaid(plan.installments),
          balance: Math.max(0, plan.totalFee - (plan.couponDiscount || 0) - totalPaid(plan.installments)),
        },
      });
    } catch (err) { next(err); }
  },

  // ── Course Fee Configuration ──────────────────────────────────────────────

  async listCourseFees(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const fees = await prisma.courseTrackFee.findMany({
        where: { isActive: true },
        include: { course: { select: { id: true, name: true } }, createdBy: { select: employeeSelect } },
        orderBy: [{ courseId: 'asc' }, { effectiveDate: 'desc' }],
      });
      res.json({ success: true, data: fees });
    } catch (err) { next(err); }
  },

  async createCourseFee(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { courseId, track, baseFee, effectiveDate } = req.body;
      if (!courseId || !track || baseFee == null) throw new AppError('courseId, track, and baseFee are required', 400);
      // A new fee row is added rather than editing an old one in place —
      // keeps every past admission's fee snapshot honest/auditable.
      const fee = await prisma.courseTrackFee.create({
        data: {
          courseId,
          track,
          baseFee: Number(baseFee),
          effectiveDate: effectiveDate ? new Date(effectiveDate) : new Date(),
          createdById: req.user?.employeeId,
        },
      });
      res.status(201).json({ success: true, data: fee });
    } catch (err) { next(err); }
  },

  async deactivateCourseFee(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const fee = await prisma.courseTrackFee.update({ where: { id: req.params.id }, data: { isActive: false } });
      res.json({ success: true, data: fee });
    } catch (err) { next(err); }
  },

  // ── Coupons ────────────────────────────────────────────────────────────

  async listCoupons(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const coupons = await prisma.coupon.findMany({
        include: {
          course: { select: { id: true, name: true } },
          schedule: { select: { id: true, code: true } },
          createdBy: { select: employeeSelect },
          restrictedToEmployee: { select: employeeSelect },
          _count: { select: { usages: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: coupons });
    } catch (err) { next(err); }
  },

  async createCoupon(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const {
        code, name, discountType, discountValue, courseId, track, scheduleId,
        validFrom, validUntil, maxUsage, perSalespersonUsageLimit, minimumFee, maximumDiscount,
        restrictedToEmployeeId,
      } = req.body;
      if (!code || !name || !discountType || discountValue == null || !validFrom || !validUntil) {
        throw new AppError('code, name, discountType, discountValue, validFrom, and validUntil are required', 400);
      }
      const coupon = await prisma.coupon.create({
        data: {
          code: String(code).trim().toUpperCase(),
          name,
          discountType,
          discountValue: Number(discountValue),
          courseId: courseId || undefined,
          track: track || undefined,
          scheduleId: scheduleId || undefined,
          restrictedToEmployeeId: restrictedToEmployeeId || undefined,
          validFrom: new Date(validFrom),
          validUntil: new Date(validUntil),
          maxUsage: maxUsage != null ? Number(maxUsage) : undefined,
          perSalespersonUsageLimit: perSalespersonUsageLimit != null ? Number(perSalespersonUsageLimit) : undefined,
          minimumFee: minimumFee != null ? Number(minimumFee) : undefined,
          maximumDiscount: maximumDiscount != null ? Number(maximumDiscount) : undefined,
          createdById: req.user?.employeeId,
        },
      });
      res.status(201).json({ success: true, data: coupon });
    } catch (err) { next(err); }
  },

  async updateCoupon(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, discountValue, validFrom, validUntil, maxUsage, perSalespersonUsageLimit, minimumFee, maximumDiscount, status, restrictedToEmployeeId } = req.body;
      const coupon = await prisma.coupon.update({
        where: { id: req.params.id },
        data: {
          name,
          discountValue: discountValue != null ? Number(discountValue) : undefined,
          validFrom: validFrom ? new Date(validFrom) : undefined,
          validUntil: validUntil ? new Date(validUntil) : undefined,
          maxUsage: maxUsage != null ? Number(maxUsage) : undefined,
          perSalespersonUsageLimit: perSalespersonUsageLimit != null ? Number(perSalespersonUsageLimit) : undefined,
          minimumFee: minimumFee != null ? Number(minimumFee) : undefined,
          maximumDiscount: maximumDiscount != null ? Number(maximumDiscount) : undefined,
          status,
          restrictedToEmployeeId: restrictedToEmployeeId === '' ? null : restrictedToEmployeeId,
        },
      });
      res.json({ success: true, data: coupon });
    } catch (err) { next(err); }
  },

  async validateCouponEndpoint(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { code, courseId, track, scheduleId, netFeeBeforeCoupon } = req.query;
      if (!code || !courseId || !track || netFeeBeforeCoupon == null) {
        throw new AppError('code, courseId, track, and netFeeBeforeCoupon are required', 400);
      }
      const result = await validateAndPriceCoupon({
        code: String(code),
        courseId: String(courseId),
        track: String(track),
        scheduleId: scheduleId ? String(scheduleId) : undefined,
        netFeeBeforeCoupon: Number(netFeeBeforeCoupon),
        salespersonId: req.user?.employeeId,
      });
      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  // ── Admission Config (admin-tunable rates) ────────────────────────────────

  async getConfig(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const config = await getAdmissionConfig();
      res.json({ success: true, data: config });
    } catch (err) { next(err); }
  },

  async updateConfig(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const {
        spotDiscountPct, fullDiscountPct, registrationFee, emiInterestByMonth,
        downPaymentPct, portalApprovalMinPaidPct, trackEmiMonthLimits,
        foreclosureBeforeFirstEmiPolicy, foreclosureAfterFirstEmiPolicy,
      } = req.body;

      const before = await prisma.admissionConfig.findUnique({ where: { id: 'default' } });
      const config = await prisma.admissionConfig.update({
        where: { id: 'default' },
        data: {
          spotDiscountPct: spotDiscountPct != null ? Number(spotDiscountPct) : undefined,
          fullDiscountPct: fullDiscountPct != null ? Number(fullDiscountPct) : undefined,
          registrationFee: registrationFee != null ? Number(registrationFee) : undefined,
          emiInterestByMonth: emiInterestByMonth ?? undefined,
          downPaymentPct: downPaymentPct != null ? Number(downPaymentPct) : undefined,
          portalApprovalMinPaidPct: portalApprovalMinPaidPct != null ? Number(portalApprovalMinPaidPct) : undefined,
          trackEmiMonthLimits: trackEmiMonthLimits ?? undefined,
          foreclosureBeforeFirstEmiPolicy,
          foreclosureAfterFirstEmiPolicy,
        },
      });

      if (req.user?.userId) {
        await prisma.auditLog.create({
          data: {
            userId: req.user.userId,
            action: 'EDIT',
            module: 'ADMISSION',
            entityId: 'default',
            entityType: 'AdmissionConfig',
            oldData: before as object,
            newData: config as object,
          },
        });
      }

      res.json({ success: true, data: config });
    } catch (err) { next(err); }
  },
};
