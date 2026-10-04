/**
 * Diagnostic: lists the most recently created LiveClass rows, with the exact
 * scheduleId/sub-batch/scheduledDate/status/createdBy they were saved with.
 *
 * Use this whenever Bulk Upload (or Bulk Create, or Create Class) reports
 * "N created" but those classes don't show up in Today's/Upcoming Classes —
 * this tells you straight from the database whether the rows actually exist
 * and, if so, exactly why the list view might be filtering them out (wrong
 * scheduledDate, wrong status, wrong scheduleId, etc.) rather than guessing.
 *
 * Run from backend/:
 *   npx ts-node src/utils/checkRecentLiveClasses.ts            (last 20 overall)
 *   npx ts-node src/utils/checkRecentLiveClasses.ts B18-DA-MOR (last 20 for that sub-batch code)
 */
import prisma from '../config/database';

async function main() {
  const codeFilter = process.argv[2];

  let scheduleId: string | undefined;
  if (codeFilter) {
    const schedule = await prisma.batchCourseSchedule.findFirst({
      where: { code: { equals: codeFilter } },
      select: { id: true, code: true, batch: { select: { code: true } }, course: { select: { name: true } } },
    });
    if (!schedule) {
      console.log(`No sub-batch with code "${codeFilter}" found. Check the exact code (case/spacing matters).`);
      return;
    }
    console.log(`Sub-batch: ${schedule.batch.code} / ${schedule.code} — ${schedule.course.name} (scheduleId ${schedule.id})\n`);
    scheduleId = schedule.id;
  }

  const classes = await prisma.liveClass.findMany({
    where: scheduleId ? { scheduleId } : undefined,
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true, classCode: true, title: true, status: true,
      scheduledDate: true, startTime: true, endTime: true, createdAt: true,
      schedule: { select: { code: true, batch: { select: { code: true } }, course: { select: { name: true } } } },
      createdBy: { select: { firstName: true, lastName: true } },
    },
  });

  if (classes.length === 0) {
    console.log(codeFilter ? 'No LiveClass rows exist for this sub-batch at all — nothing was ever created.' : 'No LiveClass rows exist in the whole system.');
    return;
  }

  const now = new Date();
  console.log(`Server's current time (used for Today/Upcoming filtering): ${now.toISOString()} (UTC)\n`);
  console.log('Most recently created rows:');
  for (const c of classes) {
    const scheduledUTC = c.scheduledDate.toISOString().slice(0, 10);
    const isPast = c.scheduledDate.getTime() < new Date(now.toISOString().slice(0, 10) + 'T00:00:00.000Z').getTime();
    const flag = isPast && c.status === 'SCHEDULED' ? '  <-- SCHEDULED but dated in the past: invisible in Today, Upcoming, AND Completed' : '';
    console.log(
      `  [${c.createdAt.toISOString()}] ${c.schedule.batch.code}/${c.schedule.code} — ${c.title} — ` +
      `date ${scheduledUTC} ${c.startTime}-${c.endTime} — status ${c.status} — ` +
      `createdBy ${c.createdBy ? `${c.createdBy.firstName} ${c.createdBy.lastName}` : '—'}${flag}`
    );
  }
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
