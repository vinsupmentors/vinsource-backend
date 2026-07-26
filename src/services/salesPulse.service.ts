import prisma from '../config/database';

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}
function endOfDay(d: Date): Date {
  const x = startOfDay(d);
  x.setDate(x.getDate() + 1);
  return x;
}

export interface SalesPulse {
  callsMadeToday: number;
  leadsCreatedToday: number;
  /** Fresh bookings only — reschedules are tracked separately, not double-counted here. */
  demosBookedToday: number;
  demosScheduledForToday: number;
  demosConductedToday: number;
  demosRescheduledToday: number;
  demosNoShowToday: number;
  demosPendingToday: number;
  followUpsDueToday: number;
  overdueFollowUps: number;
  enrolledToday: number;
  lostToday: number;
}

/**
 * "As of right now" snapshot of today's sales activity — shared by the live
 * in-app Sales Pulse panel and the hourly/EOD report emails so both always
 * show the exact same numbers.
 */
export async function computeSalesPulse(): Promise<SalesPulse> {
  const now = new Date();
  const dayStart = startOfDay(now);
  const dayEnd = endOfDay(now);

  const [
    callsMadeToday,
    leadsCreatedToday,
    demosBookedToday,
    demosForToday,
    followUpsDueToday,
    overdueFollowUps,
    enrolledToday,
    lostToday,
  ] = await Promise.all([
    prisma.leadCallLog.count({ where: { calledAt: { gte: dayStart, lt: dayEnd } } }),
    prisma.lead.count({ where: { createdAt: { gte: dayStart, lt: dayEnd } } }),
    prisma.demo.count({ where: { createdAt: { gte: dayStart, lt: dayEnd }, rescheduledFromId: null } }),
    prisma.demo.findMany({ where: { scheduledAt: { gte: dayStart, lt: dayEnd } }, select: { status: true } }),
    prisma.lead.count({ where: { nextFollowUpAt: { gte: dayStart, lt: dayEnd } } }),
    prisma.lead.count({ where: { nextFollowUpAt: { lt: dayStart } } }),
    prisma.lead.count({ where: { status: 'ENROLLED', updatedAt: { gte: dayStart, lt: dayEnd } } }),
    prisma.lead.count({ where: { status: 'LOST', updatedAt: { gte: dayStart, lt: dayEnd } } }),
  ]);

  let demosConductedToday = 0, demosRescheduledToday = 0, demosNoShowToday = 0, demosPendingToday = 0;
  for (const d of demosForToday) {
    if (d.status === 'COMPLETED') demosConductedToday++;
    else if (d.status === 'RESCHEDULED') demosRescheduledToday++;
    else if (d.status === 'NO_SHOW') demosNoShowToday++;
    else if (d.status === 'SCHEDULED') demosPendingToday++;
  }

  return {
    callsMadeToday,
    leadsCreatedToday,
    demosBookedToday,
    demosScheduledForToday: demosForToday.length,
    demosConductedToday,
    demosRescheduledToday,
    demosNoShowToday,
    demosPendingToday,
    followUpsDueToday,
    overdueFollowUps,
    enrolledToday,
    lostToday,
  };
}
