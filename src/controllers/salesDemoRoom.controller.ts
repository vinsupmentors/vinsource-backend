import { Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { config } from '../config/env';
import { getEffectiveAccess } from '../utils/moduleAccess';
import { emailService } from '../services/email.service';
import { notificationService } from '../services/notification.service';
import { mintAccessToken, getLiveKitUrl, ensureRoom, closeRoom, listLiveParticipants, startAudioEgress } from '../services/liveKit.service';
import { transcriptionEnabled } from '../services/transcription.service';
import { closeDemoTask, applyDemoOutcome, OUTCOME_PLAN, fmtIST } from '../utils/salesFlow';
import { resolveStage } from '../utils/leadConfig';

/**
 * Sales online demos hosted inside the portal. The BDA hosts the room, the
 * prospect joins from an emailed link + code, and any Sales Admin can sit in
 * silently at any time. The room runs for `maxMinutes` (60) from the moment
 * the host first enters; when time is up it closes, and only a Sales Admin
 * can reopen it (the BDA files a reopen request).
 */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function newDemoCode(): string {
  let c = '';
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) c += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return c;
}

const fmt = (d: Date) => d.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' });
const joinLink = (code: string) => `${config.FRONTEND_URL.replace(/\/$/, '')}/demo-join?code=${code}`;
const hostLink = (id: string) => `${config.FRONTEND_URL.replace(/\/$/, '')}/sales-demo/${id}`;

async function isAdmin(req: AuthRequest): Promise<boolean> {
  if (!req.user) return false;
  if (req.user.role === 'SUPER_ADMIN') return true;
  return (await getEffectiveAccess(req.user.userId)).SALES === 'ADMIN';
}

/** Everyone with SALES=ADMIN: per-user grants plus the department defaults. */
export async function salesAdmins(): Promise<{ userId: string; email: string | null; name: string }[]> {
  const [grants, emps] = await Promise.all([
    prisma.userModuleAccess.findMany({ where: { module: 'SALES', accessLevel: 'ADMIN' }, include: { user: { include: { employee: true } } } }),
    prisma.employee.findMany({
      where: { status: 'ACTIVE', department: { moduleAccessDefaults: { some: { module: 'SALES', accessLevel: 'ADMIN' } } } },
      select: { userId: true, email: true, firstName: true, lastName: true },
    }),
  ]);
  const map = new Map<string, { userId: string; email: string | null; name: string }>();
  for (const e of emps) if (e.userId) map.set(e.userId, { userId: e.userId, email: e.email, name: `${e.firstName} ${e.lastName}` });
  for (const g of grants) {
    map.set(g.userId, { userId: g.userId, email: g.user.employee?.email || g.user.email, name: g.user.employee ? `${g.user.employee.firstName} ${g.user.employee.lastName}` : g.user.email });
  }
  return Array.from(map.values());
}

export async function notifySalesAdmins(title: string, message: string, html: string, demoId: string) {
  const admins = await salesAdmins();
  await Promise.all(admins.map(async (a) => {
    await notificationService.create({ userId: a.userId, type: 'SYSTEM', title, message, data: { demoId } }).catch(() => {});
    if (a.email) await emailService.send({ to: a.email, subject: title, template: 'sales-demo', html: `<p>Hi ${a.name},</p>${html}` }).catch(() => {});
  }));
}

/** Called right after an ONLINE demo is booked: tell Sales Admin and email the prospect their link. */
export async function announceOnlineDemo(demoId: string, bookedByName: string) {
  const d = await prisma.demo.findUnique({
    where: { id: demoId },
    include: { lead: { select: { name: true, email: true, phone: true } }, conductedBy: { select: { firstName: true, lastName: true } } },
  });
  if (!d || !d.accessCode) return;
  const host = d.conductedBy ? `${d.conductedBy.firstName} ${d.conductedBy.lastName}` : bookedByName;
  const when = fmt(d.scheduledAt);
  await notifySalesAdmins(
    `Online demo booked — ${d.lead.name}`,
    `${bookedByName} booked an online demo for ${d.lead.name} (${d.courseEnquired || 'course not set'}) on ${when}, hosted by ${host}.`,
    `<p>An <b>online demo</b> was booked.</p><p><b>${d.lead.name}</b> — ${d.courseEnquired || 'course not set'}<br/>When: ${when}<br/>Hosted by: ${host}<br/>Booking: ${d.bookingNumber}</p><p>You can watch it live any time from <b>Sales → Live Demos</b> in the portal.</p>`,
    d.id,
  );
  if (d.lead.email) {
    await emailService.send({
      to: d.lead.email, subject: `Your online demo — ${d.courseEnquired || 'Vinsup Skill Academy'}`, template: 'sales-demo-invite',
      html: `<p>Hi ${d.lead.name},</p><p>Your online demo is booked for <b>${when}</b> (IST)${d.courseEnquired ? ` — <b>${d.courseEnquired}</b>` : ''}.</p>
<p><b>Join link:</b> <a href="${joinLink(d.accessCode)}">${joinLink(d.accessCode)}</a><br/><b>Access code:</b> <span style="font-size:18px;letter-spacing:2px">${d.accessCode}</span></p>
<p>Open the link at the scheduled time and enter this email address (<b>${d.lead.email}</b>) and the code. The session runs for ${d.maxMinutes} minutes.</p><p>Team Vinsup Skill Academy</p>`,
    }).catch(() => {});
  }
}

async function loadDemo(req: AuthRequest, id: string) {
  const d = await prisma.demo.findUnique({
    where: { id },
    include: { lead: { select: { id: true, name: true, assignedToId: true, deletedAt: true } } },
  });
  if (!d || !d.roomName) throw new AppError('Online demo room not found', 404);
  return d;
}

async function assertHost(req: AuthRequest, d: { lead: { assignedToId: string | null } }) {
  if (await isAdmin(req)) return;
  if (d.lead.assignedToId !== req.user?.employeeId) throw new AppError('You do not have access to this demo', 403);
}

export const salesDemoRoomController = {
  /** Host (the lead's BDA, or a Sales Admin) enters the room. First entry starts the 60-minute clock. */
  async host(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const d = await loadDemo(req, req.params.id);
      await assertHost(req, d);
      if (d.status === 'CANCELLED' || d.status === 'RESCHEDULED') throw new AppError(`This demo is ${d.status.toLowerCase()}.`, 400);
      if (d.closedAt) throw new AppError('This demo room is closed. Ask your Sales Admin to reopen it.', 403);

      let expiresAt = d.expiresAt;
      if (!d.startedAt || !expiresAt) {
        const now = new Date();
        expiresAt = new Date(now.getTime() + d.maxMinutes * 60000);
        await prisma.demo.update({ where: { id: d.id }, data: { startedAt: now, expiresAt } });
      }
      await ensureRoom(d.roomName!);
      // Audio-only recording for transcription — best effort, one per opening of the room, never blocks the demo.
      if (transcriptionEnabled() && !d.audioEgressId) {
        try {
          const eg = await startAudioEgress(d.roomName!, d.id);
          if (eg) await prisma.demo.update({ where: { id: d.id }, data: { audioEgressId: eg.egressId } });
        } catch (e) { console.error('[transcribe] could not start demo audio recording:', e); }
      }
      const remaining = Math.max(30, Math.floor((expiresAt.getTime() - Date.now()) / 1000));
      const me = req.user!.employeeId
        ? await prisma.employee.findUnique({ where: { id: req.user!.employeeId }, select: { firstName: true, lastName: true } })
        : null;
      const token = await mintAccessToken({
        roomName: d.roomName!, identity: `host-${req.user!.userId}`, name: me ? `${me.firstName} ${me.lastName} (Host)` : 'Host',
        metadata: JSON.stringify({ role: 'TRAINER', demo: true }), ttlSeconds: remaining,
      });
      res.json({ success: true, data: { token, url: getLiveKitUrl(), expiresAt, title: `Demo — ${d.lead.name}`, course: d.courseEnquired, accessCode: d.accessCode, joinLink: joinLink(d.accessCode!) } });
    } catch (err) { next(err); }
  },

  /**
   * Host ends the demo: room closes for everyone, the demo is marked conducted (the portal session is its own proof),
   * the demo task is completed and — if an outcome is given — the lead moves on (see OUTCOME_PLAN).
   */
  async end(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const d = await loadDemo(req, req.params.id);
      await assertHost(req, d);
      const { outcome, feedback, followUpAt } = req.body || {};
      if (outcome && !OUTCOME_PLAN[String(outcome)]) throw new AppError('Unknown demo outcome', 400);
      if (followUpAt && isNaN(new Date(followUpAt).getTime())) throw new AppError('Invalid follow-up date', 400);
      await closeRoom(d.roomName!).catch(() => {});
      await prisma.demo.update({
        where: { id: d.id },
        data: {
          closedAt: d.closedAt ?? new Date(), expiresAt: new Date(), status: 'COMPLETED', completedAt: new Date(),
          startedAt: d.startedAt ?? new Date(),
          feedback: feedback ? String(feedback).slice(0, 2000) : undefined, outcome: outcome || undefined,
          reopenRequestedAt: null,
        },
      });
      await closeDemoTask(d.id, 'DONE');
      const stage = await resolveStage('DEMO_DONE');
      await prisma.lead.update({ where: { id: d.leadId }, data: { status: stage.status as never, stageKey: stage.stageKey, activityStatus: 'DEMO_OVER', statusKey: null, lastContactAt: new Date() } });
      await prisma.leadHistory.create({ data: { leadId: d.leadId, actorId: req.user?.employeeId || null, type: 'DEMO', summary: `Online demo ${d.bookingNumber} ended by host` } }).catch(() => {});
      if (outcome) await applyDemoOutcome(d.leadId, String(outcome), req.user?.employeeId, followUpAt ? new Date(followUpAt) : null);
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** Sales Admin watches silently — can't publish audio/video, works any time the room exists. */
  async observe(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!(await isAdmin(req))) throw new AppError('Only Sales Admin can observe demos', 403);
      const d = await loadDemo(req, req.params.id);
      const me = req.user!.employeeId
        ? await prisma.employee.findUnique({ where: { id: req.user!.employeeId }, select: { firstName: true, lastName: true } })
        : null;
      const token = await mintAccessToken({
        roomName: d.roomName!, identity: `observer-${req.user!.userId}`, name: `${me ? `${me.firstName} ${me.lastName}` : 'Sales Admin'} (Observer)`,
        metadata: JSON.stringify({ role: 'OBSERVER', demo: true }), canPublish: false, ttlSeconds: 2 * 3600,
      });
      res.json({ success: true, data: { token, url: getLiveKitUrl(), title: `Demo — ${d.lead.name}`, course: d.courseEnquired, expiresAt: d.expiresAt, closed: !!d.closedAt } });
    } catch (err) { next(err); }
  },

  /** BDA asks to reopen a room that timed out. */
  async requestReopen(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const d = await loadDemo(req, req.params.id);
      await assertHost(req, d);
      if (!d.closedAt) throw new AppError('This demo room is still open.', 400);
      if (d.reopenRequestedAt) throw new AppError('A reopen request is already waiting for approval.', 400);
      const note = req.body?.note ? String(req.body.note).slice(0, 500) : null;
      await prisma.demo.update({ where: { id: d.id }, data: { reopenRequestedAt: new Date(), reopenNote: note } });
      const me = req.user!.employeeId
        ? await prisma.employee.findUnique({ where: { id: req.user!.employeeId }, select: { firstName: true, lastName: true } })
        : null;
      const who = me ? `${me.firstName} ${me.lastName}` : 'A BDA';
      await notifySalesAdmins(
        `Demo reopen request — ${d.lead.name}`,
        `${who} asked to reopen the demo with ${d.lead.name}${note ? `: ${note}` : '.'}`,
        `<p><b>${who}</b> asked to reopen the closed demo room for <b>${d.lead.name}</b>${note ? `.<br/>Reason: ${note}` : '.'}</p><p>Approve or reject it in <b>Sales → Live Demos</b>.</p>`,
        d.id,
      );
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** Sales Admin approves (fresh full window) or rejects a reopen request. */
  async decideReopen(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!(await isAdmin(req))) throw new AppError('Only Sales Admin can reopen a demo', 403);
      const d = await loadDemo(req, req.params.id);
      const approve = req.body?.approve !== false;
      // An admin may also reopen a closed room directly, without a prior request.
      if (!d.closedAt) throw new AppError('This demo room is not closed.', 400);
      if (approve) {
        await prisma.demo.update({
          where: { id: d.id },
          // audioEgressId reset → the reopened session is recorded too (as a separate file; the latest one is transcribed).
          data: { closedAt: null, expiresAt: new Date(Date.now() + d.maxMinutes * 60000), reopenRequestedAt: null, reopenNote: null, reopenCount: { increment: 1 }, audioEgressId: null },
        });
      } else {
        await prisma.demo.update({ where: { id: d.id }, data: { reopenRequestedAt: null } });
      }
      if (d.lead.assignedToId) {
        const bda = await prisma.employee.findUnique({ where: { id: d.lead.assignedToId }, select: { userId: true } });
        if (bda?.userId) {
          await notificationService.create({
            userId: bda.userId, type: 'SYSTEM', title: approve ? 'Demo reopened' : 'Demo reopen rejected',
            message: approve ? `Your demo with ${d.lead.name} was reopened for ${d.maxMinutes} more minutes.` : `Your request to reopen the demo with ${d.lead.name} was rejected.`,
            data: { demoId: d.id },
          }).catch(() => {});
        }
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** Sales Admin board: every online demo from the last 30 days (and anything upcoming) with its live state. */
  async board(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      if (!(await isAdmin(req))) throw new AppError('Only Sales Admin can view live demos', 403);
      const since = new Date(Date.now() - 30 * 86400000);
      const demos = await prisma.demo.findMany({
        where: { roomName: { not: null }, status: { in: ['SCHEDULED', 'COMPLETED'] }, OR: [{ scheduledAt: { gte: since } }, { closedAt: null }] },
        include: {
          lead: { select: { id: true, name: true, phone: true, assignedTo: { select: { firstName: true, lastName: true } } } },
          conductedBy: { select: { firstName: true, lastName: true } },
        },
        orderBy: { scheduledAt: 'desc' },
        take: 200,
      });
      const now = Date.now();
      const data = await Promise.all(demos.map(async (d) => {
        const running = !!d.startedAt && !d.closedAt && !!d.expiresAt && d.expiresAt.getTime() > now;
        const people = running ? await listLiveParticipants(d.roomName!) : [];
        const state = d.reopenRequestedAt ? 'REOPEN_REQUESTED' : d.closedAt ? 'CLOSED' : running ? 'LIVE' : d.startedAt ? 'CLOSED' : 'NOT_STARTED';
        return {
          id: d.id, bookingNumber: d.bookingNumber, scheduledAt: d.scheduledAt, course: d.courseEnquired, state,
          startedAt: d.startedAt, expiresAt: d.expiresAt, closedAt: d.closedAt, reopenNote: d.reopenNote, reopenCount: d.reopenCount,
          lead: d.lead, host: d.conductedBy ? `${d.conductedBy.firstName} ${d.conductedBy.lastName}` : d.lead.assignedTo ? `${d.lead.assignedTo.firstName} ${d.lead.assignedTo.lastName}` : null,
          participants: people.filter((p) => !p.identity.startsWith('observer-')).length,
        };
      }));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },
};

/** Cron: close sales demo rooms whose 60 minutes are up. Returns how many were closed. */
export async function closeExpiredSalesDemos(): Promise<number> {
  const due = await prisma.demo.findMany({
    where: { roomName: { not: null }, startedAt: { not: null }, closedAt: null, expiresAt: { lte: new Date() } },
    select: { id: true, roomName: true, leadId: true, status: true },
  });
  for (const d of due) {
    await closeRoom(d.roomName!).catch(() => {});
    await prisma.demo.update({ where: { id: d.id }, data: { closedAt: new Date(), ...(d.status === 'SCHEDULED' ? { status: 'COMPLETED', completedAt: new Date() } : {}) } });
    // The host never pressed End demo: the demo still happened, so move the lead to Demo done + a follow-up and close the task.
    if (d.status === 'SCHEDULED') {
      await applyDemoOutcome(d.leadId, 'NEED_FOLLOWUP', null).catch((e) => console.error('Auto demo outcome failed', e));
      await closeDemoTask(d.id, 'DONE').catch(() => {});
    }
  }
  return due.length;
}

/**
 * Cron (every minute): "starts in 10 minutes" reminder to the student (email, with join details) and to the
 * advisor (email + bell). Sent once per demo (Demo.reminderSentAt).
 */
export async function sendDemoReminders(): Promise<number> {
  const now = new Date();
  const due = await prisma.demo.findMany({
    where: { status: 'SCHEDULED', reminderSentAt: null, scheduledAt: { lte: new Date(now.getTime() + 10 * 60000), gt: new Date(now.getTime() - 30 * 60000) } },
    include: {
      lead: { select: { name: true, email: true, assignedTo: { select: { userId: true, email: true, firstName: true } } } },
      conductedBy: { select: { userId: true, email: true, firstName: true } },
    },
  });
  for (const d of due) {
    // Claim first so an overlapping tick can't double-send.
    const claimed = await prisma.demo.updateMany({ where: { id: d.id, reminderSentAt: null }, data: { reminderSentAt: new Date() } });
    if (claimed.count === 0) continue;
    const when = fmtIST(d.scheduledAt);
    const online = d.mode === 'ONLINE' && !!d.accessCode;
    const course = d.courseEnquired || 'your course';
    const advisor = d.conductedBy || d.lead.assignedTo;
    if (d.lead.email) {
      await emailService.send({
        to: d.lead.email, subject: `Reminder: your demo starts in 10 minutes — ${course}`, template: 'sales-demo-reminder',
        html: `<p>Hi ${d.lead.name},</p><p>Your demo for <b>${course}</b> starts at <b>${when}</b> (IST) — in about 10 minutes.</p>${
          online ? `<p><b>Join link:</b> <a href="${joinLink(d.accessCode!)}">${joinLink(d.accessCode!)}</a><br/><b>Access code:</b> <span style="font-size:18px;letter-spacing:2px">${d.accessCode}</span><br/>Enter this email address (<b>${d.lead.email}</b>) and the code. Please keep your camera and microphone ready.</p>` : '<p>Please reach the academy a few minutes early.</p>'
        }<p>Team Vinsup Skill Academy</p>`,
      }).catch(() => {});
    }
    if (advisor) {
      const title = `Demo in 10 minutes — ${d.lead.name}`;
      const msg = `${d.lead.name}'s ${online ? 'online ' : ''}demo (${course}) starts at ${when}.`;
      if (advisor.userId) await notificationService.create({ userId: advisor.userId, type: 'SYSTEM', title, message: msg, data: { demoId: d.id } }).catch(() => {});
      if (advisor.email) {
        await emailService.send({
          to: advisor.email, subject: title, template: 'sales-demo-reminder-advisor',
          html: `<p>Hi ${advisor.firstName},</p><p>${msg}</p>${online ? `<p>Start the room: <a href="${hostLink(d.id)}">${hostLink(d.id)}</a> (the 60-minute clock starts when you enter).</p>` : ''}`,
        }).catch(() => {});
      }
    }
  }
  return due.length;
}
