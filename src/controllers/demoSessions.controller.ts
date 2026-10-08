import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { config } from '../config/env';
import { getEffectiveAccess } from '../utils/moduleAccess';
import { emailService } from '../services/email.service';
import { notificationService } from '../services/notification.service';
import { mintAccessToken, getLiveKitUrl, removeParticipant } from '../services/liveKit.service';

/**
 * Demo sit-ins: sales asks for a prospect to sit in on a class that is already
 * scheduled today. The Production Manager (or that sub-batch's trainer)
 * approves; ONLINE prospects then get an emailed link + code that lets them
 * join the running class like a normal student for `maxMinutes`.
 */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no look-alikes (0/O, 1/I/L)
function newCode(): string {
  let c = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) c += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return c;
}

function todayRange() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  const end = new Date(start); end.setDate(end.getDate() + 1);
  return { gte: start, lt: end };
}

const classSelect = {
  id: true, title: true, topic: true, scheduledDate: true, startTime: true, endTime: true, status: true, roomName: true,
  schedule: {
    select: {
      id: true, code: true, timing: true,
      batch: { select: { id: true, code: true } },
      course: { select: { id: true, name: true } },
      trainers: { select: { trainer: { select: { id: true, firstName: true, lastName: true, email: true, userId: true } } } },
    },
  },
} as const;

/** Production-manager-level people (module EDIT+ on PRODUCTION_TRAINING via per-user grants) + the schedule's trainers. */
async function reviewersFor(scheduleId: string) {
  const [grants, trainers] = await Promise.all([
    prisma.userModuleAccess.findMany({
      where: { module: 'PRODUCTION_TRAINING', accessLevel: { in: ['EDIT', 'ADMIN'] } },
      include: { user: { include: { employee: true } } },
    }),
    prisma.trainerAssignment.findMany({ where: { scheduleId }, include: { trainer: true } }),
  ]);
  const map = new Map<string, { userId: string; email: string | null; name: string }>();
  for (const g of grants) {
    map.set(g.userId, { userId: g.userId, email: g.user.employee?.email || g.user.email, name: g.user.employee ? `${g.user.employee.firstName} ${g.user.employee.lastName}` : g.user.email });
  }
  for (const t of trainers) {
    if (t.trainer.userId) map.set(t.trainer.userId, { userId: t.trainer.userId, email: t.trainer.email, name: `${t.trainer.firstName} ${t.trainer.lastName}` });
  }
  return Array.from(map.values());
}

async function canReview(req: AuthRequest, scheduleId: string): Promise<boolean> {
  if (req.user!.role === 'SUPER_ADMIN' || req.user!.role === 'ADMIN') return true;
  const access = await getEffectiveAccess(req.user!.userId);
  if (access.PRODUCTION_TRAINING === 'EDIT' || access.PRODUCTION_TRAINING === 'ADMIN') return true;
  if (!req.user!.employeeId) return false;
  const a = await prisma.trainerAssignment.findFirst({ where: { scheduleId, trainerId: req.user!.employeeId }, select: { id: true } });
  return !!a;
}

const fmtTime = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });

export const demoSessionsController = {
  /** Today's classes still open (not ended/cancelled), for the request form — Sales picks a course, then a timing. */
  async options(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (req.user!.role === 'STUDENT') throw new AppError('Not available.', 403);
      const classes = await prisma.liveClass.findMany({
        where: { scheduledDate: todayRange(), status: { in: ['SCHEDULED', 'LIVE'] } },
        select: classSelect,
        orderBy: { startTime: 'asc' },
      });
      res.json({ success: true, data: classes });
    } catch (err) { next(err); }
  },

  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (req.user!.role === 'STUDENT') throw new AppError('Not available.', 403);
      const { mode, liveClassId, attendeeName, attendeeEmail, attendeePhone, leadId } = req.body;
      if (mode !== 'ONLINE' && mode !== 'OFFLINE') throw new AppError('Choose Online or Offline.', 400);
      const name = String(attendeeName || '').trim();
      if (name.length < 2) throw new AppError('Enter the prospect\'s name.', 400);
      const email = String(attendeeEmail || '').trim().toLowerCase();
      if (mode === 'ONLINE' && !/^\S+@\S+\.\S+$/.test(email)) throw new AppError('A valid email is required for an online demo.', 400);

      const lc = await prisma.liveClass.findUnique({ where: { id: String(liveClassId || '') }, select: classSelect });
      if (!lc) throw new AppError('Pick one of today\'s classes.', 400);
      if (lc.status === 'COMPLETED' || lc.status === 'CANCELLED') throw new AppError('That class is no longer available.', 400);
      const t = todayRange();
      if (lc.scheduledDate < t.gte || lc.scheduledDate >= t.lt) throw new AppError('Demos can only be requested for today\'s classes.', 400);

      const row = await prisma.demoSessionRequest.create({
        data: {
          mode, liveClassId: lc.id, scheduleId: lc.schedule.id, attendeeName: name,
          attendeeEmail: email || null, attendeePhone: attendeePhone ? String(attendeePhone).trim() : null,
          leadId: leadId || null, requestedById: req.user!.employeeId,
        },
      });

      // Tell the production manager(s) and this sub-batch's trainer(s) — in-app + email. Best effort.
      const requester = req.user!.employeeId
        ? await prisma.employee.findUnique({ where: { id: req.user!.employeeId }, select: { firstName: true, lastName: true } })
        : null;
      const who = requester ? `${requester.firstName} ${requester.lastName}` : 'Sales';
      const summary = `${name} (${mode === 'ONLINE' ? 'online' : 'in person'}) — ${lc.schedule.course.name}, ${lc.schedule.batch.code}${lc.schedule.code ? ` / ${lc.schedule.code}` : ''}, ${lc.startTime}–${lc.endTime}`;
      const reviewers = await reviewersFor(lc.schedule.id);
      await Promise.all(reviewers.map(async (r) => {
        await notificationService.create({
          userId: r.userId, type: 'SYSTEM', title: 'Demo class request',
          message: `${who} requested a demo sit-in: ${summary}. Please approve or reject in Demo Requests.`,
          data: { demoRequestId: row.id },
        }).catch(() => {});
        if (r.email) {
          await emailService.send({
            to: r.email, subject: `Demo request: ${name} — ${lc.schedule.course.name}`, template: 'demo-request',
            html: `<p>Hi ${r.name},</p><p>${who} has requested a demo sit-in for today's class.</p><p><b>${summary}</b></p><p>Open <b>Demo Requests</b> in the portal to approve or reject.</p>`,
          }).catch(() => {});
        }
      }));

      res.status(201).json({ success: true, data: row });
    } catch (err) { next(err); }
  },

  /** Requests the caller raised, plus (for reviewers) every request on sub-batches they can approve. */
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (req.user!.role === 'STUDENT') throw new AppError('Not available.', 403);
      const access = await getEffectiveAccess(req.user!.userId);
      const isManager = req.user!.role === 'SUPER_ADMIN' || req.user!.role === 'ADMIN'
        || access.PRODUCTION_TRAINING === 'EDIT' || access.PRODUCTION_TRAINING === 'ADMIN';

      const or: Record<string, unknown>[] = [];
      if (req.user!.employeeId) or.push({ requestedById: req.user!.employeeId });
      let mySchedules: string[] = [];
      if (!isManager && req.user!.employeeId) {
        const ta = await prisma.trainerAssignment.findMany({ where: { trainerId: req.user!.employeeId }, select: { scheduleId: true } });
        mySchedules = ta.map((x) => x.scheduleId);
        if (mySchedules.length) or.push({ scheduleId: { in: mySchedules } });
      }
      const where = isManager ? {} : (or.length ? { OR: or } : { id: '__none__' });

      const rows = await prisma.demoSessionRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 });
      const classIds = Array.from(new Set(rows.map((r) => r.liveClassId)));
      const classes = await prisma.liveClass.findMany({ where: { id: { in: classIds } }, select: classSelect });
      const byId = new Map(classes.map((c) => [c.id, c]));
      const empIds = Array.from(new Set(rows.flatMap((r) => [r.requestedById, r.reviewedById]).filter(Boolean) as string[]));
      const emps = await prisma.employee.findMany({ where: { id: { in: empIds } }, select: { id: true, firstName: true, lastName: true } });
      const empName = new Map(emps.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

      const data = rows.map((r) => ({
        ...r,
        accessCode: undefined, // never shown in the list; only the emailed prospect has it
        liveClass: byId.get(r.liveClassId) || null,
        requestedByName: r.requestedById ? empName.get(r.requestedById) || null : null,
        reviewedByName: r.reviewedById ? empName.get(r.reviewedById) || null : null,
        canReview: r.status === 'PENDING' && (isManager || mySchedules.includes(r.scheduleId)),
        isMine: !!req.user!.employeeId && r.requestedById === req.user!.employeeId,
      }));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async approve(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const r = await prisma.demoSessionRequest.findUnique({ where: { id: req.params.id } });
      if (!r) throw new AppError('Request not found.', 404);
      if (!(await canReview(req, r.scheduleId))) throw new AppError('Only the Production Manager or this sub-batch\'s trainer can approve.', 403);
      if (r.status !== 'PENDING') throw new AppError(`This request is already ${r.status.toLowerCase()}.`, 400);

      const lc = await prisma.liveClass.findUnique({ where: { id: r.liveClassId }, select: classSelect });
      if (!lc || lc.status === 'COMPLETED' || lc.status === 'CANCELLED') throw new AppError('That class has already ended or was cancelled.', 400);

      const code = r.mode === 'ONLINE' ? newCode() : null;
      await prisma.demoSessionRequest.update({
        where: { id: r.id },
        data: { status: 'APPROVED', reviewedById: req.user!.employeeId, reviewedAt: new Date(), accessCode: code, reviewNote: req.body?.note || null },
      });

      const classLine = `${lc.schedule.course.name} — ${lc.startTime} to ${lc.endTime} IST today`;
      if (r.mode === 'ONLINE' && r.attendeeEmail && code) {
        const link = `${config.FRONTEND_URL.replace(/\/$/, '')}/demo-join?code=${code}`;
        await emailService.send({
          to: r.attendeeEmail, subject: `Your demo class access — ${lc.schedule.course.name}`, template: 'demo-access',
          html: `<p>Hi ${r.attendeeName},</p>
<p>Your demo has been approved. You can sit in on our live <b>${classLine}</b> class for <b>${r.maxMinutes} minutes</b> and take part like any other student — see, speak and share your screen.</p>
<p><b>Join link:</b> <a href="${link}">${link}</a><br/><b>Access code:</b> <span style="font-size:18px;letter-spacing:2px">${code}</span></p>
<p>Open the link while the class is running, enter this email address (<b>${r.attendeeEmail}</b>) and the code. Your ${r.maxMinutes}-minute window starts when you enter the class and ends automatically.</p>
<p>Team Vinsup Skill Academy</p>`,
        });
      }

      if (r.requestedById) {
        const reqEmp = await prisma.employee.findUnique({ where: { id: r.requestedById }, select: { userId: true } });
        if (reqEmp?.userId) {
          await notificationService.create({
            userId: reqEmp.userId, type: 'SYSTEM', title: 'Demo request approved',
            message: r.mode === 'ONLINE' ? `${r.attendeeName}'s demo was approved — access email sent.` : `${r.attendeeName}'s offline demo visit was approved (${classLine}).`,
            data: { demoRequestId: r.id },
          }).catch(() => {});
        }
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async reject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const r = await prisma.demoSessionRequest.findUnique({ where: { id: req.params.id } });
      if (!r) throw new AppError('Request not found.', 404);
      if (!(await canReview(req, r.scheduleId))) throw new AppError('Only the Production Manager or this sub-batch\'s trainer can reject.', 403);
      if (r.status !== 'PENDING') throw new AppError(`This request is already ${r.status.toLowerCase()}.`, 400);
      await prisma.demoSessionRequest.update({
        where: { id: r.id },
        data: { status: 'REJECTED', reviewedById: req.user!.employeeId, reviewedAt: new Date(), reviewNote: req.body?.note || null },
      });
      if (r.requestedById) {
        const reqEmp = await prisma.employee.findUnique({ where: { id: r.requestedById }, select: { userId: true } });
        if (reqEmp?.userId) {
          await notificationService.create({
            userId: reqEmp.userId, type: 'SYSTEM', title: 'Demo request rejected',
            message: `${r.attendeeName}'s demo request was rejected${req.body?.note ? `: ${req.body.note}` : '.'}`, data: { demoRequestId: r.id },
          }).catch(() => {});
        }
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async cancel(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const r = await prisma.demoSessionRequest.findUnique({ where: { id: req.params.id } });
      if (!r) throw new AppError('Request not found.', 404);
      const mine = !!req.user!.employeeId && r.requestedById === req.user!.employeeId;
      if (!mine && !(await canReview(req, r.scheduleId))) throw new AppError('Not allowed.', 403);
      if (r.status === 'CANCELLED' || r.status === 'REJECTED') throw new AppError('Already closed.', 400);
      await prisma.demoSessionRequest.update({ where: { id: r.id }, data: { status: 'CANCELLED', expiresAt: new Date() } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};

// ── Public: the prospect joins with link/code + their email ──────────────────
export const publicDemoController = {
  async join(req: Request, res: Response, next: NextFunction) {
    try {
      const code = String(req.body?.code || '').trim().toUpperCase();
      const email = String(req.body?.email || '').trim().toLowerCase();
      if (!code || !email) throw new AppError('Enter your access code and email.', 400);

      const r = await prisma.demoSessionRequest.findUnique({ where: { accessCode: code } });
      // Same message for every mismatch so codes can't be probed.
      if (!r || r.mode !== 'ONLINE' || r.status !== 'APPROVED' || (r.attendeeEmail || '').toLowerCase() !== email) {
        throw new AppError('That code and email do not match an approved demo.', 403);
      }
      if (r.expiresAt && r.expiresAt.getTime() <= Date.now()) {
        throw new AppError(`Your ${r.maxMinutes}-minute demo window has ended. Thanks for joining!`, 403);
      }

      const lc = await prisma.liveClass.findUnique({ where: { id: r.liveClassId }, select: { id: true, title: true, status: true, roomName: true, schedule: { select: { course: { select: { name: true } } } } } });
      if (!lc || lc.status === 'CANCELLED') throw new AppError('This class was cancelled.', 400);
      if (lc.status === 'COMPLETED') throw new AppError('This class has already ended.', 400);
      if (lc.status === 'SCHEDULED') return res.json({ success: true, data: { waiting: true, title: lc.title } });

      // First entry starts the clock; re-entering inside the window keeps the original deadline.
      let expiresAt = r.expiresAt;
      if (!r.joinedAt || !expiresAt) {
        const now = new Date();
        expiresAt = new Date(now.getTime() + r.maxMinutes * 60000);
        await prisma.demoSessionRequest.update({ where: { id: r.id }, data: { joinedAt: now, expiresAt } });
      }
      const remaining = Math.max(30, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      const token = await mintAccessToken({
        roomName: lc.roomName, identity: `demo-${r.id}`, name: `${r.attendeeName} (Demo)`,
        metadata: JSON.stringify({ role: 'STUDENT', demo: true }), ttlSeconds: remaining,
      });
      res.json({ success: true, data: { waiting: false, token, url: getLiveKitUrl(), title: lc.title, course: lc.schedule.course.name, expiresAt } });
    } catch (err) { next(err); }
  },
};

/** Cron: every minute, remove demo guests whose window is up (the browser also disconnects itself, this is the enforcement). */
export async function cutExpiredDemoGuests(): Promise<number> {
  const due = await prisma.demoSessionRequest.findMany({
    where: { status: 'APPROVED', expiresAt: { lte: new Date() }, cutAt: null, joinedAt: { not: null } },
    select: { id: true, liveClassId: true },
  });
  for (const d of due) {
    const lc = await prisma.liveClass.findUnique({ where: { id: d.liveClassId }, select: { roomName: true } });
    if (lc) await removeParticipant(lc.roomName, `demo-${d.id}`).catch(() => {});
    await prisma.demoSessionRequest.update({ where: { id: d.id }, data: { cutAt: new Date() } });
  }
  return due.length;
}
