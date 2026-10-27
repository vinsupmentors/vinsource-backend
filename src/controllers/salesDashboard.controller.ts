import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { getEffectiveAccess } from '../utils/moduleAccess';

const DAY = 86400000;
const IST_OFFSET = 5.5 * 3600 * 1000;
const istDate = (d: Date) => new Date(d.getTime() + IST_OFFSET).toISOString().slice(0, 10);
const startOfTodayIst = () => new Date(`${istDate(new Date())}T00:00:00+05:30`);

async function isAdmin(req: AuthRequest): Promise<boolean> {
  if (!req.user) return false;
  if (req.user.role === 'SUPER_ADMIN') return true;
  return (await getEffectiveAccess(req.user.userId)).SALES === 'ADMIN';
}

/**
 * One call that feeds the Sales dashboard. A salesperson gets their own numbers; Sales Admin gets the team
 * (and can narrow to one person with ?employeeId=).
 */
export const salesDashboardController = {
  async get(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const admin = await isAdmin(req);
      const me = req.user?.employeeId;
      if (!admin && !me) throw new AppError('Your account is not linked to an employee record', 400);
      const scopeEmp = admin ? (req.query.employeeId ? String(req.query.employeeId) : null) : (me as string);
      const leadScope: Record<string, unknown> = { deletedAt: null, ...(scopeEmp ? { assignedToId: scopeEmp } : {}) };
      const callScope: Record<string, unknown> = scopeEmp ? { calledById: scopeEmp } : {};
      const demoScope: Record<string, unknown> = scopeEmp ? { lead: { assignedToId: scopeEmp } } : {};
      const open = { notIn: ['LOST', 'ENROLLED'] as never[] };

      const now = new Date();
      const today = startOfTodayIst();
      const tomorrow = new Date(today.getTime() + DAY);
      const ist = new Date(now.getTime() + IST_OFFSET);
      const monthStart = new Date(`${ist.getUTCFullYear()}-${String(ist.getUTCMonth() + 1).padStart(2, '0')}-01T00:00:00+05:30`);
      const weekAgo = new Date(today.getTime() - 6 * DAY);

      const [
        callsToday, talkAgg, demosToday, followUpsDue, overdue, tasksDue, pendingOutcome,
        newThisMonth, enrolledMonth, demosDoneMonth, byStage, openTotal, calls7, targets,
        sourceRows, enrolledSource, pool, untouchedNew,
      ] = await Promise.all([
        prisma.leadCallLog.count({ where: { ...callScope, calledAt: { gte: today, lt: tomorrow }, OR: [{ source: 'AUTO' }, { activityType: { not: null } }] } }),
        prisma.leadCallLog.aggregate({ where: { ...callScope, source: 'AUTO', calledAt: { gte: today, lt: tomorrow } }, _sum: { durationSeconds: true } }),
        prisma.demo.count({ where: { ...demoScope, status: { in: ['SCHEDULED', 'RESCHEDULED'] }, scheduledAt: { gte: today, lt: tomorrow } } }),
        prisma.lead.count({ where: { ...leadScope, status: open, nextFollowUpAt: { gte: today, lt: tomorrow } } }),
        prisma.lead.count({ where: { ...leadScope, status: open, nextFollowUpAt: { lt: today } } }),
        prisma.salesTask.count({ where: { ...(scopeEmp ? { assignedToId: scopeEmp } : {}), status: 'OPEN', dueAt: { lt: tomorrow } } }),
        prisma.demo.count({ where: { ...demoScope, status: 'SCHEDULED', scheduledAt: { lt: today } } }),
        prisma.lead.count({ where: { ...leadScope, createdAt: { gte: monthStart } } }),
        prisma.lead.count({ where: { ...leadScope, status: 'ENROLLED', updatedAt: { gte: monthStart } } }),
        prisma.demo.count({ where: { ...demoScope, status: 'COMPLETED', scheduledAt: { gte: monthStart } } }),
        prisma.lead.groupBy({ by: ['status', 'stageKey'], where: leadScope, _count: { _all: true } }),
        prisma.lead.count({ where: { ...leadScope, status: open } }),
        prisma.leadCallLog.findMany({ where: { ...callScope, calledAt: { gte: weekAgo }, OR: [{ source: 'AUTO' }, { activityType: { not: null } }] }, select: { calledAt: true } }),
        prisma.salesTarget.findMany({ where: { month: ist.getUTCMonth() + 1, year: ist.getUTCFullYear(), ...(scopeEmp ? { employeeId: scopeEmp } : {}) }, select: { enrollmentGoal: true, revenueGoal: true } }),
        prisma.lead.groupBy({ by: ['source'], where: { ...leadScope, createdAt: { gte: new Date(today.getTime() - 29 * DAY) } }, _count: { _all: true } }),
        prisma.lead.groupBy({ by: ['source'], where: { ...leadScope, status: 'ENROLLED', createdAt: { gte: new Date(today.getTime() - 29 * DAY) } }, _count: { _all: true } }),
        admin && !scopeEmp ? prisma.lead.count({ where: { deletedAt: null, assignedToId: null } }) : Promise.resolve(0),
        prisma.lead.count({ where: { ...leadScope, status: 'NEW', lastContactAt: null } }),
      ]);

      // Calls per day, last 7 days (IST)
      const perDay = new Map<string, number>();
      for (let i = 6; i >= 0; i--) perDay.set(istDate(new Date(today.getTime() - i * DAY + 1000)), 0);
      for (const c of calls7) { const k = istDate(c.calledAt); if (perDay.has(k)) perDay.set(k, (perDay.get(k) || 0) + 1); }

      const enrolledBySource = new Map(enrolledSource.map((x) => [(x.source || '').trim() || 'Unknown', x._count._all]));
      const sources = sourceRows.map((x) => {
        const name = (x.source || '').trim() || 'Unknown';
        const leads = x._count._all, enrolled = enrolledBySource.get(name) ?? 0;
        return { source: name, leads, enrolled, rate: leads ? Math.round((enrolled / leads) * 100) : 0 };
      }).sort((a, b) => b.leads - a.leads).slice(0, 6);

      // Team table (admin, all-team view)
      let team: unknown[] = [];
      if (admin && !scopeEmp) {
        const emps = await prisma.employee.findMany({
          where: { status: { in: ['ACTIVE', 'ON_PROBATION'] }, assignedLeads: { some: { deletedAt: null } } },
          select: { id: true, firstName: true, lastName: true },
        });
        const ids = emps.map((e) => e.id);
        const g = async (where: Record<string, unknown>, by: 'assignedToId' | 'calledById' = 'assignedToId', model: 'lead' | 'call' = 'lead') => {
          const rows = model === 'lead'
            ? await prisma.lead.groupBy({ by: ['assignedToId'], where: { deletedAt: null, assignedToId: { in: ids }, ...where } as never, _count: { _all: true } })
            : await prisma.leadCallLog.groupBy({ by: ['calledById'], where: { calledById: { in: ids }, ...where } as never, _count: { _all: true } });
          return new Map((rows as { assignedToId?: string | null; calledById?: string | null; _count: { _all: number } }[]).map((r) => [(by === 'assignedToId' ? r.assignedToId : r.calledById) as string, r._count._all]));
        };
        const [openM, overdueM, enrolledM, callsM, tg] = await Promise.all([
          g({ status: open }), g({ status: open, nextFollowUpAt: { lt: today } }), g({ status: 'ENROLLED', updatedAt: { gte: monthStart } }),
          g({ calledAt: { gte: today, lt: tomorrow }, OR: [{ source: 'AUTO' }, { activityType: { not: null } }] }, 'calledById', 'call'),
          prisma.salesTarget.findMany({ where: { month: ist.getUTCMonth() + 1, year: ist.getUTCFullYear(), employeeId: { in: ids } }, select: { employeeId: true, enrollmentGoal: true } }),
        ]);
        const goal = new Map(tg.map((t) => [t.employeeId, t.enrollmentGoal]));
        team = emps.map((e) => ({
          employeeId: e.id, name: `${e.firstName} ${e.lastName}`, open: openM.get(e.id) ?? 0, overdue: overdueM.get(e.id) ?? 0,
          callsToday: callsM.get(e.id) ?? 0, enrolled: enrolledM.get(e.id) ?? 0, goal: goal.get(e.id) ?? 0,
        })).sort((a, b) => b.enrolled - a.enrolled || b.callsToday - a.callsToday);
      }

      const stageCounts: Record<string, number> = {};
      for (const r of byStage) { const k = r.stageKey || r.status; stageCounts[k] = (stageCounts[k] || 0) + r._count._all; }

      res.json({
        success: true,
        data: {
          admin, scope: scopeEmp ? 'person' : admin ? 'team' : 'me',
          today: { calls: callsToday, talkMinutes: Math.round((talkAgg._sum.durationSeconds || 0) / 60), demos: demosToday, followUps: followUpsDue, overdue, tasks: tasksDue, pendingOutcome, untouchedNew },
          month: {
            newLeads: newThisMonth, enrolled: enrolledMonth, demosDone: demosDoneMonth,
            goal: targets.reduce((n, t) => n + t.enrollmentGoal, 0), revenueGoal: targets.reduce((n, t) => n + t.revenueGoal, 0),
            dayOfMonth: ist.getUTCDate(), daysInMonth: new Date(ist.getUTCFullYear(), ist.getUTCMonth() + 1, 0).getDate(),
          },
          funnel: stageCounts, openTotal,
          callsTrend: Array.from(perDay.entries()).map(([date, count]) => ({ date, count })),
          sources, pool, team,
        },
      });
    } catch (err) { next(err); }
  },
};
