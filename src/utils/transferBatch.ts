/**
 * One-off / reusable bulk batch-transfer tool: moves every ACTIVE student out
 * of one sub-batch schedule and into another, using the same "move" semantics
 * as Edit Student's "move to a different batch" in the Production UI — the
 * old enrollment is retired (status -> DROPPED), a fresh ACTIVE enrollment is
 * created against the destination schedule. Safe to re-run: a student who
 * already has a row for the destination schedule just gets that row
 * reactivated instead of getting a duplicate.
 *
 * Usage (from backend/):
 *   npx ts-node src/utils/transferBatch.ts <fromSubBatchCode> <toSubBatchCode>
 *
 * Example:
 *   npx ts-node src/utils/transferBatch.ts B16-DA-MOR-2 B16-DA-MOR
 */
import prisma from '../config/database';

async function main() {
  const [fromCode, toCode] = process.argv.slice(2);
  if (!fromCode || !toCode) {
    console.error('Usage: npx ts-node src/utils/transferBatch.ts <fromSubBatchCode> <toSubBatchCode>');
    process.exit(1);
  }

  const [fromSchedule, toSchedule] = await Promise.all([
    prisma.batchCourseSchedule.findUnique({ where: { code: fromCode } }),
    prisma.batchCourseSchedule.findUnique({ where: { code: toCode } }),
  ]);
  if (!fromSchedule) { console.error(`No schedule found with sub-batch code "${fromCode}"`); process.exit(1); }
  if (!toSchedule) { console.error(`No schedule found with sub-batch code "${toCode}"`); process.exit(1); }
  if (fromSchedule.id === toSchedule.id) { console.error('From and to are the same schedule — nothing to do.'); process.exit(1); }

  const activeEnrollments = await prisma.studentBatchEnrollment.findMany({
    where: { scheduleId: fromSchedule.id, status: 'ACTIVE' },
    include: { student: { select: { id: true, studentCode: true, firstName: true, lastName: true } } },
  });

  if (activeEnrollments.length === 0) {
    console.log(`No active enrollments found in "${fromCode}". Nothing to do.`);
    process.exit(0);
  }

  console.log(`Transferring ${activeEnrollments.length} student(s) from "${fromCode}" to "${toCode}"...\n`);

  let moved = 0;
  let reactivated = 0;

  for (const en of activeEnrollments) {
    const who = `${en.student.studentCode} — ${en.student.firstName} ${en.student.lastName}`;
    const existingAtDestination = await prisma.studentBatchEnrollment.findUnique({
      where: { studentId_scheduleId: { studentId: en.studentId, scheduleId: toSchedule.id } },
    });

    if (existingAtDestination) {
      // Already has a (probably DROPPED/COMPLETED) row for the destination —
      // don't violate the unique constraint by creating a second one, just
      // bring that existing row back to ACTIVE.
      await prisma.$transaction([
        prisma.studentBatchEnrollment.update({ where: { id: en.id }, data: { status: 'DROPPED' } }),
        prisma.studentBatchEnrollment.update({ where: { id: existingAtDestination.id }, data: { status: 'ACTIVE' } }),
      ]);
      console.log(`  ${who} — already had a row for "${toCode}", reactivated it.`);
      reactivated++;
      continue;
    }

    await prisma.$transaction([
      prisma.studentBatchEnrollment.update({ where: { id: en.id }, data: { status: 'DROPPED' } }),
      prisma.studentBatchEnrollment.create({ data: { studentId: en.studentId, scheduleId: toSchedule.id } }),
    ]);
    console.log(`  ${who} — moved.`);
    moved++;
  }

  console.log(`\nDone. Moved: ${moved}, reactivated existing: ${reactivated}. Total: ${moved + reactivated}.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
