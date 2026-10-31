import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { getEffectiveAccess } from '../utils/moduleAccess';
import { leadPhoneKey } from '../utils/leadPhone';
import { emailService } from '../services/email.service';
import { computeBehind, getTargetAlertConfig, salesTargetAlertsService } from '../services/salesTargetAlerts.service';

const DAY = 86400000;
const IST_OFFSET = 5.5 * 3600 * 1000;
const empSelect = { id: true, firstName: true, lastName: true, email: true };

async function isAdmin(req: AuthRequest): Promise<boolean> {
  if (!req.user) return false;
  if (req.user.role === 'SUPER_ADMIN') return true;
  return (await getEffectiveAccess(req.user.userId)).SALES === 'ADMIN';
}
async function assertLeadAccess(req: AuthRequest, leadId: string) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead || lead.deletedAt) throw new AppError('Lead not found', 404);
  if (!(await isAdmin(req)) && lead.assignedToId !== req.user?.employeeId) throw new AppError('You do not have access to this lead', 403);
  return lead;
}
const istParts = (d: Date) => {
  const x = new Date(d.getTime() + IST_OFFSET);
  return { date: x.toISOString().slice(0, 10), hour: x.getUTCHours(), dow: x.getUTCDay() };
};
const startOfTodayIst = () => new Date(`${istParts(new Date()).date}T00:00:00+05:30`);
const fmtDate = (d: Date) => d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
const fmtTime = (d: Date) => d.toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true, timeZone: 'Asia/Kolkata' });

/** Fill {{placeholders}} from the lead, its next demo and the sender. Unknown placeholders are left blank. */
async function render(text: string, leadId: string, senderId?: string): Promise<string> {
  const [lead, demo, sender] = await Promise.all([
    prisma.lead.findUnique({ where: { id: leadId } }),
    prisma.demo.findFirst({ where: { leadId, status: { in: ['SCHEDULED', 'RESCHEDULED'] }, scheduledAt: { gte: new Date(Date.now() - DAY) } }, orderBy: { scheduledAt: 'asc' } }),
    senderId ? prisma.employee.findUnique({ where: { id: senderId }, select: { firstName: true, lastName: true } }) : null,
  ]);
  const vars: Record<string, string> = {
    name: lead?.name || '', firstName: (lead?.name || '').trim().split(/\s+/)[0] || '', course: lead?.courseInterest || 'the course',
    phone: lead?.phone || '', city: lead?.city || '', salesperson: sender ? `${sender.firstName} ${sender.lastName}` : 'Vinsup Skill Academy',
    demoDate: demo ? fmtDate(demo.scheduledAt) : '', demoTime: demo ? fmtTime(demo.scheduledAt) : '', demoMode: demo ? (demo.mode === 'ONLINE' ? 'online' : 'offline') : '',
  };
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, k: string) => vars[k] ?? '');
}

const OPEN_LEAD: Record<string, unknown> = {
  deletedAt: null, status: { notIn: ['ENROLLED', 'LOST'] },
  OR: [{ activityStatus: null }, { activityStatus: { notIn: ['NOT_INTERESTED', 'DISQUALIFIED'] } }],
};

export const salesToolsController = {
  // ── Message templates ───────────────────────────────────────────────────
  /** Active templates for everyone; admins can also see switched-off ones. */
  async listTemplates(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isAdmin(req);
      const channel = req.query.channel ? String(req.query.channel) : undefined;
      const rows = await prisma.messageTemplate.findMany({
        where: { ...(admin && req.query.all ? {} : { active: true }), ...(channel ? { channel } : {}) },
        orderBy: [{ channel: 'asc' }, { category: 'asc' }, { name: 'asc' }],
      });
      res.json({ success: true, data: rows });
    } catch (err) { next(err); }
  },
  async saveTemplate(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, channel, category, subject, body, active } = req.body || {};
      if (!String(name || '').trim()) throw new AppError('Give the template a name', 400);
      if (!['WHATSAPP', 'EMAIL'].includes(String(channel))) throw new AppError('Channel must be WhatsApp or Email', 400);
      if (!String(body || '').trim()) throw new AppError('The message text is empty', 400);
      if (channel === 'EMAIL' && !String(subject || '').trim()) throw new AppError('An email template needs a subject', 400);
      const data = { name: String(name).trim(), channel: String(channel), category: category ? String(category).trim() : null, subject: channel === 'EMAIL' ? String(subject).trim() : null, body: String(body), active: active !== false };
      const row = req.params.id
        ? await prisma.messageTemplate.update({ where: { id: req.params.id }, data })
        : await prisma.messageTemplate.create({ data: { ...data, createdById: req.user?.employeeId || null } });
      res.status(req.params.id ? 200 : 201).json({ success: true, data: row });
    } catch (err) { next(err); }
  },
  async deleteTemplate(req: AuthRequest, res: Response, next: NextFunction) {
    try { await prisma.messageTemplate.delete({ where: { id: req.params.id } }); res.json({ success: true }); } catch (err) { next(err); }
  },

  /** Rendered text of a template for one lead — shown (and editable) before sending. */
  async previewMessage(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const lead = await assertLeadAccess(req, req.params.id);
      const t = await prisma.messageTemplate.findUnique({ where: { id: String(req.query.templateId || '') } });
      if (!t || !t.active) throw new AppError('Template not found', 404);
      const body = await render(t.body, lead.id, req.user?.employeeId);
      const subject = t.subject ? await render(t.subject, lead.id, req.user?.employeeId) : null;
      res.json({ success: true, data: { channel: t.channel, subject, body, name: t.name, phone: lead.phone, email: lead.email, waPhone: leadPhoneKey(lead.phone) } });
    } catch (err) { next(err); }
  },

  /**
   * Send / log a message to a lead. EMAIL is sent from the portal to the lead's email;
   * WHATSAPP opens in the salesperson's own WhatsApp (the browser does that) and this call
   * records it in the lead's history.
   */
  async sendMessage(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const lead = await assertLeadAccess(req, req.params.id);
      const channel = String(req.body?.channel || '');
      const body = String(req.body?.body || '').trim();
      if (!['WHATSAPP', 'EMAIL'].includes(channel)) throw new AppError('Choose WhatsApp or Email', 400);
      if (!body) throw new AppError('The message is empty', 400);
      const templateName = req.body?.templateName ? String(req.body.templateName) : 'custom message';
      const actor = req.user?.employeeId || null;

      if (channel === 'EMAIL') {
        const to = String(req.body?.to || lead.email || '').trim();
        const subject = String(req.body?.subject || '').trim();
        if (!to.includes('@')) throw new AppError('This lead has no email address', 400);
        if (!subject) throw new AppError('Add a subject', 400);
        const sender = actor ? await prisma.employee.findUnique({ where: { id: actor }, select: { email: true } }) : null;
        const html = `<div style="font-family:sans-serif;font-size:14px;white-space:pre-wrap">${body.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string))}</div>`;
        await emailService.send({ to, cc: sender?.email || undefined, subject, html, template: 'salesLeadMessage' });
      }
      await prisma.leadHistory.create({
        data: {
          leadId: lead.id, actorId: actor, type: 'MESSAGE', fromValue: null, toValue: channel,
          summary: `${channel === 'EMAIL' ? 'Email sent' : 'WhatsApp message sent'}: ${templateName}`,
        },
      });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Today view ──────────────────────────────────────────────────────────
  async today(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isAdmin(req);
      const emp = admin && req.query.employeeId ? String(req.query.employeeId) : req.user?.employeeId;
      if (!emp) throw new AppError('Your account is not linked to an employee record', 400);
      const now = new Date();
      const start = startOfTodayIst();
      const end = new Date(start.getTime() + DAY);

      const [followUps, untouched, demos, tasks] = await Promise.all([
        prisma.lead.findMany({ where: { ...OPEN_LEAD, assignedToId: emp, nextFollowUpAt: { lt: end } } as Record<string, unknown>, select: { id: true, name: true, phone: true, status: true, activityStatus: true, lastContactAt: true, nextFollowUpAt: true, courseInterest: true, createdAt: true }, take: 300 }),
        prisma.lead.findMany({ where: { ...OPEN_LEAD, assignedToId: emp, lastContactAt: null, nextFollowUpAt: null } as Record<string, unknown>, select: { id: true, name: true, phone: true, status: true, activityStatus: true, lastContactAt: true, nextFollowUpAt: true, courseInterest: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 60 }),
        prisma.demo.findMany({ where: { lead: { assignedToId: emp, deletedAt: null }, status: { in: ['SCHEDULED', 'RESCHEDULED'] }, scheduledAt: { lt: end } }, select: { id: true, scheduledAt: true, mode: true, lead: { select: { id: true, name: true, phone: true, status: true, activityStatus: true, lastContactAt: true, nextFollowUpAt: true, courseInterest: true, createdAt: true } } }, take: 100 }),
        prisma.salesTask.findMany({ where: { assignedToId: emp, status: 'OPEN', dueAt: { lt: end } }, include: { lead: { select: { id: true, name: true, phone: true, status: true, activityStatus: true, lastContactAt: true, nextFollowUpAt: true, courseInterest: true, createdAt: true } } }, take: 100 }),
      ]);

      type LeadLite = { id: string; name: string; phone: string; status: string; activityStatus: string | null; lastContactAt: Date | null; nextFollowUpAt: Date | null; courseInterest: string | null; createdAt: Date };
      interface Reason { type: string; label: string; at: Date | null; score: number }
      interface Item { key: string; lead: LeadLite | null; title?: string; taskId?: string; reasons: Reason[] }
      const items = new Map<string, Item>();
      const add = (lead: LeadLite | null, reason: Reason, extra?: { taskId?: string; title?: string; key?: string }) => {
        const key = extra?.key || (lead ? `lead:${lead.id}` : `task:${extra?.taskId}`);
        if (!items.has(key)) items.set(key, { key, lead, reasons: [], ...extra });
        items.get(key)!.reasons.push(reason);
      };
      const summary = { overdue: 0, dueToday: 0, demosToday: 0, demosPending: 0, tasks: 0, untouched: 0 };

      for (const d of demos) {
        const mins = Math.round((d.scheduledAt.getTime() - now.getTime()) / 60000);
        if (d.scheduledAt < start) { summary.demosPending++; add(d.lead, { type: 'DEMO_PENDING', label: 'Demo outcome not updated', at: d.scheduledAt, score: 950 }); }
        else { summary.demosToday++; add(d.lead, { type: 'DEMO', label: `${d.mode === 'ONLINE' ? 'Online' : 'Offline'} demo at ${fmtTime(d.scheduledAt)}`, at: d.scheduledAt, score: 1000 - Math.max(0, Math.min(mins, 900)) / 10 }); }
      }
      for (const l of followUps) {
        const at = l.nextFollowUpAt!;
        // A booked demo's slot is already listed as the demo — don't repeat it as a follow-up at the same time.
        if (demos.some((d) => d.lead.id === l.id && Math.abs(d.scheduledAt.getTime() - at.getTime()) < 120000)) continue;
        if (at < start) {
          const days = Math.floor((start.getTime() - at.getTime()) / DAY) + 1;
          summary.overdue++; add(l, { type: 'OVERDUE', label: `Follow-up overdue ${days} day${days === 1 ? '' : 's'}`, at, score: 800 + Math.min(days, 30) * 5 });
        } else {
          summary.dueToday++; add(l, { type: 'FOLLOW_UP', label: `Follow-up at ${fmtTime(at)}`, at, score: at <= now ? 760 : 700 - Math.min(600, Math.round((at.getTime() - now.getTime()) / 60000)) / 10 });
        }
      }
      for (const t of tasks) {
        const overdue = !!t.dueAt && t.dueAt < start;
        summary.tasks++;
        add(t.lead || null, { type: 'TASK', label: `Task${overdue ? ' (overdue)' : ''}: ${t.title}`, at: t.dueAt, score: overdue ? 600 : 500 }, { taskId: t.id, title: t.title, key: t.lead ? undefined : `task:${t.id}` });
      }
      for (const l of untouched) {
        const hours = (now.getTime() - l.createdAt.getTime()) / 3600000;
        summary.untouched++; add(l, { type: 'NEW', label: 'New lead — not contacted yet', at: l.createdAt, score: 650 + Math.min(10, Math.floor(hours / 24)) * 5 });
      }

      const out = Array.from(items.values()).map((it) => {
        const reasons = it.reasons.sort((a, b) => b.score - a.score);
        return {
          key: it.key, lead: it.lead, taskId: it.taskId || null, title: it.title || null,
          reasons: reasons.map((r) => ({ type: r.type, label: r.label, at: r.at })),
          score: Math.round(reasons[0].score + (reasons.length - 1) * 10),
        };
      }).sort((a, b) => b.score - a.score);

      res.json({ success: true, data: { summary: { ...summary, total: out.length }, items: out } });
    } catch (err) { next(err); }
  },

  // ── Call analytics ──────────────────────────────────────────────────────
  /**
   * Talk time, calls per day, connected vs not connected and best hours to reach leads.
   * "Connected": auto-tracked calls with talk time > 0 that were not missed; manual entries unless the status was DNP.
   */
  async callAnalytics(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isAdmin(req);
      const from = req.query.from ? new Date(`${String(req.query.from)}T00:00:00+05:30`) : new Date(startOfTodayIst().getTime() - 29 * DAY);
      const to = req.query.to ? new Date(`${String(req.query.to)}T23:59:59.999+05:30`) : new Date();
      if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new AppError('Invalid dates', 400);
      const where: Record<string, unknown> = { calledAt: { gte: from, lte: to }, calledById: { not: null } };
      if (!admin) where.calledById = req.user?.employeeId || '__none__';
      else if (req.query.employeeId) where.calledById = String(req.query.employeeId);

      const logs = await prisma.leadCallLog.findMany({
        where, select: { calledById: true, calledAt: true, durationSeconds: true, direction: true, source: true, activityStatus: true, statusKey: true },
        take: 200000,
      });
      const emps = await prisma.employee.findMany({ where: { id: { in: Array.from(new Set(logs.map((l) => l.calledById).filter(Boolean) as string[])) } }, select: { id: true, firstName: true, lastName: true } });
      const names = new Map(emps.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));

      const blank = () => ({ calls: 0, connected: 0, talkSeconds: 0, missed: 0, inbound: 0, outbound: 0 });
      type S = ReturnType<typeof blank>;
      const bump = (s: S, connected: boolean, l: (typeof logs)[number]) => {
        s.calls++; if (connected) s.connected++; s.talkSeconds += l.durationSeconds || 0;
        if (l.direction === 'MISSED') s.missed++; else if (l.direction === 'INBOUND') s.inbound++; else if (l.direction === 'OUTBOUND') s.outbound++;
      };
      const totals = blank();
      const perPerson = new Map<string, S & { name: string; days: Set<string>; dnp: number; first: Date; last: Date; outcomes: Map<string, number>; byDay: Map<string, { calls: number; connected: number; talk: number }> }>();
      const perDay = new Map<string, S>();
      const perHour = Array.from({ length: 24 }, () => ({ calls: 0, connected: 0 }));
      const perWeekday = Array.from({ length: 7 }, () => ({ calls: 0, connected: 0 }));

      for (const l of logs) {
        const connected = l.source === 'AUTO' ? (l.durationSeconds || 0) > 0 && l.direction !== 'MISSED' : l.activityStatus !== 'DNP';
        const p = istParts(l.calledAt);
        bump(totals, connected, l);
        if (!perDay.has(p.date)) perDay.set(p.date, blank());
        bump(perDay.get(p.date)!, connected, l);
        const pid = l.calledById as string;
        if (!perPerson.has(pid)) perPerson.set(pid, { ...blank(), name: names.get(pid) || 'Unknown', days: new Set(), dnp: 0, first: l.calledAt, last: l.calledAt, outcomes: new Map(), byDay: new Map() });
        const pp = perPerson.get(pid)!; bump(pp, connected, l); pp.days.add(p.date);
        if (!connected) pp.dnp++;
        if (l.calledAt < pp.first) pp.first = l.calledAt;
        if (l.calledAt > pp.last) pp.last = l.calledAt;
        const outcome = l.statusKey || l.activityStatus || (l.source === 'AUTO' ? (connected ? 'AUTO_CONNECTED' : 'AUTO_NOT_CONNECTED') : 'NO_STATUS');
        pp.outcomes.set(outcome, (pp.outcomes.get(outcome) || 0) + 1);
        const bd = pp.byDay.get(p.date) || { calls: 0, connected: 0, talk: 0 };
        bd.calls++; if (connected) bd.connected++; bd.talk += l.durationSeconds || 0; pp.byDay.set(p.date, bd);
        perHour[p.hour].calls++; if (connected) perHour[p.hour].connected++;
        perWeekday[p.dow].calls++; if (connected) perWeekday[p.dow].connected++;
      }

      // Fill every day in range so the chart has no gaps.
      const days: { date: string; calls: number; connected: number; talkSeconds: number }[] = [];
      for (let t = from.getTime(); t <= to.getTime() && days.length < 400; t += DAY) {
        const date = istParts(new Date(t)).date;
        const s = perDay.get(date) || blank();
        if (!days.length || days[days.length - 1].date !== date) days.push({ date, calls: s.calls, connected: s.connected, talkSeconds: s.talkSeconds });
      }
      const rate = (c: number, n: number) => (n ? Math.round((c / n) * 1000) / 10 : 0);
      // Team lead roll-up (from the Sales Team mapping).
      const tmap = await prisma.salesTeamMap.findMany();
      const tlOf = new Map(tmap.map((m) => [m.employeeId, m.tlId]));
      const tlIds = Array.from(new Set([...tmap.map((m) => m.tlId)]));
      const tlEmps = await prisma.employee.findMany({ where: { id: { in: tlIds } }, select: { id: true, firstName: true, lastName: true } });
      const tlName = new Map(tlEmps.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
      const perTl = new Map<string, { name: string; calls: number; connected: number; talkSeconds: number; members: number; outcomes: Map<string, number> }>();
      for (const [pid, s] of perPerson) {
        const tid = tlOf.get(pid) || (tlIds.includes(pid) ? pid : '');
        const key = tid || '__none__';
        if (!perTl.has(key)) perTl.set(key, { name: tid ? tlName.get(tid) || 'Unknown' : 'No team lead', calls: 0, connected: 0, talkSeconds: 0, members: 0, outcomes: new Map() });
        const t = perTl.get(key)!; t.calls += s.calls; t.connected += s.connected; t.talkSeconds += s.talkSeconds; t.members++;
        for (const [o, n] of s.outcomes) t.outcomes.set(o, (t.outcomes.get(o) || 0) + n);
      }
      const objOf = (m: Map<string, number>) => Object.fromEntries(m);
      const iso = (d: Date) => d.toISOString();
      res.json({
        success: true,
        data: {
          perTl: Array.from(perTl.values()).map((t) => ({ name: t.name, members: t.members, calls: t.calls, connected: t.connected, connectRate: rate(t.connected, t.calls), talkSeconds: t.talkSeconds, outcomes: objOf(t.outcomes) })).sort((a, b) => b.calls - a.calls),
          totals: { ...totals, notConnected: totals.calls - totals.connected, connectRate: rate(totals.connected, totals.calls), avgTalkSeconds: totals.connected ? Math.round(totals.talkSeconds / totals.connected) : 0, callsPerDay: days.length ? Math.round((totals.calls / days.length) * 10) / 10 : 0 },
          perPerson: Array.from(perPerson.entries()).map(([employeeId, s]) => ({
            employeeId, name: s.name, calls: s.calls, connected: s.connected, connectRate: rate(s.connected, s.calls), talkSeconds: s.talkSeconds,
            avgTalkSeconds: s.connected ? Math.round(s.talkSeconds / s.connected) : 0, missed: s.missed, activeDays: s.days.size, callsPerDay: s.days.size ? Math.round((s.calls / s.days.size) * 10) / 10 : 0,
            dnp: s.dnp, tl: tlName.get(tlOf.get(employeeId) || '') || '', firstCall: iso(s.first), lastCall: iso(s.last), avgCallSeconds: s.calls ? Math.round(s.talkSeconds / s.calls) : 0,
            outcomes: objOf(s.outcomes), byDay: Array.from(s.byDay.entries()).sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => ({ date, ...v })),
          })).sort((a, b) => b.calls - a.calls),
          days,
          hours: perHour.map((h, hour) => ({ hour, calls: h.calls, connected: h.connected, connectRate: rate(h.connected, h.calls) })),
          weekdays: perWeekday.map((h, dow) => ({ dow, calls: h.calls, connected: h.connected, connectRate: rate(h.connected, h.calls) })),
        },
      });
    } catch (err) { next(err); }
  },

  async callDetails(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isAdmin(req);
      const from = req.query.from ? new Date(`${String(req.query.from)}T00:00:00+05:30`) : new Date(startOfTodayIst().getTime() - 29 * DAY);
      const to = req.query.to ? new Date(`${String(req.query.to)}T23:59:59.999+05:30`) : new Date();
      if (isNaN(from.getTime()) || isNaN(to.getTime())) throw new AppError('Invalid dates', 400);
      const where: Record<string, unknown> = { calledAt: { gte: from, lte: to }, calledById: { not: null } };
      if (!admin) where.calledById = req.user?.employeeId || '__none__';
      else if (req.query.employeeId) where.calledById = String(req.query.employeeId);
      const logs = await prisma.leadCallLog.findMany({
        where, orderBy: { calledAt: 'asc' }, take: 50000,
        select: { calledAt: true, durationSeconds: true, direction: true, source: true, activityStatus: true, statusKey: true, notes: true, rawPhoneNumber: true,
          calledBy: { select: { firstName: true, lastName: true } }, lead: { select: { name: true, phone: true } } },
      });
      const rows = logs.map((l) => {
        const p = istParts(l.calledAt);
        const connected = l.source === 'AUTO' ? (l.durationSeconds || 0) > 0 && l.direction !== 'MISSED' : l.activityStatus !== 'DNP';
        return {
          date: p.date, time: l.calledAt.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour12: true }), salesperson: l.calledBy ? `${l.calledBy.firstName} ${l.calledBy.lastName}` : '',
          lead: l.lead?.name || '', phone: l.lead?.phone || l.rawPhoneNumber || '', direction: l.direction || '', source: l.source, connected: connected ? 'Yes' : 'No',
          durationSeconds: l.durationSeconds || 0, status: l.statusKey || l.activityStatus || '', notes: l.notes || '',
        };
      });
      res.json({ success: true, data: rows });
    } catch (err) { next(err); }
  },

  // ── Target alerts (admin) ───────────────────────────────────────────────
  async targetConfig(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const cfg = await getTargetAlertConfig();
      const { rows, day, daysInMonth, monthLabel } = await computeBehind(cfg.behindPercent);
      res.json({ success: true, data: { config: cfg, status: { day, daysInMonth, monthLabel, rows } } });
    } catch (err) { next(err); }
  },
  async saveTargetConfig(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const cfg = await getTargetAlertConfig();
      const days = String(req.body?.checkDays ?? cfg.checkDays).split(/[,;\s]+/).map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 31);
      if (!days.length) throw new AppError('Enter at least one day of the month (1–31)', 400);
      const behindPercent = Number(req.body?.behindPercent ?? cfg.behindPercent);
      if (!Number.isFinite(behindPercent) || behindPercent < 1 || behindPercent > 100) throw new AppError('Percent must be between 1 and 100', 400);
      const sendHour = Number(req.body?.sendHour ?? cfg.sendHour);
      if (!Number.isInteger(sendHour) || sendHour < 0 || sendHour > 23) throw new AppError('Send hour must be 0–23', 400);
      const emails = String(req.body?.adminEmails || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
      if (emails.some((e) => !e.includes('@'))) throw new AppError('One of the admin emails is not valid', 400);
      const saved = await prisma.salesTargetAlertConfig.update({
        where: { id: cfg.id },
        data: {
          active: req.body?.active !== false, checkDays: Array.from(new Set(days)).sort((a, b) => a - b).join(','), behindPercent: Math.round(behindPercent),
          notifyOwner: req.body?.notifyOwner !== false, notifyAdmins: req.body?.notifyAdmins !== false, adminEmails: emails.length ? emails.join(', ') : null, sendHour,
        },
      });
      res.json({ success: true, data: saved });
    } catch (err) { next(err); }
  },
  async sendTargetAlertsNow(_req: AuthRequest, res: Response, next: NextFunction) {
    try { res.json({ success: true, data: await salesTargetAlertsService.run(await getTargetAlertConfig()) }); } catch (err) { next(err); }
  },
};
