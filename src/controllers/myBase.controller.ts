import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { notificationService } from '../services/notification.service';

/**
 * MyBase — the pool of unassigned leads. Sales Admin hands leads out in bulk
 * (optionally spread across several people), pulls them back from anyone, and
 * decides per hand-out whether the new owner can see the lead's past history.
 * Nothing is ever deleted: hiding history only sets a cut-off date.
 */

const MAX_BULK = 5000;
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map(String).filter(Boolean) : typeof v === 'string' && v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);
const inOrEq = (a: string[]) => (a.length === 1 ? a[0] : { in: a });

interface Criteria {
  fromEmployeeId?: string;        // leads currently held by this person (omit = MyBase pool)
  status?: string[]; activityStatus?: string[]; source?: string[]; course?: string[];
  search?: string; createdFrom?: string; createdTo?: string; batchLabel?: string;
}

/** Leads that can be moved: not deleted, not enrolled. */
function whereFrom(c: Criteria | undefined, leadIds: string[]) {
  const where: Record<string, unknown> = { deletedAt: null, status: { not: 'ENROLLED' } };
  const and: Record<string, unknown>[] = [];
  if (leadIds.length) { where.id = { in: leadIds }; return where; }
  const k = c || {};
  where.assignedToId = k.fromEmployeeId ? k.fromEmployeeId : null;
  const status = arr(k.status);
  if (status.length) where.status = { in: status.filter((s) => s !== 'ENROLLED') };
  const act = arr(k.activityStatus);
  if (act.length) {
    const named = act.filter((x) => x !== 'NONE');
    and.push({ OR: [...(act.includes('NONE') ? [{ activityStatus: null }] : []), ...(named.length ? [{ activityStatus: { in: named } }] : [])] });
  }
  const src = arr(k.source);
  if (src.length) {
    const named = src.filter((x) => x !== 'Unknown');
    and.push({ OR: [...(src.includes('Unknown') ? [{ source: null }, { source: '' }] : []), ...(named.length ? [{ source: { in: named } }] : [])] });
  }
  const course = arr(k.course);
  if (course.length) where.courseInterest = inOrEq(course);
  if (k.batchLabel) where.batchLabel = k.batchLabel;
  if (k.search) and.push({ OR: [{ name: { contains: k.search } }, { phone: { contains: k.search } }, { email: { contains: k.search } }] });
  if (k.createdFrom || k.createdTo) {
    const r: Record<string, Date> = {};
    if (k.createdFrom) { const d = new Date(k.createdFrom); d.setHours(0, 0, 0, 0); r.gte = d; }
    if (k.createdTo) { const d = new Date(k.createdTo); d.setHours(23, 59, 59, 999); r.lte = d; }
    where.createdAt = r;
  }
  if (and.length) where.AND = and;
  return where;
}

const nameOf = (e?: { firstName: string; lastName: string } | null) => (e ? `${e.firstName} ${e.lastName}` : 'MyBase');

export const myBaseController = {
  /** Pool size, per-source breakdown and the hand-out batches so far. */
  async summary(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const [pool, bySource, batches] = await Promise.all([
        prisma.lead.count({ where: { deletedAt: null, assignedToId: null } }),
        prisma.lead.groupBy({ by: ['source'], where: { deletedAt: null, assignedToId: null }, _count: { _all: true } }),
        prisma.lead.groupBy({ by: ['batchLabel'], where: { deletedAt: null, batchLabel: { not: null } }, _count: { _all: true }, _max: { assignedAt: true } }),
      ]);
      res.json({
        success: true,
        data: {
          pool,
          sources: bySource.map((s) => ({ source: (s.source || '').trim() || 'Unknown', count: s._count._all })).sort((a, b) => b.count - a.count),
          batches: batches.map((b) => ({ label: b.batchLabel, count: b._count._all, lastAssignedAt: b._max.assignedAt })).sort((a, b) => String(b.lastAssignedAt).localeCompare(String(a.lastAssignedAt))),
        },
      });
    } catch (err) { next(err); }
  },

  /**
   * Batch tracking: for every hand-out batch, how the leads are doing now, overall and per salesperson.
   * (A lead pulled back into My Base leaves its batch.)
   */
  async batches(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const leads = await prisma.lead.findMany({
        where: { deletedAt: null, batchLabel: { not: null } },
        select: { id: true, batchLabel: true, assignedToId: true, status: true, activityStatus: true, lastContactAt: true, nextFollowUpAt: true, assignedAt: true, _count: { select: { demos: true, callLogs: true } } },
        take: 50000,
      });
      const emps = await prisma.employee.findMany({ where: { id: { in: Array.from(new Set(leads.map((l) => l.assignedToId).filter(Boolean) as string[])) } }, select: { id: true, firstName: true, lastName: true } });
      const names = new Map(emps.map((e) => [e.id, `${e.firstName} ${e.lastName}`]));
      const today = new Date(); today.setHours(0, 0, 0, 0);

      const blank = () => ({ total: 0, contacted: 0, neverContacted: 0, calls: 0, demos: 0, enrolled: 0, lost: 0, notInterested: 0, open: 0, overdue: 0 });
      type Stat = ReturnType<typeof blank>;
      const add = (s: Stat, l: (typeof leads)[number]) => {
        s.total++; s.calls += l._count.callLogs; s.demos += l._count.demos > 0 ? 1 : 0;
        if (l.lastContactAt) s.contacted++; else s.neverContacted++;
        if (l.status === 'ENROLLED') s.enrolled++;
        else if (l.status === 'LOST' || l.activityStatus === 'DISQUALIFIED') s.lost++;
        else if (l.activityStatus === 'NOT_INTERESTED') s.notInterested++;
        else { s.open++; if (l.nextFollowUpAt && l.nextFollowUpAt < today) s.overdue++; }
      };

      const map = new Map<string, { label: string; assignedFrom: Date | null; assignedTo: Date | null; totals: Stat; people: Map<string, Stat & { name: string }> }>();
      for (const l of leads) {
        const label = l.batchLabel as string;
        if (!map.has(label)) map.set(label, { label, assignedFrom: null, assignedTo: null, totals: blank(), people: new Map() });
        const b = map.get(label)!;
        add(b.totals, l);
        if (l.assignedAt) {
          if (!b.assignedFrom || l.assignedAt < b.assignedFrom) b.assignedFrom = l.assignedAt;
          if (!b.assignedTo || l.assignedAt > b.assignedTo) b.assignedTo = l.assignedAt;
        }
        const pid = l.assignedToId || '__none__';
        if (!b.people.has(pid)) b.people.set(pid, { ...blank(), name: l.assignedToId ? names.get(l.assignedToId) || 'Unknown' : 'My Base' });
        add(b.people.get(pid)!, l);
      }
      const data = Array.from(map.values())
        .map((b) => ({ label: b.label, assignedFrom: b.assignedFrom, assignedTo: b.assignedTo, totals: b.totals, people: Array.from(b.people.values()).sort((x, y) => y.total - x.total) }))
        .sort((a, b) => String(b.assignedTo).localeCompare(String(a.assignedTo)));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /** How many leads a selection would move — shown before the admin confirms. */
  async count(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const where = whereFrom(req.body?.criteria, arr(req.body?.leadIds));
      res.json({ success: true, data: { count: await prisma.lead.count({ where }) } });
    } catch (err) { next(err); }
  },

  /** Bulk hand-out: leads → one or several salespeople (spread evenly), with the show-history choice and a batch label. */
  async assign(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeIds = arr(req.body?.employeeIds);
      if (!employeeIds.length) throw new AppError('Choose at least one salesperson', 400);
      const showHistory = req.body?.showHistory === true;
      const batchLabel = String(req.body?.batchLabel || '').trim() || null;
      const leadIds = arr(req.body?.leadIds);
      if (!leadIds.length && !req.body?.criteria) throw new AppError('Select leads or a filter to assign', 400);

      const employees = await prisma.employee.findMany({ where: { id: { in: employeeIds } }, select: { id: true, firstName: true, lastName: true, userId: true } });
      if (employees.length !== employeeIds.length) throw new AppError('One of the selected salespeople was not found', 400);

      const leads = await prisma.lead.findMany({
        where: whereFrom(req.body?.criteria, leadIds),
        select: { id: true, assignedToId: true, assignedTo: { select: { firstName: true, lastName: true } } },
        orderBy: { createdAt: 'asc' },
        take: MAX_BULK + 1,
      });
      if (leads.length > MAX_BULK) throw new AppError(`Too many leads in one go (max ${MAX_BULK}). Narrow the filter.`, 400);
      if (!leads.length) throw new AppError('No assignable leads in this selection (enrolled leads are skipped)', 400);

      const now = new Date();
      const buckets = new Map<string, typeof leads>(employeeIds.map((id) => [id, []]));
      leads.forEach((l, i) => buckets.get(employeeIds[i % employeeIds.length])!.push(l));

      const actor = req.user?.employeeId || null;
      const hist: { leadId: string; actorId: string | null; type: string; summary: string; fromValue: string | null; toValue: string | null }[] = [];
      for (const emp of employees) {
        const chunk = buckets.get(emp.id) || [];
        if (!chunk.length) continue;
        await prisma.lead.updateMany({
          where: { id: { in: chunk.map((l) => l.id) } },
          data: { assignedToId: emp.id, assignedAt: now, batchLabel, historyHiddenBefore: showHistory ? null : now },
        });
        const to = nameOf(emp);
        for (const l of chunk) {
          const from = nameOf(l.assignedTo);
          hist.push({
            leadId: l.id, actorId: actor, type: 'ASSIGNED', fromValue: from, toValue: to,
            summary: `${l.assignedToId ? `Reassigned from ${from} to ${to}` : `Assigned from MyBase to ${to}`}${batchLabel ? ` · batch "${batchLabel}"` : ''} · history ${showHistory ? 'shown' : 'hidden'} for the new owner`,
          });
        }
        if (emp.userId) {
          await notificationService.create({
            userId: emp.userId, type: 'SYSTEM', title: 'New leads assigned',
            message: `${chunk.length} lead${chunk.length === 1 ? '' : 's'} assigned to you${batchLabel ? ` (${batchLabel})` : ''}`, data: { batchLabel },
          }).catch(() => {});
        }
      }
      if (hist.length) await prisma.leadHistory.createMany({ data: hist });

      res.json({
        success: true,
        data: { assigned: leads.length, perPerson: employees.map((e) => ({ employeeId: e.id, name: nameOf(e), count: (buckets.get(e.id) || []).length })), showHistory, batchLabel },
      });
    } catch (err) { next(err); }
  },

  /** Pull leads back from their owner into MyBase (selected leads, or everything matching a filter for one person). */
  async pull(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const leadIds = arr(req.body?.leadIds);
      const crit = req.body?.criteria as Criteria | undefined;
      if (!leadIds.length && !crit?.fromEmployeeId) throw new AppError('Select leads, or choose the salesperson to pull from', 400);

      const where = whereFrom(crit, leadIds);
      if (leadIds.length) where.assignedToId = { not: null };
      const leads = await prisma.lead.findMany({
        where, select: { id: true, assignedTo: { select: { firstName: true, lastName: true } } }, take: MAX_BULK + 1,
      });
      if (leads.length > MAX_BULK) throw new AppError(`Too many leads in one go (max ${MAX_BULK}). Narrow the filter.`, 400);
      if (!leads.length) throw new AppError('No leads to pull back (already in MyBase, or enrolled)', 400);

      await prisma.lead.updateMany({
        where: { id: { in: leads.map((l) => l.id) } },
        data: { assignedToId: null, assignedAt: null, batchLabel: null, historyHiddenBefore: null },
      });
      const actor = req.user?.employeeId || null;
      await prisma.leadHistory.createMany({
        data: leads.map((l) => ({
          leadId: l.id, actorId: actor, type: 'ASSIGNED', fromValue: nameOf(l.assignedTo), toValue: 'MyBase',
          summary: `Pulled back from ${nameOf(l.assignedTo)} to MyBase`,
        })),
      });
      res.json({ success: true, data: { pulled: leads.length } });
    } catch (err) { next(err); }
  },
};
