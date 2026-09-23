import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

// ── Unified Calendar — aggregates three independently-owned data sources into
// one read-only feed (batch class schedules, Live Classes sessions, approved
// leave) rather than being its own source of truth for any of them. There is
// deliberately no create/edit here yet — every event on this calendar always
// traces back to a real row in Production/Live Classes/Leave, so there's
// nothing to keep in sync. No RBAC module gate (see calendar.routes.ts):
// every logged-in user gets a calendar, just scoped to what they're allowed
// to see, the same "no module gate — every handler scopes itself" pattern
// already used for Live Classes' identity-scoped endpoints.

type CalendarEventType = 'BATCH_SCHEDULE' | 'LIVE_CLASS' | 'LEAVE';

interface CalendarEvent {
  id: string;
  type: CalendarEventType;
  title: string;
  subtitle: string | null;
  date: string; // YYYY-MM-DD
  startTime: string | null; // "HH:mm", null = all-day
  endTime: string | null;
  allDay: boolean;
  status: string | null;
  meta: Record<string, unknown>;
}

/** "2026-09-23" -> Date at UTC midnight — every date in this feature is
 * treated as a plain calendar date (no timezone-of-day math), matching how
 * BatchCourseSchedule.startDate/endDate and LeaveRequest dates are already
 * stored (@db.Date). */
function parseDateOnly(s: string): Date {
  const d = new Date(`${s}T00:00:00.000Z`);
  if (isNaN(d.getTime())) throw new AppError(`Invalid date: ${s}`, 400);
  return d;
}
function toDateOnlyStr(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function addDays(d: Date, n: number): Date {
  const copy = new Date(d);
  copy.setUTCDate(copy.getUTCDate() + n);
  return copy;
}

/** MON_SAT/SAT_SUN/SUNDAY_ONLY -> does this calendar day match? (UTC weekday, 0=Sun) */
function dayMatchesPattern(date: Date, pattern: string): boolean {
  const dow = date.getUTCDay();
  if (pattern === 'MON_SAT') return dow !== 0;
  if (pattern === 'SAT_SUN') return dow === 0 || dow === 6;
  if (pattern === 'SUNDAY_ONLY') return dow === 0;
  return false;
}

/** Same self-scoping relation shape as liveClasses.controller.ts's
 * selfScopeWhere — reapplied here directly against BatchCourseSchedule
 * (which has the same `trainers`/`enrollments` relations LiveClass reaches
 * through `schedule`). Kept as a local copy rather than a shared import to
 * avoid coupling two independently-owned controllers together over what's
 * a two-line helper. */
function selfScheduleScope(req: AuthRequest): Record<string, unknown> | null {
  if (req.user?.role === 'STUDENT' && req.user.studentId) {
    return { enrollments: { some: { studentId: req.user.studentId, status: 'ACTIVE' } } };
  }
  if (req.user?.employeeId) {
    return { trainers: { some: { trainerId: req.user.employeeId } } };
  }
  return null;
}

export const calendarController = {
  /** GET /api/calendar?from=YYYY-MM-DD&to=YYYY-MM-DD — every event
   * overlapping the range, scoped to the caller. Range-agnostic on purpose
   * (no separate month/day endpoints): the frontend computes whatever
   * date span its current view needs (a padded month grid, or a single
   * day) and asks for exactly that. */
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!req.user) throw new AppError('Not authenticated.', 401);
      const fromStr = String(req.query.from || '');
      const toStr = String(req.query.to || '');
      if (!fromStr || !toStr) throw new AppError('from and to (YYYY-MM-DD) are required.', 400);
      const from = parseDateOnly(fromStr);
      const to = parseDateOnly(toStr);
      if (to < from) throw new AppError('to must not be before from.', 400);
      // Guard against an accidentally huge range (e.g. a bad client build
      // asking for years of data) — a month view padded to full weeks is
      // at most ~6 weeks; a generous cap leaves headroom without allowing
      // unbounded server-side iteration below.
      if ((to.getTime() - from.getTime()) / 86400000 > 120) {
        throw new AppError('Date range too large (max 120 days).', 400);
      }

      const isAdmin = req.user.role === 'SUPER_ADMIN'; // module-level ADMIN doesn't apply here — this isn't a gated module
      const scope = isAdmin ? {} : selfScheduleScope(req);
      // A logged-in user with neither an admin role nor a resolvable
      // scope (shouldn't normally happen) just sees an empty calendar
      // rather than erroring.
      if (scope === null) return res.json({ success: true, data: { events: [] } });

      const events: CalendarEvent[] = [];

      // ── Batch class schedules — generate this range's actual class-day
      // occurrences from each schedule's dayPattern, bounded by its own
      // startDate/endDate and clipped to the requested range. ──────────────
      const schedules = await prisma.batchCourseSchedule.findMany({
        where: {
          ...scope,
          status: { not: 'CANCELLED' },
          startDate: { lte: to },
          OR: [{ endDate: null }, { endDate: { gte: from } }],
        },
        select: {
          id: true, code: true, timing: true, startTime: true, endTime: true,
          dayPattern: true, mode: true, startDate: true, endDate: true,
          batch: { select: { code: true } },
          course: { select: { name: true } },
        },
      });
      for (const s of schedules) {
        const rangeStart = s.startDate > from ? s.startDate : from;
        const rangeEnd = s.endDate && s.endDate < to ? s.endDate : to;
        for (let d = rangeStart; d <= rangeEnd; d = addDays(d, 1)) {
          if (!dayMatchesPattern(d, s.dayPattern)) continue;
          events.push({
            id: `batch-${s.id}-${toDateOnlyStr(d)}`,
            type: 'BATCH_SCHEDULE',
            title: `${s.batch.code} — ${s.course.name}`,
            subtitle: s.mode,
            date: toDateOnlyStr(d),
            startTime: s.startTime,
            endTime: s.endTime,
            allDay: !s.startTime || !s.endTime,
            status: null,
            meta: { scheduleId: s.id, scheduleCode: s.code, timing: s.timing, mode: s.mode },
          });
        }
      }

      // ── Live Classes — real scheduled/live/completed virtual-classroom
      // sessions, filtered through the same schedule-relation scope. ──────
      const liveClasses = await prisma.liveClass.findMany({
        where: {
          schedule: scope,
          scheduledDate: { gte: from, lte: to },
        },
        select: {
          id: true, title: true, scheduledDate: true, startTime: true, endTime: true, status: true,
          schedule: { select: { batch: { select: { code: true } }, course: { select: { name: true } } } },
        },
      });
      for (const c of liveClasses) {
        events.push({
          id: `live-${c.id}`,
          type: 'LIVE_CLASS',
          title: `${c.schedule.batch.code} — ${c.title}`,
          subtitle: c.schedule.course.name,
          date: toDateOnlyStr(c.scheduledDate),
          startTime: c.startTime,
          endTime: c.endTime,
          allDay: false,
          status: c.status,
          meta: { liveClassId: c.id },
        });
      }

      // ── Approved leave — staff only (students have no leave concept);
      // admin sees everyone's, an employee sees only their own. Shown as an
      // all-day block spanning startDate..endDate. ────────────────────────
      if (req.user.employeeId || isAdmin) {
        const leaveWhere: Record<string, unknown> = {
          status: 'APPROVED',
          startDate: { lte: to },
          endDate: { gte: from },
        };
        if (!isAdmin) leaveWhere.employeeId = req.user.employeeId;
        const leaves = await prisma.leaveRequest.findMany({
          where: leaveWhere,
          select: {
            id: true, startDate: true, endDate: true, isHalfDay: true,
            employee: { select: { firstName: true, lastName: true } },
            leaveType: { select: { name: true } },
          },
        });
        for (const l of leaves) {
          const rangeStart = l.startDate > from ? l.startDate : from;
          const rangeEnd = l.endDate < to ? l.endDate : to;
          for (let d = rangeStart; d <= rangeEnd; d = addDays(d, 1)) {
            events.push({
              id: `leave-${l.id}-${toDateOnlyStr(d)}`,
              type: 'LEAVE',
              title: `${l.employee.firstName} ${l.employee.lastName} — ${l.leaveType.name}${l.isHalfDay ? ' (Half day)' : ''}`,
              subtitle: null,
              date: toDateOnlyStr(d),
              startTime: null,
              endTime: null,
              allDay: true,
              status: null,
              meta: { leaveRequestId: l.id },
            });
          }
        }
      }

      res.json({ success: true, data: { events } });
    } catch (err) { next(err); }
  },
};
