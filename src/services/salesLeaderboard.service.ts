import prisma from '../config/database';

export interface LeaderboardRow {
  employeeId: string;
  firstName: string;
  lastName: string;
  employeeCode: string;
  callsMade: number;
  leadsCreated: number;
  demosBooked: number;
  demosConducted: number;
  enrolled: number;
  lost: number;
  revenue: number;
  /** Average hours between a lead being created and its first logged call —
   * null when this rep had no new leads (with a follow-up call yet) in range. */
  avgFirstContactHours: number | null;
  target: { enrollmentGoal: number; revenueGoal: number } | null;
}

/**
 * Per-salesperson KPI breakdown for a date range — the Leaderboard tab's
 * data source. Deliberately does the grouping/aggregation in application
 * code rather than a single mega-query: several of these metrics span
 * relations Prisma's groupBy can't reach directly (e.g. attributing a Demo
 * to a rep means going through its Lead's assignedToId, not a field on Demo
 * itself), and this table's size (a sales team's activity, not millions of
 * rows) makes in-app aggregation perfectly fine — same reasoning already
 * used for phone-number matching elsewhere in this module.
 */
export async function computeSalesLeaderboard(
  start: Date,
  end: Date,
  targetMonth?: number,
  targetYear?: number,
): Promise<LeaderboardRow[]> {
  const [employees, calls, leadsInRange, demosInRange, students, targets] = await Promise.all([
    // Anyone who currently owns at least one lead or has ever logged a call —
    // i.e. anyone who's actually worked as a salesperson, not every employee.
    prisma.employee.findMany({
      where: { OR: [{ assignedLeads: { some: {} } }, { leadCallsLogged: { some: {} } }] },
      select: { id: true, firstName: true, lastName: true, employeeCode: true },
    }),
    prisma.leadCallLog.findMany({
      where: { calledAt: { gte: start, lt: end }, calledById: { not: null } },
      select: { calledById: true, leadId: true, calledAt: true },
    }),
    prisma.lead.findMany({
      where: {
        OR: [
          { createdAt: { gte: start, lt: end } },
          { status: 'ENROLLED', updatedAt: { gte: start, lt: end } },
          { status: 'LOST', updatedAt: { gte: start, lt: end } },
        ],
      },
      select: { id: true, assignedToId: true, createdAt: true, status: true, updatedAt: true },
    }),
    prisma.demo.findMany({
      where: {
        OR: [
          { createdAt: { gte: start, lt: end }, rescheduledFromId: null },
          { status: 'COMPLETED', scheduledAt: { gte: start, lt: end } },
        ],
      },
      select: { createdAt: true, rescheduledFromId: true, status: true, scheduledAt: true, lead: { select: { assignedToId: true } } },
    }),
    prisma.student.findMany({
      where: { joiningDate: { gte: start, lt: end }, leadId: { not: null } },
      select: { totalProgramFee: true, lead: { select: { assignedToId: true } } },
    }),
    targetMonth && targetYear
      ? prisma.salesTarget.findMany({ where: { month: targetMonth, year: targetYear } })
      : Promise.resolve([]),
  ]);

  // First-contact latency needs the earliest call per lead, not just calls
  // within the window — a lead created just before the range boundary but
  // first called just after it would otherwise be missed.
  const newLeadIds = leadsInRange.filter((l) => l.createdAt >= start && l.createdAt < end).map((l) => l.id);
  const firstCalls = newLeadIds.length
    ? await prisma.leadCallLog.findMany({
        where: { leadId: { in: newLeadIds } },
        select: { leadId: true, calledAt: true },
        orderBy: { calledAt: 'asc' },
      })
    : [];
  const firstCallByLead = new Map<string, Date>();
  for (const c of firstCalls) {
    if (c.leadId && !firstCallByLead.has(c.leadId)) firstCallByLead.set(c.leadId, c.calledAt);
  }
  const leadById = new Map(leadsInRange.map((l) => [l.id, l]));

  const rows = new Map<string, LeaderboardRow>();
  const get = (empId: string): LeaderboardRow => {
    let row = rows.get(empId);
    if (!row) {
      row = {
        employeeId: empId, firstName: '', lastName: '', employeeCode: '',
        callsMade: 0, leadsCreated: 0, demosBooked: 0, demosConducted: 0,
        enrolled: 0, lost: 0, revenue: 0, avgFirstContactHours: null, target: null,
      };
      rows.set(empId, row);
    }
    return row;
  };

  for (const emp of employees) {
    const row = get(emp.id);
    row.firstName = emp.firstName;
    row.lastName = emp.lastName;
    row.employeeCode = emp.employeeCode;
  }

  for (const c of calls) {
    if (c.calledById) get(c.calledById).callsMade++;
  }

  for (const l of leadsInRange) {
    if (!l.assignedToId) continue;
    const row = get(l.assignedToId);
    if (l.createdAt >= start && l.createdAt < end) row.leadsCreated++;
    if (l.status === 'ENROLLED' && l.updatedAt >= start && l.updatedAt < end) row.enrolled++;
    if (l.status === 'LOST' && l.updatedAt >= start && l.updatedAt < end) row.lost++;
  }

  for (const d of demosInRange) {
    const empId = d.lead?.assignedToId;
    if (!empId) continue;
    const row = get(empId);
    if (d.createdAt >= start && d.createdAt < end && !d.rescheduledFromId) row.demosBooked++;
    if (d.status === 'COMPLETED' && d.scheduledAt >= start && d.scheduledAt < end) row.demosConducted++;
  }

  for (const s of students) {
    const empId = s.lead?.assignedToId;
    if (!empId) continue;
    get(empId).revenue += s.totalProgramFee || 0;
  }

  // Average first-contact latency, per rep, over their own new leads only.
  const latenciesByEmp = new Map<string, number[]>();
  for (const leadId of newLeadIds) {
    const lead = leadById.get(leadId);
    const firstCall = firstCallByLead.get(leadId);
    if (!lead?.assignedToId || !firstCall) continue;
    const hours = (firstCall.getTime() - lead.createdAt.getTime()) / 3_600_000;
    if (hours < 0) continue; // clock skew / bad data — skip rather than distort the average
    const list = latenciesByEmp.get(lead.assignedToId) || [];
    list.push(hours);
    latenciesByEmp.set(lead.assignedToId, list);
  }
  for (const [empId, list] of latenciesByEmp) {
    get(empId).avgFirstContactHours = list.reduce((a, b) => a + b, 0) / list.length;
  }

  for (const t of targets) {
    get(t.employeeId).target = { enrollmentGoal: t.enrollmentGoal, revenueGoal: t.revenueGoal };
  }

  return Array.from(rows.values()).sort((a, b) => b.revenue - a.revenue || b.enrolled - a.enrolled);
}
