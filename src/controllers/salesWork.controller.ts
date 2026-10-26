import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { getEffectiveAccess } from '../utils/moduleAccess';
import { notificationService } from '../services/notification.service';
import { paginate, formatPagination } from '../utils/helpers';
import { buildWhereFromFilter } from '../utils/filterTree';
import { historyCutoff } from '../utils/leadHistoryVisibility';
import { leadConfig } from '../utils/leadConfig';
import { FEED_FILTER_FIELDS, LEAD_FILTER_FIELDS } from '../utils/salesFilterFields';

const empSelect = { id: true, firstName: true, lastName: true, employeeCode: true };
const fullName = (e?: { firstName: string; lastName: string } | null) => (e ? `${e.firstName} ${e.lastName}` : 'Unassigned');

async function isAdmin(req: AuthRequest): Promise<boolean> {
  if (!req.user) return false;
  if (req.user.role === 'SUPER_ADMIN') return true;
  return (await getEffectiveAccess(req.user.userId)).SALES === 'ADMIN';
}

/** A BDA may only touch leads assigned to them; Sales Admin may touch any. */
async function assertLeadAccess(req: AuthRequest, leadId: string): Promise<void> {
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { assignedToId: true, deletedAt: true } });
  if (!lead || lead.deletedAt) throw new AppError('Lead not found', 404);
  if (await isAdmin(req)) return;
  if (lead.assignedToId !== req.user?.employeeId) throw new AppError('You do not have access to this lead', 403);
}

function requireEmployee(req: AuthRequest): string {
  if (!req.user?.employeeId) throw new AppError('Your account is not linked to an employee record', 400);
  return req.user.employeeId;
}

const startOfToday = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };

export const salesWorkController = {
  // ── My Reminders: lead follow-ups + open tasks, for one salesperson ───────
  async reminders(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isAdmin(req);
      // A Sales Admin may look at anyone's reminders; everyone else only their own.
      const employeeId = admin && req.query.employeeId ? String(req.query.employeeId) : requireEmployee(req);

      const [leads, tasks] = await Promise.all([
        prisma.lead.findMany({
          where: { deletedAt: null, assignedToId: employeeId, nextFollowUpAt: { not: null }, status: { notIn: ['LOST', 'ENROLLED'] } },
          select: { id: true, name: true, phone: true, status: true, activityStatus: true, courseInterest: true, nextFollowUpAt: true, lastContactAt: true },
          orderBy: { nextFollowUpAt: 'asc' },
          take: 500,
        }),
        prisma.salesTask.findMany({
          where: { assignedToId: employeeId, status: 'OPEN' },
          include: { lead: { select: { id: true, name: true, phone: true } }, createdBy: { select: empSelect } },
          orderBy: [{ dueAt: 'asc' }, { createdAt: 'desc' }],
          take: 500,
        }),
      ]);

      const today = startOfToday();
      const tomorrow = new Date(today); tomorrow.setDate(tomorrow.getDate() + 1);
      const bucket = (d: Date | null) => (!d ? 'later' : d < today ? 'overdue' : d < tomorrow ? 'today' : 'upcoming');
      res.json({
        success: true,
        data: {
          followUps: leads.map((l) => ({ ...l, bucket: bucket(l.nextFollowUpAt) })),
          tasks: tasks.map((t) => ({ ...t, bucket: bucket(t.dueAt) })),
        },
      });
    } catch (err) { next(err); }
  },

  // ── Lead notes (standalone — no status / follow-up change) ───────────────
  async listNotes(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await assertLeadAccess(req, req.params.id);
      const cutoff = await historyCutoff(await isAdmin(req), req.params.id);
      const rows = await prisma.leadNote.findMany({ where: { leadId: req.params.id, ...(cutoff ? { createdAt: { gte: cutoff } } : {}) }, include: { author: { select: empSelect } }, orderBy: { createdAt: 'desc' } });
      res.json({ success: true, data: rows });
    } catch (err) { next(err); }
  },

  async addNote(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await assertLeadAccess(req, req.params.id);
      const body = String(req.body?.body || '').trim();
      if (!body) throw new AppError('Write a note first', 400);
      const note = await prisma.leadNote.create({
        data: { leadId: req.params.id, authorId: req.user?.employeeId || null, body },
        include: { author: { select: empSelect } },
      });
      await prisma.leadHistory.create({ data: { leadId: req.params.id, actorId: req.user?.employeeId || null, type: 'NOTE', summary: `Note added: ${body.slice(0, 200)}` } }).catch(() => {});
      res.status(201).json({ success: true, data: note });
    } catch (err) { next(err); }
  },

  // ── Tasks ─────────────────────────────────────────────────────────────────
  async listTasks(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isAdmin(req);
      const { status, assignedToId, leadId, page = 1, limit = 50 } = req.query;
      const p = Number(page), l = Math.min(Number(limit) || 50, 200);
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (leadId) {
        // On a lead's own screen: everyone with access to that lead sees every task on it.
        await assertLeadAccess(req, String(leadId));
        where.leadId = String(leadId);
        const cutoff = await historyCutoff(admin, String(leadId));
        if (cutoff) where.createdAt = { gte: cutoff };
        if (admin && assignedToId) where.assignedToId = assignedToId;
      } else if (admin) { if (assignedToId) where.assignedToId = assignedToId; }
      else where.assignedToId = requireEmployee(req);

      const [rows, total] = await Promise.all([
        prisma.salesTask.findMany({
          where,
          include: { lead: { select: { id: true, name: true, phone: true } }, assignedTo: { select: empSelect }, createdBy: { select: empSelect } },
          orderBy: [{ status: 'asc' }, { dueAt: 'asc' }, { createdAt: 'desc' }],
          ...paginate(p, l),
        }),
        prisma.salesTask.count({ where }),
      ]);
      res.json({ success: true, data: rows, meta: formatPagination(total, p, l) });
    } catch (err) { next(err); }
  },

  async createTask(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isAdmin(req);
      const me = requireEmployee(req);
      const { title, description, leadId, assignedToId, dueAt } = req.body;
      if (!title || !String(title).trim()) throw new AppError('Task title is required', 400);
      // Only a Sales Admin can hand a task to somebody else.
      const assignee = admin && assignedToId ? String(assignedToId) : me;
      if (dueAt && isNaN(new Date(dueAt).getTime())) throw new AppError('Invalid due date', 400);

      if (leadId) {
        const lead = await prisma.lead.findUnique({ where: { id: String(leadId) }, select: { assignedToId: true, deletedAt: true } });
        if (!lead || lead.deletedAt) throw new AppError('Lead not found', 404);
        if (!admin && lead.assignedToId !== me) throw new AppError('You do not have access to this lead', 403);
      }

      const task = await prisma.salesTask.create({
        data: {
          title: String(title).trim().slice(0, 190), description: description ? String(description) : null,
          leadId: leadId || null, assignedToId: assignee, createdById: me, dueAt: dueAt ? new Date(dueAt) : null,
        },
        include: { lead: { select: { id: true, name: true } }, assignedTo: { select: empSelect } },
      });
      if (leadId) {
        await prisma.leadHistory.create({ data: { leadId: String(leadId), actorId: me, type: 'TASK', summary: `Task added: ${task.title}${task.dueAt ? ` (due ${task.dueAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })})` : ''}` } }).catch(() => {});
      }
      if (assignee !== me) {
        const target = await prisma.employee.findUnique({ where: { id: assignee }, select: { userId: true } });
        if (target?.userId) {
          await notificationService.create({ userId: target.userId, type: 'SYSTEM', title: 'New sales task', message: `You were assigned a task: ${task.title}`, data: { taskId: task.id } }).catch(() => {});
        }
      }
      res.status(201).json({ success: true, data: task });
    } catch (err) { next(err); }
  },

  async updateTask(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isAdmin(req);
      const me = requireEmployee(req);
      const t = await prisma.salesTask.findUnique({ where: { id: req.params.id } });
      if (!t) throw new AppError('Task not found', 404);
      if (!admin && t.assignedToId !== me) throw new AppError('Not your task', 403);

      const { status, title, description, dueAt, assignedToId } = req.body;
      const data: Record<string, unknown> = {};
      if (status) {
        if (!['OPEN', 'DONE', 'CANCELLED'].includes(status)) throw new AppError('Invalid status', 400);
        data.status = status;
        data.completedAt = status === 'DONE' ? new Date() : null;
      }
      if (title !== undefined) data.title = String(title).trim().slice(0, 190);
      if (description !== undefined) data.description = description ? String(description) : null;
      if (dueAt !== undefined) data.dueAt = dueAt ? new Date(dueAt) : null;
      if (admin && assignedToId) data.assignedToId = String(assignedToId);

      const updated = await prisma.salesTask.update({ where: { id: t.id }, data });
      if (t.leadId && status && status !== t.status) {
        await prisma.leadHistory.create({ data: { leadId: t.leadId, actorId: me, type: 'TASK', summary: `Task "${t.title}" marked ${String(status).toLowerCase()}` } }).catch(() => {});
      }
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  // ── Insights (Sales Admin) ────────────────────────────────────────────────
  /** Lead assignment summary: per salesperson — how many leads they hold, split by stage, plus follow-up health. */
  async assignmentSummary(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const base = { deletedAt: null };
      const today = startOfToday();
      const [byStage, overdue, newToday, employees] = await Promise.all([
        prisma.lead.groupBy({ by: ['assignedToId', 'status'], where: base, _count: { _all: true } }),
        prisma.lead.groupBy({ by: ['assignedToId'], where: { ...base, nextFollowUpAt: { lt: today }, status: { notIn: ['LOST', 'ENROLLED'] } }, _count: { _all: true } }),
        prisma.lead.groupBy({ by: ['assignedToId'], where: { ...base, createdAt: { gte: today } }, _count: { _all: true } }),
        prisma.employee.findMany({ select: empSelect }),
      ]);
      const names = new Map(employees.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
      const rows = new Map<string, { employeeId: string | null; name: string; total: number; stages: Record<string, number>; overdue: number; newToday: number }>();
      const get = (id: string | null) => {
        const k = id || '__none__';
        if (!rows.has(k)) rows.set(k, { employeeId: id, name: id ? names.get(id) || 'Unknown' : 'Unassigned', total: 0, stages: {}, overdue: 0, newToday: 0 });
        return rows.get(k)!;
      };
      for (const r of byStage) { const row = get(r.assignedToId); row.total += r._count._all; row.stages[r.status] = (row.stages[r.status] || 0) + r._count._all; }
      for (const r of overdue) get(r.assignedToId).overdue = r._count._all;
      for (const r of newToday) get(r.assignedToId).newToday = r._count._all;
      res.json({ success: true, data: Array.from(rows.values()).sort((a, b) => b.total - a.total) });
    } catch (err) { next(err); }
  },

  /** Lead stage summary: totals per stage and per Update Status. */
  async stageSummary(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const where = { deletedAt: null };
      const [stages, statuses, total] = await Promise.all([
        prisma.lead.groupBy({ by: ['status'], where, _count: { _all: true } }),
        prisma.lead.groupBy({ by: ['activityStatus'], where, _count: { _all: true } }),
        prisma.lead.count({ where }),
      ]);
      res.json({
        success: true,
        data: {
          total,
          stages: stages.map((s) => ({ stage: s.status, count: s._count._all })),
          statuses: statuses.map((s) => ({ status: s.activityStatus || 'NONE', count: s._count._all })),
        },
      });
    } catch (err) { next(err); }
  },

  /** Source summary: leads per source with how many reached demo / enrolment / were lost. */
  async sourceSummary(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const rows = await prisma.lead.groupBy({ by: ['source', 'status'], where: { deletedAt: null }, _count: { _all: true } });
      const map = new Map<string, { source: string; total: number; demo: number; enrolled: number; lost: number; open: number }>();
      for (const r of rows) {
        const key = (r.source || '').trim() || 'Unknown';
        if (!map.has(key)) map.set(key, { source: key, total: 0, demo: 0, enrolled: 0, lost: 0, open: 0 });
        const m = map.get(key)!; const n = r._count._all;
        m.total += n;
        if (r.status === 'ENROLLED') m.enrolled += n;
        else if (r.status === 'LOST') m.lost += n;
        else { m.open += n; if (r.status === 'DEMO_SCHEDULED' || r.status === 'DEMO_DONE' || r.status === 'NEGOTIATION') m.demo += n; }
      }
      const data = Array.from(map.values()).map((m) => ({ ...m, conversion: m.total ? Math.round((m.enrolled / m.total) * 1000) / 10 : 0 })).sort((a, b) => b.total - a.total);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /**
   * Sales report builder: group leads by one dimension (rows) and optionally split by a second (cols).
   * Without cols → a metrics table (leads, open, demo, enrolled, lost, conversion, overdue).
   * With cols → a cross-tab of lead counts with row/column totals.
   */
  async salesReport(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const rowsDim = String(req.query.rows || 'source');
      const colsDim = req.query.cols ? String(req.query.cols) : '';
      const IST = 5.5 * 3600 * 1000;
      const iso = (d: Date) => new Date(d.getTime() + IST).toISOString();
      type L = {
        id: string; source: string | null; assignedToId: string | null; createdById: string | null; status: string; activityStatus: string | null; stageKey: string | null; statusKey: string | null; scoutKey: string | null;
        courseInterest: string | null; city: string | null; collegeName: string | null; educationQualification: string | null;
        createdAt: Date; nextFollowUpAt: Date | null; lastContactAt: Date | null;
        calls: number; meetings: number; demos: number; demosDone: number; openTasks: number;
      };
      const cfgR = await leadConfig();
      const DAY = 86400000;
      const ageDays = (l: L) => Math.floor((Date.now() - l.createdAt.getTime()) / DAY);
      const bucket = (n: number, edges: [number, string][], last: string) => { for (const [max, label] of edges) if (n <= max) return label; return last; };
      const names = new Map((await prisma.employee.findMany({ select: empSelect })).map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
      const txt = (v: string | null) => (v || '').trim() || 'Unknown';
      const DIMS: Record<string, (l: L) => string> = {
        source: (l) => txt(l.source),
        assignedTo: (l) => (l.assignedToId ? names.get(l.assignedToId) || 'Unknown' : 'Unassigned'),
        stage: (l) => cfgR.label('STAGE', l.stageKey || l.status),
        updateStatus: (l) => (l.statusKey || l.activityStatus ? cfgR.label('STATUS', l.statusKey || l.activityStatus) : 'No status yet'),
        scout: (l) => (l.scoutKey ? cfgR.label('SCOUT', l.scoutKey) : 'No scout'),
        course: (l) => txt(l.courseInterest),
        city: (l) => txt(l.city),
        college: (l) => txt(l.collegeName),
        qualification: (l) => txt(l.educationQualification),
        createdMonth: (l) => iso(l.createdAt).slice(0, 7),
        createdDay: (l) => iso(l.createdAt).slice(0, 10),
        createdBy: (l) => (l.createdById ? names.get(l.createdById) || 'Unknown' : 'System / import'),
        leadAge: (l) => bucket(ageDays(l), [[7, '0-7 days'], [30, '8-30 days'], [90, '31-90 days']], '90+ days'),
        activityCount: (l) => bucket(l.calls + l.meetings, [[0, 'No activity'], [2, '1-2'], [5, '3-5']], '6+'),
        lastContact: (l) => (l.lastContactAt ? bucket(Math.floor((Date.now() - l.lastContactAt.getTime()) / DAY), [[2, 'Last 2 days'], [7, '3-7 days'], [30, '8-30 days']], '30+ days ago') : 'Never contacted'),
        followUp: (l) => (!l.nextFollowUpAt ? 'No follow-up set' : l.nextFollowUpAt < startOfToday() ? 'Overdue' : l.nextFollowUpAt.getTime() < startOfToday().getTime() + DAY ? 'Today' : 'Upcoming'),
      };
      const MEASURES: Record<string, (l: L) => number> = {
        leads: () => 1,
        activities: (l) => l.calls + l.meetings,
        calls: (l) => l.calls,
        meetings: (l) => l.meetings,
        demos: (l) => l.demos,
        demosDone: (l) => l.demosDone,
        openTasks: (l) => l.openTasks,
      };
      const measure = String(req.query.measure || 'leads');
      if (!MEASURES[measure]) throw new AppError('Unknown report measure', 400);
      if (!DIMS[rowsDim]) throw new AppError('Unknown report grouping', 400);
      if (colsDim && !DIMS[colsDim]) throw new AppError('Unknown report column grouping', 400);

      const where: Record<string, unknown> = { deletedAt: null };
      const range: Record<string, Date> = {};
      if (req.query.from) range.gte = new Date(`${String(req.query.from)}T00:00:00+05:30`);
      if (req.query.to) range.lte = new Date(`${String(req.query.to)}T23:59:59.999+05:30`);
      if (range.gte || range.lte) where.createdAt = range;
      if (req.query.assignedToId) where.assignedToId = String(req.query.assignedToId);
      const advanced = buildWhereFromFilter(req.query.filter, LEAD_FILTER_FIELDS);
      if (advanced) where.AND = [advanced];

      const base = await prisma.lead.findMany({
        where,
        select: { id: true, source: true, assignedToId: true, createdById: true, status: true, activityStatus: true, stageKey: true, statusKey: true, scoutKey: true, courseInterest: true, city: true, collegeName: true, educationQualification: true, createdAt: true, nextFollowUpAt: true, lastContactAt: true },
      });
      // Activity / demo / task counts per lead, scoped to the same lead filter.
      const [acts, demoRows, taskRows] = await Promise.all([
        prisma.leadCallLog.groupBy({ by: ['leadId', 'activityType'], where: { lead: where }, _count: { _all: true } }),
        prisma.demo.groupBy({ by: ['leadId', 'status'], where: { lead: where }, _count: { _all: true } }),
        prisma.salesTask.groupBy({ by: ['leadId'], where: { lead: where, status: 'OPEN' }, _count: { _all: true } }),
      ]);
      const stats = new Map<string, { calls: number; meetings: number; demos: number; demosDone: number; openTasks: number }>();
      const st = (id: string) => { if (!stats.has(id)) stats.set(id, { calls: 0, meetings: 0, demos: 0, demosDone: 0, openTasks: 0 }); return stats.get(id)!; };
      for (const a of acts) { if (!a.leadId) continue; const s = st(a.leadId); if (a.activityType === 'MEETING') s.meetings += a._count._all; else s.calls += a._count._all; }
      for (const d of demoRows) { const s = st(d.leadId); if (d.status !== 'RESCHEDULED') s.demos += d._count._all; if (d.status === 'COMPLETED') s.demosDone += d._count._all; }
      for (const t of taskRows) { if (t.leadId) st(t.leadId).openTasks += t._count._all; }
      const leads: L[] = base.map((b) => ({ ...b, ...(stats.get(b.id) || { calls: 0, meetings: 0, demos: 0, demosDone: 0, openTasks: 0 }) }));

      const today = startOfToday();
      const sortKey = (a: string, b: string) => (rowsDim.startsWith('created') ? b.localeCompare(a) : 0);

      if (!colsDim) {
        const map = new Map<string, { label: string; total: number; open: number; demoBooked: number; demoOver: number; enrolled: number; lost: number; overdue: number; calls: number; meetings: number; demos: number; demosDone: number; openTasks: number; noActivity: number; ageSum: number }>();
        for (const l of leads) {
          const k = DIMS[rowsDim](l);
          if (!map.has(k)) map.set(k, { label: k, total: 0, open: 0, demoBooked: 0, demoOver: 0, enrolled: 0, lost: 0, overdue: 0, calls: 0, meetings: 0, demos: 0, demosDone: 0, openTasks: 0, noActivity: 0, ageSum: 0 });
          const m = map.get(k)!;
          m.total++;
          m.calls += l.calls; m.meetings += l.meetings; m.demos += l.demos; m.demosDone += l.demosDone; m.openTasks += l.openTasks;
          if (l.calls + l.meetings === 0) m.noActivity++;
          m.ageSum += ageDays(l);
          if (l.status === 'ENROLLED') m.enrolled++;
          else if (l.status === 'LOST') m.lost++;
          else {
            m.open++;
            if (l.nextFollowUpAt && l.nextFollowUpAt < today) m.overdue++;
          }
          if (l.activityStatus === 'DEMO_BOOKED') m.demoBooked++;
          if (l.activityStatus === 'DEMO_OVER') m.demoOver++;
        }
        const data = Array.from(map.values())
          .map(({ ageSum, ...m }) => ({
            ...m,
            conversion: m.total ? Math.round((m.enrolled / m.total) * 1000) / 10 : 0,
            avgAgeDays: m.total ? Math.round(ageSum / m.total) : 0,
            activities: m.calls + m.meetings,
            avgActivities: m.total ? Math.round(((m.calls + m.meetings) / m.total) * 10) / 10 : 0,
          }))
          .sort((a, b) => (rowsDim.startsWith('created') ? sortKey(a.label, b.label) : b.total - a.total));
        return res.json({ success: true, data: { mode: 'metrics', total: leads.length, rows: data } });
      }

      const colSet = new Set<string>();
      const grid = new Map<string, Record<string, number>>();
      for (const l of leads) {
        const r = DIMS[rowsDim](l), c = DIMS[colsDim](l);
        colSet.add(c);
        if (!grid.has(r)) grid.set(r, {});
        const row = grid.get(r)!;
        row[c] = (row[c] || 0) + MEASURES[measure](l);
      }
      const cols = Array.from(colSet).sort((a, b) => (colsDim.startsWith('created') ? a.localeCompare(b) : a.localeCompare(b)));
      const rows = Array.from(grid.entries())
        .map(([label, cells]) => ({ label, cells, total: Object.values(cells).reduce((s, n) => s + n, 0) }))
        .sort((a, b) => (rowsDim.startsWith('created') ? sortKey(a.label, b.label) : b.total - a.total));
      res.json({ success: true, data: { mode: 'pivot', measure, total: rows.reduce((s, r) => s + r.total, 0), cols, rows } });
    } catch (err) { next(err); }
  },

  /** Distinct sources already used — feeds the Source filter and the Add Lead suggestions. */
  async sources(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const rows = await prisma.lead.findMany({ where: { deletedAt: null, source: { not: null } }, select: { source: true }, distinct: ['source'], orderBy: { source: 'asc' }, take: 200 });
      res.json({ success: true, data: rows.map((r) => r.source).filter(Boolean) });
    } catch (err) { next(err); }
  },

  /** Activity monitor: every change on every lead (status, stage, assignment, activities, edits, deletions) with who did it. */
  async activityFeed(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { employeeId, type, from, to, leadId, page = 1, limit = 50 } = req.query;
      const p = Number(page), l = Math.min(Number(limit) || 50, 200);
      const where: Record<string, unknown> = {};
      if (employeeId) where.actorId = employeeId;
      if (type) where.type = String(type).includes(',') ? { in: String(type).split(',') } : type;
      if (leadId) where.leadId = leadId;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) { const d = new Date(String(from)); d.setHours(0, 0, 0, 0); range.gte = d; }
        if (to) { const d = new Date(String(to)); d.setHours(23, 59, 59, 999); range.lte = d; }
        where.createdAt = range;
      }
      const advanced = buildWhereFromFilter(req.query.filter, FEED_FILTER_FIELDS);
      if (advanced) where.AND = [advanced];
      const [rows, total, byActor] = await Promise.all([
        prisma.leadHistory.findMany({
          where,
          include: { actor: { select: empSelect }, lead: { select: { id: true, name: true, phone: true } } },
          orderBy: { createdAt: 'desc' },
          ...paginate(p, l),
        }),
        prisma.leadHistory.count({ where }),
        prisma.leadHistory.groupBy({ by: ['actorId'], where, _count: { _all: true } }),
      ]);
      const ids = byActor.map((b) => b.actorId).filter(Boolean) as string[];
      const emps = await prisma.employee.findMany({ where: { id: { in: ids } }, select: empSelect });
      const nm = new Map(emps.map((e) => [e.id, fullName(e)]));
      res.json({
        success: true,
        data: rows,
        meta: formatPagination(total, p, l),
        perPerson: byActor.map((b) => ({ employeeId: b.actorId, name: b.actorId ? nm.get(b.actorId) || 'Unknown' : 'System', count: b._count._all })).sort((a, b) => b.count - a.count),
      });
    } catch (err) { next(err); }
  },
};
