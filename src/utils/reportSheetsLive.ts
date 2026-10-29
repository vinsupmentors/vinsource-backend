import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { leadConfig } from './leadConfig';

const IST_MS = 5.5 * 3600 * 1000;
const DAY = 86400000;
const istDate = (d: Date) => new Date(d.getTime() + IST_MS).toISOString().slice(0, 10);
const dayStart = (s: string) => new Date(`${s}T00:00:00+05:30`);

export function parseRange(q: { from?: unknown; to?: unknown }) {
  const today = istDate(new Date());
  const ok = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  let from = ok(q.from) || today;
  let to = ok(q.to) || from;
  if (to < from) [from, to] = [to, from];
  const start = dayStart(from);
  const end = new Date(dayStart(to).getTime() + DAY);
  const days = Math.round((end.getTime() - start.getTime()) / DAY);
  if (days > 93) throw new AppError('Choose a range of up to 93 days', 400);
  return { from, to, start, end, days };
}

const fullName = (e: { firstName: string; lastName: string }) => `${e.firstName} ${e.lastName}`.trim();

interface Advisor { id: string; name: string; tl: string; bookingTarget: number; demoTarget: number }

/** Everyone who works leads, with their Team Lead from the Sales team mapping (a TL is their own TL; unmapped → "Direct Reporting"). */
export async function loadAdvisors(extraIds: string[] = []): Promise<Map<string, Advisor>> {
  const maps = await prisma.salesTeamMap.findMany();
  const tlOf = new Map(maps.map((m) => [m.employeeId, m.tlId]));
  const tlIds = new Set(maps.map((m) => m.tlId));
  const emps = await prisma.employee.findMany({
    where: { OR: [{ status: { in: ['ACTIVE', 'ON_PROBATION'] }, assignedLeads: { some: { deletedAt: null } } }, { id: { in: [...extraIds, ...tlOf.keys(), ...tlIds] } }] },
    select: { id: true, firstName: true, lastName: true },
  });
  const byId = new Map(emps.map((e) => [e.id, e]));
  const targets = await prisma.bdaDailyTarget.findMany({ where: { employeeId: { in: [...byId.keys()] } } });
  const tMap = new Map(targets.map((t) => [t.employeeId, t]));
  const out = new Map<string, Advisor>();
  for (const e of emps) {
    const tlId = tlOf.get(e.id);
    const tlEmp = tlId ? byId.get(tlId) : undefined;
    const tl = tlEmp ? fullName(tlEmp) : tlIds.has(e.id) ? fullName(e) : 'Direct Reporting';
    const t = tMap.get(e.id);
    out.set(e.id, { id: e.id, name: fullName(e), tl, bookingTarget: t?.bookingTarget ?? 5, demoTarget: t?.demoTarget ?? 2 });
  }
  return out;
}

const demoInclude = {
  lead: { select: { id: true, name: true, phone: true, source: true, status: true, stageKey: true, activityStatus: true, assignedToId: true, callLogs: { orderBy: { calledAt: 'desc' as const }, take: 1, select: { notes: true } } } },
  conductedBy: { select: { id: true } },
};
type DemoRow = Awaited<ReturnType<typeof fetchDemos>>[number];
const fetchDemos = (where: Prisma.DemoWhereInput) => prisma.demo.findMany({ where, include: demoInclude, orderBy: { scheduledAt: 'asc' }, take: 5000 });
const owner = (d: DemoRow) => d.lead.assignedToId || d.conductedById || '';

const OUTCOMES = ['INTERESTED', 'FIFTY_FIFTY', 'NEED_FOLLOWUP', 'NOT_INTERESTED'] as const;
const OUTCOME_LABEL: Record<string, string> = { INTERESTED: 'Interested', FIFTY_FIFTY: '50 - 50', NEED_FOLLOWUP: 'Need to Followup', NOT_INTERESTED: 'Not Interested' };
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 100) : 0);

// ── Booked VS Conducted ──────────────────────────────────────────────────
interface Block { fixed: number; over: number; interested: number; fifty: number; followup: number; notInterested: number }
const emptyBlock = (): Block => ({ fixed: 0, over: 0, interested: 0, fifty: 0, followup: 0, notInterested: 0 });
const addBlock = (a: Block, b: Block) => { (Object.keys(a) as (keyof Block)[]).forEach((k) => { a[k] += b[k]; }); };

export async function bookedVsConducted(q: { from?: unknown; to?: unknown }) {
  const r = parseRange(q);
  const demos = await fetchDemos({ scheduledAt: { gte: r.start, lt: r.end }, status: { in: ['SCHEDULED', 'COMPLETED', 'NO_SHOW'] } });
  const advisors = await loadAdvisors(demos.map(owner).filter(Boolean));
  type Row = { id: string; name: string; tl: string; target: number; online: Block; offline: Block };
  const rows = new Map<string, Row>();
  for (const a of advisors.values()) rows.set(a.id, { id: a.id, name: a.name, tl: a.tl, target: a.demoTarget * r.days, online: emptyBlock(), offline: emptyBlock() });
  for (const d of demos) {
    const row = rows.get(owner(d));
    if (!row) continue;
    const b = d.mode === 'ONLINE' ? row.online : row.offline;
    b.fixed++;
    if (d.status === 'COMPLETED') {
      b.over++;
      if (d.outcome === 'INTERESTED') b.interested++;
      else if (d.outcome === 'FIFTY_FIFTY') b.fifty++;
      else if (d.outcome === 'NEED_FOLLOWUP') b.followup++;
      else if (d.outcome === 'NOT_INTERESTED') b.notInterested++;
    }
  }
  const shape = (x: { id?: string; name: string; tl?: string; target: number; online: Block; offline: Block }) => {
    const over = x.online.over + x.offline.over;
    return { employeeId: x.id, name: x.name, tl: x.tl, target: x.target, over, achieved: pct(over, x.target), online: { ...x.online, pct: pct(x.online.over, x.online.fixed) }, offline: { ...x.offline, pct: pct(x.offline.over, x.offline.fixed) } };
  };
  const list = [...rows.values()].map(shape).sort((a, b) => b.achieved - a.achieved || b.over - a.over || a.name.localeCompare(b.name));
  const tlMap = new Map<string, { name: string; target: number; online: Block; offline: Block }>();
  const total = { name: 'Total', target: 0, online: emptyBlock(), offline: emptyBlock() };
  for (const x of rows.values()) {
    const t = tlMap.get(x.tl) || { name: x.tl, target: 0, online: emptyBlock(), offline: emptyBlock() };
    t.target += x.target; addBlock(t.online, x.online); addBlock(t.offline, x.offline); tlMap.set(x.tl, t);
    total.target += x.target; addBlock(total.online, x.online); addBlock(total.offline, x.offline);
  }
  return { from: r.from, to: r.to, days: r.days, advisors: list, tls: [...tlMap.values()].map(shape).sort((a, b) => b.achieved - a.achieved || a.name.localeCompare(b.name)), total: shape(total) };
}

// ── Booking ───────────────────────────────────────────────────────────────
export async function booking(q: { from?: unknown; to?: unknown }) {
  const r = parseRange(q);
  const demos = await fetchDemos({ createdAt: { gte: r.start, lt: r.end }, status: { not: 'CANCELLED' } });
  const advisors = await loadAdvisors(demos.map(owner).filter(Boolean));
  type Row = { id: string; name: string; tl: string; target: number; fresh: number; resched: number; days: number[] };
  const rows = new Map<string, Row>();
  for (const a of advisors.values()) rows.set(a.id, { id: a.id, name: a.name, tl: a.tl, target: a.bookingTarget * r.days, fresh: 0, resched: 0, days: [0, 0, 0, 0, 0, 0, 0] });
  for (const d of demos) {
    const row = rows.get(owner(d));
    if (!row) continue;
    if (d.rescheduledFromId) { row.resched++; continue; }
    row.fresh++;
    const dow = new Date(d.scheduledAt.getTime() + IST_MS).getUTCDay(); // 0 = Sunday
    row.days[(dow + 6) % 7]++;
  }
  const shape = (x: { id?: string; name: string; tl?: string; target: number; fresh: number; resched: number; days: number[] }) => ({ employeeId: x.id, name: x.name, tl: x.tl, target: x.target, fresh: x.fresh, days: x.days, avg: x.target > 0 ? Math.round((x.fresh / x.target) * 10) / 10 : 0, resched: x.resched });
  const list = [...rows.values()].map(shape).sort((a, b) => b.avg - a.avg || b.fresh - a.fresh || a.name.localeCompare(b.name));
  const tlMap = new Map<string, Row>();
  const total = { name: 'Total', target: 0, fresh: 0, resched: 0, days: [0, 0, 0, 0, 0, 0, 0] };
  for (const x of rows.values()) {
    const t = tlMap.get(x.tl) || { id: '', name: x.tl, tl: x.tl, target: 0, fresh: 0, resched: 0, days: [0, 0, 0, 0, 0, 0, 0] };
    for (const o of [t, total]) { o.target += x.target; o.fresh += x.fresh; o.resched += x.resched; x.days.forEach((n, i) => { o.days[i] += n; }); }
    tlMap.set(x.tl, t as Row);
  }
  return { from: r.from, to: r.to, days: r.days, advisors: list, tls: [...tlMap.values()].map(shape).sort((a, b) => b.avg - a.avg || a.name.localeCompare(b.name)), total: shape(total) };
}

// ── Today Demo ────────────────────────────────────────────────────────────
export async function todayDemo(q: { from?: unknown }) {
  const r = parseRange({ from: q.from, to: q.from });
  const demos = await fetchDemos({ scheduledAt: { gte: r.start, lt: r.end }, status: { in: ['SCHEDULED', 'COMPLETED', 'NO_SHOW'] } });
  const advisors = await loadAdvisors(demos.map(owner).filter(Boolean));
  const by = new Map<string, { name: string; time: string; mode: string; status: string }[]>();
  for (const d of demos) {
    const t = new Date(d.scheduledAt.getTime() + IST_MS);
    const h = t.getUTCHours(), m = t.getUTCMinutes();
    const list = by.get(owner(d)) || [];
    list.push({ name: d.lead.name, time: `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`, mode: d.mode, status: d.status });
    by.set(owner(d), list);
  }
  const rows = [...advisors.values()].map((a) => ({ name: a.name, tl: a.tl, students: by.get(a.id) || [] })).sort((a, b) => a.tl.localeCompare(b.tl) || a.name.localeCompare(b.name));
  return { date: r.from, rows, total: demos.length };
}

// ── Booking Response ──────────────────────────────────────────────────────
const slot = (d: Date) => { const h = new Date(d.getTime() + IST_MS).getUTCHours(); return `${h % 12 || 12} - ${(h + 1) % 12 || 12}`; };
const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export async function bookingResponse(q: { from?: unknown; to?: unknown }) {
  const r = parseRange(q);
  const demos = await fetchDemos({ createdAt: { gte: r.start, lt: r.end } });
  const advisors = await loadAdvisors(demos.map(owner).filter(Boolean));
  const now = new Date();
  const rows = demos.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).map((d) => {
    const a = advisors.get(owner(d));
    let status = 'Booked';
    if (d.status === 'COMPLETED') status = 'Conducted';
    else if (d.status === 'RESCHEDULED') status = 'Rescheduled';
    else if (d.status === 'NO_SHOW') status = 'No Show';
    else if (d.status === 'CANCELLED') status = 'Cancelled';
    else if (d.lead.activityStatus === 'DNP') status = 'DNP';
    else if (d.scheduledAt < now) status = 'Outcome pending';
    return {
      id: d.id, student: d.lead.name, bookedAt: d.createdAt, advisor: a?.name || '—', tl: a?.tl || '—', phone: d.lead.phone, mode: d.mode,
      demoAt: d.scheduledAt, slot: slot(d.scheduledAt), comments: d.bookingComments || '', source: d.lead.source || '',
      status, statusComment: d.rescheduleReason || (d.status === 'COMPLETED' ? d.feedback || '' : ''), bookedOn: istDate(d.createdAt), demoDay: DOW[new Date(d.scheduledAt.getTime() + IST_MS).getUTCDay()],
      outcome: d.outcome ? OUTCOME_LABEL[d.outcome] : '', rescheduled: !!d.rescheduledFromId,
    };
  });
  return { from: r.from, to: r.to, rows };
}

// ── Demo Response ─────────────────────────────────────────────────────────
export async function demoResponse(q: { from?: unknown; to?: unknown }) {
  const r = parseRange(q);
  const demos = await fetchDemos({ completedAt: { gte: r.start, lt: r.end }, status: 'COMPLETED' });
  const advisors = await loadAdvisors(demos.map(owner).filter(Boolean));
  const cfg = await leadConfig();
  const rows = demos.sort((a, b) => (b.completedAt?.getTime() || 0) - (a.completedAt?.getTime() || 0)).map((d) => {
    const a = advisors.get(owner(d));
    return {
      id: d.id, student: d.lead.name, doneAt: d.completedAt || d.updatedAt, advisor: a?.name || '—', tl: a?.tl || '—', phone: d.lead.phone,
      outcome: d.outcome ? OUTCOME_LABEL[d.outcome] : '', comments: d.feedback || '', source: d.lead.source || '', demoDate: d.scheduledAt,
      stage: cfg.label('STAGE', d.lead.stageKey || d.lead.status), stageComment: d.lead.callLogs[0]?.notes || '', mode: d.mode,
    };
  });
  return { from: r.from, to: r.to, rows, outcomes: OUTCOMES.map((o) => OUTCOME_LABEL[o]) };
}

// ── Student Response (demo reviews filled by students) ───────────────────
const INTENT_LABEL: Record<string, string> = { YES: 'Yes', MAYBE: 'Maybe', NO: 'No' };
const PACE_LABEL: Record<string, string> = { TOO_FAST: 'Too fast', JUST_RIGHT: 'Just right', TOO_SLOW: 'Too slow' };
const DOUBTS_LABEL: Record<string, string> = { YES: 'Yes', PARTLY: 'Partly', NO: 'No' };

export async function studentResponse(q: { from?: unknown; to?: unknown }) {
  const r = parseRange(q);
  const fbs = await prisma.demoFeedback.findMany({
    where: { OR: [{ submittedAt: { gte: r.start, lt: r.end } }, { submittedAt: null, releasedAt: { gte: r.start, lt: r.end } }] },
    include: { demo: { include: demoInclude } },
    orderBy: { releasedAt: 'desc' }, take: 5000,
  });
  const advisors = await loadAdvisors(fbs.map((f) => owner(f.demo as DemoRow)).filter(Boolean));
  const rows = fbs.map((f) => {
    const d = f.demo as DemoRow;
    const a = advisors.get(owner(d));
    return {
      id: f.id, demoId: d.id, student: d.lead.name, phone: d.lead.phone, advisor: a?.name || '—', tl: a?.tl || '—', demoAt: d.scheduledAt, mode: d.mode,
      releasedAt: f.releasedAt, submittedAt: f.submittedAt, status: f.submittedAt ? 'Submitted' : 'Awaiting',
      overall: f.overall, trainer: f.trainer, content: f.content, pace: f.pace ? PACE_LABEL[f.pace] : '', doubts: f.doubts ? DOUBTS_LABEL[f.doubts] : '',
      joinIntent: f.joinIntent ? INTENT_LABEL[f.joinIntent] : '', liked: f.liked || '', improve: f.improve || '', source: d.lead.source || '',
    };
  });
  return { from: r.from, to: r.to, rows };
}

/** Edit the comment-type fields shown on Booking Response / Demo Response (writes back to the source records). */
export async function editDemoFields(demoId: string, b: Record<string, unknown>) {
  const demo = await prisma.demo.findUnique({ where: { id: demoId }, select: { id: true, leadId: true } });
  if (!demo) throw new AppError('Demo not found', 404);
  const t = (v: unknown, max: number) => String(v ?? '').trim().slice(0, max) || null;
  const data: Prisma.DemoUpdateInput = {};
  if (b.comments !== undefined) data.bookingComments = t(b.comments, 2000);
  if (b.feedback !== undefined) data.feedback = t(b.feedback, 2000);
  if (Object.keys(data).length) await prisma.demo.update({ where: { id: demoId }, data });
  if (b.source !== undefined) await prisma.lead.update({ where: { id: demo.leadId }, data: { source: t(b.source, 120) } });
}

export async function saveTarget(employeeId: string, bookingTarget?: number, demoTarget?: number) {
  const data: { bookingTarget?: number; demoTarget?: number } = {};
  if (bookingTarget !== undefined) { if (!Number.isInteger(bookingTarget) || bookingTarget < 0 || bookingTarget > 500) throw new AppError('Enter a valid booking target', 400); data.bookingTarget = bookingTarget; }
  if (demoTarget !== undefined) { if (!Number.isInteger(demoTarget) || demoTarget < 0 || demoTarget > 500) throw new AppError('Enter a valid demo target', 400); data.demoTarget = demoTarget; }
  await prisma.bdaDailyTarget.upsert({ where: { employeeId }, create: { employeeId, ...data }, update: data });
}
