import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { calcWorkHours, paginate, formatPagination } from '../utils/helpers';
import { config } from '../config/env';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function dayRange(d = new Date()) {
  // Use UTC midnight to avoid timezone-dependent date shifts on @db.Date fields
  const start = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const end = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999));
  return { start, end };
}

/** Haversine distance in metres between two GPS coordinates */
function haversineMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Determine location type using GPS coordinates sent by the browser */
function getLocationType(
  lat: number | null | undefined,
  lng: number | null | undefined,
): { locationType: string; wfhStatus: string | null; distanceMeters: number | null } {
  const officeLat = config.OFFICE_LAT;
  const officeLng = config.OFFICE_LNG;

  // Geofencing not configured — treat all as OFFICE
  if (officeLat === null || officeLng === null) {
    return { locationType: 'OFFICE', wfhStatus: null, distanceMeters: null };
  }

  // No GPS sent by client — cannot verify, mark WFH pending
  if (lat == null || lng == null) {
    return { locationType: 'WFH', wfhStatus: 'PENDING', distanceMeters: null };
  }

  const distance = haversineMeters(lat, lng, officeLat, officeLng);
  if (distance <= config.OFFICE_RADIUS_METERS) {
    return { locationType: 'OFFICE', wfhStatus: null, distanceMeters: distance };
  }
  return { locationType: 'WFH', wfhStatus: 'PENDING', distanceMeters: distance };
}

// ─── Controller ──────────────────────────────────────────────────────────────

export const attendanceController = {
  async checkIn(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (req.user!.role === 'SUPER_ADMIN') throw new AppError('Owner account does not use attendance tracking', 403);
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const { start, end } = dayRange();
      const existing = await prisma.attendance.findFirst({
        where: { employeeId: employee.id, date: { gte: start, lte: end } },
      });

      if (existing?.checkIn && !existing?.checkOut) {
        throw new AppError('Already checked in. Please check out first.', 400);
      }

      const now = new Date();
      const lat: number | null = req.body.lat ?? null;
      const lng: number | null = req.body.lng ?? null;

      const { locationType, wfhStatus, distanceMeters } = getLocationType(lat, lng);

      let attendance;
      if (existing) {
        attendance = await prisma.attendance.update({
          where: { id: existing.id },
          data: {
            checkIn: now,
            checkOut: null,
            checkInMethod: lat != null ? 'GPS' : 'WEB',
            checkInLat: lat,
            checkInLng: lng,
            locationType,
            wfhStatus,
            status: 'PRESENT',
          },
        });
      } else {
        attendance = await prisma.attendance.create({
          data: {
            employeeId: employee.id,
            date: start,
            checkIn: now,
            checkInMethod: lat != null ? 'GPS' : 'WEB',
            checkInLat: lat,
            checkInLng: lng,
            locationType,
            wfhStatus,
            status: 'PRESENT',
            workHours: 0,
          },
        });
      }

      // Record this session's check-in
      await prisma.attendanceSession.create({
        data: { attendanceId: attendance.id, checkIn: now },
      });

      const message = locationType === 'WFH'
        ? `Checked in — you are ${distanceMeters != null ? Math.round(distanceMeters) + 'm from office' : 'outside office'}. WFH approval sent to your manager.`
        : `Checked in successfully${distanceMeters != null ? ` (${Math.round(distanceMeters)}m from office)` : ''}. Have a great day!`;

      res.json({ success: true, message, data: attendance });
    } catch (err) { next(err); }
  },

  async checkOut(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (req.user!.role === 'SUPER_ADMIN') throw new AppError('Owner account does not use attendance tracking', 403);
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const { start, end } = dayRange();
      const attendance = await prisma.attendance.findFirst({
        where: { employeeId: employee.id, date: { gte: start, lte: end } },
      });

      if (!attendance?.checkIn) throw new AppError('Please check in first', 400);
      if (attendance.checkOut) throw new AppError('Already checked out. Check in again to start a new session.', 400);

      const now = new Date();
      const sessionHours = calcWorkHours(attendance.checkIn, now, 0);
      const totalWorkHours = (attendance.workHours || 0) + sessionHours;
      const totalOvertimeHours = Math.max(0, totalWorkHours - 9);

      // Find the open session (most recent with no checkout)
      const openSession = await prisma.attendanceSession.findFirst({
        where: { attendanceId: attendance.id, checkOut: null },
        orderBy: { createdAt: 'desc' },
      });
      if (openSession) {
        await prisma.attendanceSession.update({
          where: { id: openSession.id },
          data: { checkOut: now, durationHours: sessionHours },
        });
      }

      const updated = await prisma.attendance.update({
        where: { id: attendance.id },
        data: {
          checkOut: now,
          checkOutMethod: 'WEB',
          workHours: totalWorkHours,
          overtimeHours: totalOvertimeHours,
          status: totalWorkHours >= 4
            ? (totalWorkHours >= 7 ? 'PRESENT' : 'HALF_DAY')
            : 'ABSENT',
        },
      });

      res.json({ success: true, message: 'Checked out successfully', data: updated });
    } catch (err) { next(err); }
  },

  async today(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (req.user!.role === 'SUPER_ADMIN') return res.json({ success: true, data: null });
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      // No Employee record linked to this login — return null instead of a hard 404
      // so the frontend's "today" widget just shows an empty state.
      if (!employee) return res.json({ success: true, data: null });

      const { start, end } = dayRange();
      const attendance = await prisma.attendance.findFirst({
        where: { employeeId: employee.id, date: { gte: start, lte: end } },
        include: { sessions: { orderBy: { checkIn: 'asc' } } },
      });

      res.json({ success: true, data: attendance });
    } catch (err) { next(err); }
  },

  async teamTodayLogs(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      // No Employee record linked to this login — return an empty team list instead
      // of a hard 404 so the frontend's team panel just shows nothing instead of erroring.
      if (!manager) return res.json({ success: true, data: [] });

      const { start, end } = dayRange();

      const teamEmployees = await prisma.employee.findMany({
        where: { managerId: manager.id, status: { in: ['ACTIVE', 'ON_PROBATION'] } },
        select: {
          id: true, firstName: true, lastName: true, employeeCode: true, profilePhoto: true,
          designation: { select: { name: true } },
          attendances: {
            where: { date: { gte: start, lte: end } },
            include: { sessions: { orderBy: { checkIn: 'asc' } } },
            take: 1,
          },
        },
        orderBy: { firstName: 'asc' },
      });

      const data = teamEmployees.map(emp => ({
        id: emp.id,
        firstName: emp.firstName,
        lastName: emp.lastName,
        employeeCode: emp.employeeCode,
        profilePhoto: emp.profilePhoto,
        designation: emp.designation?.name ?? null,
        attendance: emp.attendances[0] ?? null,
      }));

      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async history(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { employeeId: targetEmployeeId } = req.query as Record<string, string | undefined>;
      let employee;
      if (targetEmployeeId) {
        // HR/Manager/SUPER_ADMIN viewing a specific employee's attendance
        // (e.g. the Attendance tab on an employee's detail page).
        if (!['SUPER_ADMIN', 'HR', 'MANAGER'].includes(req.user!.role)) {
          throw new AppError("Not authorized to view this employee's attendance", 403);
        }
        employee = await prisma.employee.findUnique({ where: { id: targetEmployeeId } });
      } else {
        // Self-service: "My Attendance". SUPER_ADMIN has no Employee record of
        // their own, so there's nothing to return here.
        if (req.user!.role === 'SUPER_ADMIN') return res.json({ success: true, data: [] });
        employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      }
      if (!employee) throw new AppError('Employee not found', 404);

      const { page = 1, limit = 60, month, year } = req.query;
      const p = Number(page), l = Number(limit);

      const where: Record<string, unknown> = { employeeId: employee.id };
      if (month && year) {
        const m = Number(month), y = Number(year);
        where.date = { gte: new Date(Date.UTC(y, m - 1, 1)), lte: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)) };
      }

      const [records, total] = await Promise.all([
        prisma.attendance.findMany({
          where,
          orderBy: { date: 'desc' },
          ...paginate(p, l),
        }),
        prisma.attendance.count({ where }),
      ]);

      // Merge approved leave days as synthetic ON_LEAVE records
      if (month && year) {
        const m = Number(month), y = Number(year);
        const periodStart = new Date(Date.UTC(y, m - 1, 1));
        const periodEnd   = new Date(Date.UTC(y, m, 0, 23, 59, 59));

        const approvedLeaves = await prisma.leaveRequest.findMany({
          where: {
            employeeId: employee.id,
            status: 'APPROVED',
            startDate: { lte: periodEnd },
            endDate:   { gte: periodStart },
          },
        });

        const existingDates = new Set(records.map((r) => r.date.toISOString().slice(0, 10)));

        for (const leave of approvedLeaves) {
          const cursor = new Date(leave.startDate);
          const end    = new Date(leave.endDate);
          while (cursor <= end) {
            const dStr = cursor.toISOString().slice(0, 10);
            const dow  = cursor.getUTCDay(); // 0=Sun
            if (dow !== 0 && !existingDates.has(dStr)) {
              // Check within requested period
              const d = new Date(dStr);
              if (d >= periodStart && d <= periodEnd) {
                (records as any[]).push({
                  id: `leave-${leave.id}-${dStr}`,
                  employeeId: employee.id,
                  date: new Date(dStr),
                  status: 'ON_LEAVE',
                  checkIn: null, checkOut: null,
                  workHours: null, locationType: 'OFFICE',
                });
                existingDates.add(dStr);
              }
            }
            cursor.setUTCDate(cursor.getUTCDate() + 1);
          }
        }
      }

      res.json({ success: true, data: records, meta: formatPagination(total, p, l) });
    } catch (err) { next(err); }
  },

  /** WFH approval — manager approves/rejects a pending WFH attendance */
  async approveWfh(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { action, note } = req.body; // action: 'approve' | 'reject'
      if (!['approve', 'reject'].includes(action)) {
        throw new AppError('action must be approve or reject', 400);
      }

      const attendance = await prisma.attendance.findUnique({ where: { id } });
      if (!attendance) throw new AppError('Attendance record not found', 404);
      if (attendance.locationType !== 'WFH') throw new AppError('Not a WFH record', 400);

      const updated = await prisma.attendance.update({
        where: { id },
        data: {
          wfhStatus: action === 'approve' ? 'APPROVED' : 'REJECTED',
          wfhNote: note,
          wfhApprovedById: req.user!.userId,
          wfhApprovedAt: new Date(),
        },
      });

      res.json({ success: true, message: `WFH ${action}d`, data: updated });
    } catch (err) { next(err); }
  },

  /** List pending WFH approvals for the logged-in manager's team */
  async pendingWfh(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const teamIds = await prisma.employee.findMany({
        where: { managerId: manager.id },
        select: { id: true },
      });

      const records = await prisma.attendance.findMany({
        where: {
          employeeId: { in: teamIds.map((e) => e.id) },
          locationType: 'WFH',
          wfhStatus: 'PENDING',
        },
        include: {
          employee: { select: { firstName: true, lastName: true, employeeCode: true } },
        },
        orderBy: { date: 'desc' },
      });

      res.json({ success: true, data: records });
    } catch (err) { next(err); }
  },

  async teamAttendance(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const { start, end } = dayRange();
      const teamIds = await prisma.employee.findMany({
        where: { managerId: manager.id },
        select: { id: true },
      });

      const records = await prisma.attendance.findMany({
        where: {
          employeeId: { in: teamIds.map((e) => e.id) },
          date: { gte: start, lte: end },
        },
        include: {
          employee: { select: { firstName: true, lastName: true, employeeCode: true, profilePhoto: true } },
        },
      });

      res.json({ success: true, data: records });
    } catch (err) { next(err); }
  },

  async regularize(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { date, checkIn, checkOut, reason } = req.body;
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const { start, end } = dayRange(new Date(date));
      const existing = await prisma.attendance.findFirst({
        where: { employeeId: employee.id, date: { gte: start, lte: end } },
      });

      let attendance;
      if (existing) {
        attendance = await prisma.attendance.update({
          where: { id: existing.id },
          data: {
            checkIn: checkIn ? new Date(checkIn) : undefined,
            checkOut: checkOut ? new Date(checkOut) : undefined,
            isRegularized: true,
            regularizeNote: reason,
            status: 'PRESENT',
          },
        });
      } else {
        attendance = await prisma.attendance.create({
          data: {
            employeeId: employee.id,
            date: start,
            checkIn: checkIn ? new Date(checkIn) : undefined,
            checkOut: checkOut ? new Date(checkOut) : undefined,
            isRegularized: true,
            regularizeNote: reason,
            status: 'PRESENT',
          },
        });
      }

      res.json({ success: true, data: attendance, message: 'Regularization submitted' });
    } catch (err) { next(err); }
  },

  async summary(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      // SUPER_ADMIN → return today's company-wide attendance list
      if (req.user!.role === 'SUPER_ADMIN') {
        const companyId = req.user!.companyId;
        const { start, end } = dayRange();

        const employees = await prisma.employee.findMany({
          where: { ...(companyId ? { companyId } : {}), status: { in: ['ACTIVE', 'ON_PROBATION'] } },
          select: {
            id: true, firstName: true, lastName: true, employeeCode: true,
            department: { select: { name: true } },
            attendances: {
              where: { date: { gte: start, lte: end } },
              select: { status: true, checkIn: true, checkOut: true, workHours: true },
              take: 1,
            },
          },
          orderBy: [{ department: { name: 'asc' } }, { firstName: 'asc' }],
        });

        const rows = employees.map(e => ({
          employeeId: e.id,
          employeeCode: e.employeeCode,
          firstName: e.firstName,
          lastName: e.lastName,
          department: e.department?.name ?? null,
          status: e.attendances[0]?.status ?? 'ABSENT',
          checkIn: e.attendances[0]?.checkIn ?? null,
          checkOut: e.attendances[0]?.checkOut ?? null,
          workHours: e.attendances[0]?.workHours ?? null,
        }));

        return res.json({ success: true, data: rows });
      }

      // Regular employee → own monthly summary
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const { month = new Date().getMonth() + 1, year = new Date().getFullYear() } = req.query;
      const m = Number(month), y = Number(year);

      const records = await prisma.attendance.findMany({
        where: {
          employeeId: employee.id,
          date: { gte: new Date(Date.UTC(y, m - 1, 1)), lte: new Date(Date.UTC(y, m, 0, 23, 59, 59, 999)) },
        },
      });

      const summary = records.reduce(
        (acc, r) => {
          acc[r.status] = (acc[r.status] || 0) + 1;
          acc.totalWorkHours += r.workHours || 0;
          acc.totalOvertimeHours += r.overtimeHours || 0;
          return acc;
        },
        { PRESENT: 0, ABSENT: 0, HALF_DAY: 0, ON_LEAVE: 0, HOLIDAY: 0, WEEKEND: 0, totalWorkHours: 0, totalOvertimeHours: 0 } as Record<string, number>
      );

      res.json({ success: true, data: summary });
    } catch (err) { next(err); }
  },
};
