import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { getEffectiveAccess } from '../utils/moduleAccess';
import { config } from '../config/env';
import {
  mintAccessToken,
  ensureRoom,
  closeRoom,
  listLiveParticipants,
  setParticipantTrackMuted,
  removeParticipant as liveKitRemoveParticipant,
  isLiveKitConfigured,
  getLiveKitUrl,
} from '../services/liveKit.service';

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true } as const;
const studentSelect = { id: true, firstName: true, lastName: true, studentCode: true, photo: true } as const;

const liveClassInclude = {
  schedule: {
    select: {
      id: true, code: true, timing: true, startTime: true, endTime: true, mode: true,
      batch: { select: { id: true, code: true } },
      course: { select: { id: true, name: true } },
      _count: { select: { enrollments: true } },
    },
  },
  createdBy: { select: employeeSelect },
};

/** SUPER_ADMIN or explicit LIVE_CLASSES=ADMIN access — sees/manages every class, not just their own. */
async function isLiveClassesAdmin(req: AuthRequest): Promise<boolean> {
  if (!req.user) return false;
  if (req.user.role === 'SUPER_ADMIN') return true;
  if (!req.user.employeeId) return false;
  const access = await getEffectiveAccess(req.user.userId);
  return access.LIVE_CLASSES === 'ADMIN';
}

/** May create/reschedule/cancel/start/end a class on this schedule: an admin, or one of the schedule's assigned trainers. */
async function canManageSchedule(req: AuthRequest, scheduleId: string): Promise<boolean> {
  if (await isLiveClassesAdmin(req)) return true;
  if (!req.user?.employeeId) return false;
  const assignment = await prisma.trainerAssignment.findUnique({
    where: { scheduleId_trainerId: { scheduleId, trainerId: req.user.employeeId } },
  });
  return !!assignment;
}

/** Everyone allowed to be IN the (virtual) room: assigned trainers/admin as staff, actively-enrolled students. Throws if not. */
async function assertCanJoin(req: AuthRequest, liveClass: { scheduleId: string }): Promise<{ canHost: boolean }> {
  const canHost = await canManageSchedule(req, liveClass.scheduleId);
  if (canHost) return { canHost: true };

  if (req.user?.role === 'STUDENT' && req.user.studentId) {
    const enrollment = await prisma.studentBatchEnrollment.findUnique({
      where: { studentId_scheduleId: { studentId: req.user.studentId, scheduleId: liveClass.scheduleId } },
    });
    if (enrollment && enrollment.status === 'ACTIVE') return { canHost: false };
  }
  throw new AppError('You do not have access to this class.', 403);
}

/** Deterministic, human-readable code — e.g. DA-B14-PANDAS-DATA-CLEANING-2026-09-25. Falls back to a short random suffix on the rare collision. */
function slug(s: string): string {
  return s.toUpperCase().replace(/[^A-Z0-9]+/g, '-').replace(/(^-+|-+$)/g, '').slice(0, 28);
}
async function generateClassCode(batchCode: string, courseName: string, topic: string | undefined, date: Date): Promise<string> {
  const parts = [slug(batchCode), slug(courseName), topic ? slug(topic) : null, date.toISOString().slice(0, 10)].filter(Boolean);
  const base = parts.join('-');
  let candidate = base;
  let attempt = 0;
  // eslint-disable-next-line no-await-in-loop
  while (await prisma.liveClass.findUnique({ where: { classCode: candidate } })) {
    attempt++;
    candidate = `${base}-${attempt + 1}`;
  }
  return candidate;
}

/** Real name for the LiveKit participant display label — falls back to email if somehow neither profile is loaded. */
async function resolveDisplayName(req: AuthRequest): Promise<string> {
  if (req.user?.employeeId) {
    const emp = await prisma.employee.findUnique({ where: { id: req.user.employeeId }, select: { firstName: true, lastName: true } });
    if (emp) return `${emp.firstName} ${emp.lastName}`;
  }
  if (req.user?.studentId) {
    const st = await prisma.student.findUnique({ where: { id: req.user.studentId }, select: { firstName: true, lastName: true } });
    if (st) return `${st.firstName} ${st.lastName}`;
  }
  return req.user?.email || 'Participant';
}

function dayRange(d: Date) {
  const start = new Date(d);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { gte: start, lt: end };
}

/** Builds the self-scoping `schedule` where-clause for non-admin callers; returns null (meaning "show nothing") if the caller has no way into any class at all. */
function selfScopeWhere(req: AuthRequest): Record<string, unknown> | null {
  if (req.user?.role === 'STUDENT' && req.user.studentId) {
    return { enrollments: { some: { studentId: req.user.studentId, status: 'ACTIVE' } } };
  }
  if (req.user?.employeeId) {
    return { trainers: { some: { trainerId: req.user.employeeId } } };
  }
  return null;
}

export const liveClassesController = {
  // ── Schedule picker (for Create Class) ────────────────────────────────────
  async listSchedules(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isLiveClassesAdmin(req);
      const where: Record<string, unknown> = { status: { in: ['UPCOMING', 'ONGOING'] } };
      if (!admin) {
        const scope = selfScopeWhere(req);
        if (!scope) return res.json({ success: true, data: [] });
        Object.assign(where, scope);
      }
      const schedules = await prisma.batchCourseSchedule.findMany({
        where,
        select: {
          id: true, code: true, timing: true, startTime: true, endTime: true,
          batch: { select: { id: true, code: true } },
          course: { select: { id: true, name: true } },
        },
        orderBy: [{ batch: { code: 'asc' } }],
      });
      res.json({ success: true, data: schedules });
    } catch (err) { next(err); }
  },

  // ── CRUD ───────────────────────────────────────────────────────────────────
  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduleId, title, topic, description, scheduledDate, startTime, endTime } = req.body;
      if (!scheduleId || !title || !scheduledDate || !startTime || !endTime) {
        throw new AppError('scheduleId, title, scheduledDate, startTime, and endTime are required.', 400);
      }
      if (!(await canManageSchedule(req, scheduleId))) {
        throw new AppError('You are not assigned to train this batch.', 403);
      }

      const schedule = await prisma.batchCourseSchedule.findUnique({
        where: { id: scheduleId },
        include: { batch: { select: { code: true } }, course: { select: { name: true } } },
      });
      if (!schedule) throw new AppError('Batch schedule not found.', 404);

      const date = new Date(scheduledDate);

      // Same-batch / same-trainer overlap warning — soft check, returned as a
      // warning rather than a hard block, since a trainer or PM may
      // deliberately want two parallel classes (e.g. two schedules that
      // happen to share a trainer with a co-trainer covering one of them).
      const overlapping = await prisma.liveClass.findMany({
        where: {
          scheduledDate: dayRange(date),
          status: { in: ['SCHEDULED', 'LIVE'] },
          OR: [{ scheduleId }],
        },
        select: { id: true, title: true, startTime: true, endTime: true },
      });
      const overlapsTime = overlapping.filter((o: { startTime: string; endTime: string }) => o.startTime < endTime && startTime < o.endTime);

      const classCode = await generateClassCode(schedule.batch.code, schedule.course.name, topic, date);
      const roomName = `live-${classCode.toLowerCase()}`;

      const created = await prisma.liveClass.create({
        data: {
          classCode,
          roomName,
          title,
          scheduleId,
          topic: topic || undefined,
          description: description || undefined,
          scheduledDate: date,
          startTime,
          endTime,
          createdById: req.user?.employeeId || undefined,
        },
        include: liveClassInclude,
      });

      await prisma.auditLog.create({
        data: { userId: req.user!.userId, action: 'CREATE', module: 'LIVE_CLASSES', entityId: created.id, entityType: 'LiveClass', newData: created as object },
      }).catch(() => {});

      res.status(201).json({ success: true, data: created, warning: overlapsTime.length ? 'This batch already has another class scheduled at an overlapping time.' : undefined });
    } catch (err) { next(err); }
  },

  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { view, batchId, courseId, scheduleId, search } = req.query;
      const admin = await isLiveClassesAdmin(req);

      const where: Record<string, unknown> = {};
      const scheduleWhere: Record<string, unknown> = {};
      if (!admin) {
        const scope = selfScopeWhere(req);
        if (!scope) return res.json({ success: true, data: [] });
        Object.assign(scheduleWhere, scope);
      }
      if (batchId) scheduleWhere.batchId = String(batchId);
      if (courseId) scheduleWhere.courseId = String(courseId);
      if (Object.keys(scheduleWhere).length) where.schedule = scheduleWhere;
      if (scheduleId) where.scheduleId = String(scheduleId);

      if (view === 'today') {
        where.scheduledDate = dayRange(new Date());
        where.status = { in: ['SCHEDULED', 'LIVE'] };
      } else if (view === 'live') {
        where.status = 'LIVE';
      } else if (view === 'upcoming') {
        const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(0, 0, 0, 0);
        where.scheduledDate = { gte: tomorrow };
        where.status = 'SCHEDULED';
      } else if (view === 'completed') {
        where.status = { in: ['COMPLETED', 'CANCELLED'] };
      }

      if (search) {
        const term = String(search);
        where.OR = [
          { title: { contains: term } },
          { topic: { contains: term } },
          { schedule: { course: { name: { contains: term } } } },
          { schedule: { batch: { code: { contains: term } } } },
        ];
      }

      const classes = await prisma.liveClass.findMany({
        where,
        include: liveClassInclude,
        orderBy: [{ scheduledDate: 'asc' }, { startTime: 'asc' }],
      });
      res.json({ success: true, data: classes });
    } catch (err) { next(err); }
  },

  /** Dashboard counters + featured "Live Now" card(s) with a real (not cached) participant count from LiveKit. */
  async dashboard(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isLiveClassesAdmin(req);
      const scheduleWhere: Record<string, unknown> = {};
      if (!admin) {
        const scope = selfScopeWhere(req);
        if (!scope) return res.json({ success: true, data: { todayCount: 0, liveCount: 0, upcomingCount: 0, completedTodayCount: 0, live: [] } });
        Object.assign(scheduleWhere, scope);
      }
      const baseWhere = Object.keys(scheduleWhere).length ? { schedule: scheduleWhere } : {};
      const today = dayRange(new Date());
      const tomorrowStart = new Date(today.lt);

      const [todayCount, liveClasses, upcomingCount, completedTodayCount] = await Promise.all([
        prisma.liveClass.count({ where: { ...baseWhere, scheduledDate: today, status: { in: ['SCHEDULED', 'LIVE'] } } }),
        prisma.liveClass.findMany({ where: { ...baseWhere, status: 'LIVE' }, include: liveClassInclude, orderBy: { actualStartAt: 'asc' } }),
        prisma.liveClass.count({ where: { ...baseWhere, scheduledDate: { gte: tomorrowStart }, status: 'SCHEDULED' } }),
        prisma.liveClass.count({ where: { ...baseWhere, scheduledDate: today, status: 'COMPLETED' } }),
      ]);

      const live = await Promise.all(liveClasses.map(async (c: { roomName: string }) => ({
        ...c,
        liveParticipantCount: isLiveKitConfigured() ? (await listLiveParticipants(c.roomName)).length : 0,
      })));

      res.json({
        success: true,
        data: { todayCount, liveCount: liveClasses.length, upcomingCount, completedTodayCount, live },
      });
    } catch (err) { next(err); }
  },

  async get(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const liveClass = await prisma.liveClass.findUnique({ where: { id: req.params.id }, include: liveClassInclude });
      if (!liveClass) throw new AppError('Class not found.', 404);
      await assertCanJoin(req, liveClass); // same access rule as joining — if you can't join it, you can't view it either
      res.json({ success: true, data: liveClass });
    } catch (err) { next(err); }
  },

  async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.liveClass.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Class not found.', 404);
      if (!(await canManageSchedule(req, existing.scheduleId))) throw new AppError('You cannot edit this class.', 403);
      if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
        throw new AppError(`This class is already ${existing.status.toLowerCase()} and cannot be edited.`, 400);
      }

      const { title, topic, description, scheduledDate, startTime, endTime, rescheduledReason } = req.body;
      const isReschedule = (scheduledDate && new Date(scheduledDate).getTime() !== existing.scheduledDate.getTime()) || (startTime && startTime !== existing.startTime);

      const updated = await prisma.liveClass.update({
        where: { id: existing.id },
        data: {
          title: title || undefined,
          topic: topic ?? undefined,
          description: description ?? undefined,
          scheduledDate: scheduledDate ? new Date(scheduledDate) : undefined,
          startTime: startTime || undefined,
          endTime: endTime || undefined,
          rescheduledFrom: isReschedule ? existing.scheduledDate : undefined,
          rescheduledReason: isReschedule ? (rescheduledReason || undefined) : undefined,
        },
        include: liveClassInclude,
      });

      await prisma.auditLog.create({
        data: { userId: req.user!.userId, action: 'EDIT', module: 'LIVE_CLASSES', entityId: updated.id, entityType: 'LiveClass', oldData: existing as object, newData: updated as object },
      }).catch(() => {});

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  async cancel(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.liveClass.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Class not found.', 404);
      if (!(await canManageSchedule(req, existing.scheduleId))) throw new AppError('You cannot cancel this class.', 403);
      if (existing.status === 'COMPLETED' || existing.status === 'CANCELLED') {
        throw new AppError(`This class is already ${existing.status.toLowerCase()}.`, 400);
      }

      const updated = await prisma.liveClass.update({
        where: { id: existing.id },
        data: { status: 'CANCELLED', cancelledAt: new Date(), cancelReason: req.body?.reason || undefined },
        include: liveClassInclude,
      });
      if (existing.status === 'LIVE') await closeRoom(existing.roomName);

      await prisma.auditLog.create({
        data: { userId: req.user!.userId, action: 'EDIT', module: 'LIVE_CLASSES', entityId: updated.id, entityType: 'LiveClass', newData: { status: 'CANCELLED', reason: req.body?.reason } },
      }).catch(() => {});

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  // ── Lifecycle: start / end ──────────────────────────────────────────────────
  async start(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.liveClass.findUnique({ where: { id: req.params.id }, include: liveClassInclude });
      if (!existing) throw new AppError('Class not found.', 404);
      if (!(await canManageSchedule(req, existing.scheduleId))) throw new AppError('You are not a trainer on this batch.', 403);
      if (existing.status === 'CANCELLED') throw new AppError('This class was cancelled.', 400);
      if (existing.status === 'COMPLETED') throw new AppError('This class has already ended.', 400);

      await ensureRoom(existing.roomName);

      const liveClass = existing.status === 'LIVE'
        ? existing
        : await prisma.liveClass.update({ where: { id: existing.id }, data: { status: 'LIVE', actualStartAt: new Date() }, include: liveClassInclude });

      const alreadyHost = await prisma.liveClassParticipant.findFirst({ where: { liveClassId: existing.id, role: 'HOST' } });
      await prisma.liveClassParticipant.create({
        data: { liveClassId: existing.id, userId: req.user!.userId, role: alreadyHost ? 'CO_TRAINER' : 'HOST' },
      });

      const token = await mintAccessToken({ roomName: existing.roomName, identity: req.user!.userId, name: await resolveDisplayName(req) });

      res.json({ success: true, data: { liveClass, token, url: getLiveKitUrl(), roomName: existing.roomName } });
    } catch (err) { next(err); }
  },

  async end(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.liveClass.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Class not found.', 404);
      if (!(await canManageSchedule(req, existing.scheduleId))) throw new AppError('You cannot end this class.', 403);
      if (existing.status !== 'LIVE') throw new AppError('This class is not currently live.', 400);

      const updated = await prisma.liveClass.update({
        where: { id: existing.id },
        data: { status: 'COMPLETED', actualEndAt: new Date() },
        include: liveClassInclude,
      });
      await closeRoom(existing.roomName);
      // Anyone still marked as "in the room" gets their session closed out.
      await prisma.liveClassParticipant.updateMany({
        where: { liveClassId: existing.id, leftAt: null },
        data: { leftAt: new Date() },
      });

      await prisma.auditLog.create({
        data: { userId: req.user!.userId, action: 'EDIT', module: 'LIVE_CLASSES', entityId: updated.id, entityType: 'LiveClass', newData: { status: 'COMPLETED' } },
      }).catch(() => {});

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  // ── Join / leave ────────────────────────────────────────────────────────────
  async join(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const liveClass = await prisma.liveClass.findUnique({ where: { id: req.params.id } });
      if (!liveClass) throw new AppError('Class not found.', 404);
      const { canHost } = await assertCanJoin(req, liveClass);

      if (liveClass.status === 'CANCELLED') throw new AppError('This class has been cancelled.', 400);
      if (liveClass.status === 'COMPLETED') throw new AppError('This class has already ended.', 400);

      if (liveClass.status === 'SCHEDULED') {
        if (canHost) {
          // A trainer joining an un-started class is prompted to Start it — see frontend.
          return res.json({ success: true, data: { waitingForHost: true, canHost: true } });
        }
        const [h, m] = liveClass.startTime.split(':').map(Number);
        const scheduledStart = new Date(liveClass.scheduledDate);
        scheduledStart.setHours(h, m, 0, 0);
        const earliestJoin = new Date(scheduledStart.getTime() - config.LIVE_CLASS_EARLY_JOIN_MINUTES * 60000);
        if (new Date() < earliestJoin) {
          throw new AppError(`You can join from ${config.LIVE_CLASS_EARLY_JOIN_MINUTES} minutes before the class starts.`, 403);
        }
        return res.json({ success: true, data: { waitingForHost: true, canHost: false } });
      }

      // LIVE — mint the real token.
      await prisma.liveClassParticipant.create({
        data: { liveClassId: liveClass.id, userId: req.user!.userId, role: canHost ? 'CO_TRAINER' : 'STUDENT' },
      });
      const token = await mintAccessToken({ roomName: liveClass.roomName, identity: req.user!.userId, name: await resolveDisplayName(req) });
      res.json({ success: true, data: { waitingForHost: false, canHost, token, url: getLiveKitUrl(), roomName: liveClass.roomName } });
    } catch (err) { next(err); }
  },

  async leave(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const openRow = await prisma.liveClassParticipant.findFirst({
        where: { liveClassId: req.params.id, userId: req.user!.userId, leftAt: null },
        orderBy: { joinedAt: 'desc' },
      });
      if (openRow) await prisma.liveClassParticipant.update({ where: { id: openRow.id }, data: { leftAt: new Date() } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Participants (host panel) ───────────────────────────────────────────────
  async participants(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const liveClass = await prisma.liveClass.findUnique({ where: { id: req.params.id } });
      if (!liveClass) throw new AppError('Class not found.', 404);
      await assertCanJoin(req, liveClass);

      const rows = await prisma.liveClassParticipant.findMany({
        where: { liveClassId: liveClass.id },
        include: { user: { include: { employee: { select: employeeSelect }, student: { select: studentSelect } } } },
        orderBy: { joinedAt: 'asc' },
      });
      const live = liveClass.status === 'LIVE' ? await listLiveParticipants(liveClass.roomName) : [];
      const liveByIdentity = new Map(live.map((p) => [p.identity, p]));

      type ParticipantRow = (typeof rows)[number];
      // One entry per user currently believed to be in the room (no leftAt yet).
      const seen = new Set<string>();
      const currentlyIn = rows.filter((r: ParticipantRow) => r.leftAt === null && !seen.has(r.userId) && seen.add(r.userId));

      res.json({
        success: true,
        data: {
          participants: currentlyIn.map((r: ParticipantRow) => ({
            userId: r.userId,
            role: r.role,
            joinedAt: r.joinedAt,
            name: r.user.employee ? `${r.user.employee.firstName} ${r.user.employee.lastName}` : r.user.student ? `${r.user.student.firstName} ${r.user.student.lastName}` : r.user.email,
            photo: r.user.student?.photo || null,
            live: liveByIdentity.get(r.userId) || null,
          })),
          history: rows,
        },
      });
    } catch (err) { next(err); }
  },

  // ── Host controls ────────────────────────────────────────────────────────────
  async muteParticipant(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const liveClass = await prisma.liveClass.findUnique({ where: { id: req.params.id } });
      if (!liveClass) throw new AppError('Class not found.', 404);
      if (!(await canManageSchedule(req, liveClass.scheduleId))) throw new AppError('Only a trainer on this batch can do that.', 403);
      const { userId, kind = 'audio', muted = true } = req.body;
      if (!userId) throw new AppError('userId is required.', 400);
      await setParticipantTrackMuted(liveClass.roomName, userId, kind === 'video' ? 'video' : 'audio', !!muted);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async removeParticipant(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const liveClass = await prisma.liveClass.findUnique({ where: { id: req.params.id } });
      if (!liveClass) throw new AppError('Class not found.', 404);
      if (!(await canManageSchedule(req, liveClass.scheduleId))) throw new AppError('Only a trainer on this batch can do that.', 403);
      const { userId } = req.body;
      if (!userId) throw new AppError('userId is required.', 400);
      await liveKitRemoveParticipant(liveClass.roomName, userId);
      await prisma.liveClassParticipant.updateMany({ where: { liveClassId: liveClass.id, userId, leftAt: null }, data: { leftAt: new Date() } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Chat ─────────────────────────────────────────────────────────────────────
  async listChat(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const liveClass = await prisma.liveClass.findUnique({ where: { id: req.params.id } });
      if (!liveClass) throw new AppError('Class not found.', 404);
      await assertCanJoin(req, liveClass);
      const messages = await prisma.liveClassChatMessage.findMany({
        where: { liveClassId: liveClass.id },
        include: { user: { include: { employee: { select: employeeSelect }, student: { select: studentSelect } } } },
        orderBy: { createdAt: 'asc' },
      });
      res.json({
        success: true,
        data: messages.map((m: (typeof messages)[number]) => ({
          id: m.id,
          message: m.message,
          createdAt: m.createdAt,
          userId: m.userId,
          name: m.user.employee ? `${m.user.employee.firstName} ${m.user.employee.lastName}` : m.user.student ? `${m.user.student.firstName} ${m.user.student.lastName}` : m.user.email,
        })),
      });
    } catch (err) { next(err); }
  },

  async postChat(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const liveClass = await prisma.liveClass.findUnique({ where: { id: req.params.id } });
      if (!liveClass) throw new AppError('Class not found.', 404);
      await assertCanJoin(req, liveClass);
      const message = String(req.body?.message || '').trim();
      if (!message) throw new AppError('Message cannot be empty.', 400);
      if (message.length > 2000) throw new AppError('Message is too long.', 400);

      const created = await prisma.liveClassChatMessage.create({
        data: { liveClassId: liveClass.id, userId: req.user!.userId, message },
        include: { user: { include: { employee: { select: employeeSelect }, student: { select: studentSelect } } } },
      });
      res.status(201).json({
        success: true,
        data: {
          id: created.id,
          message: created.message,
          createdAt: created.createdAt,
          userId: created.userId,
          name: created.user.employee ? `${created.user.employee.firstName} ${created.user.employee.lastName}` : created.user.student ? `${created.user.student.firstName} ${created.user.student.lastName}` : created.user.email,
        },
      });
    } catch (err) { next(err); }
  },
};
