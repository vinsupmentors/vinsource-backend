/**
 * Read-only status breakdown for one batch: how many students are at each
 * onboarding stage (profile / documents / approval / done), broken out by
 * track, with per-student detail for anyone not yet fully onboarded. Same
 * stage ladder as the My Students "Onboarding" column and the admin
 * Approval screen — just aggregated per batch instead of per student.
 *
 * Usage (from backend/):
 *   npx ts-node src/utils/batchOnboardingStatus.ts 17
 */
import prisma from '../config/database';
import { getOnboardingStatus } from './onboardingStatus';

function batchNumber(s: string): string | null {
  return s.match(/\d+/)?.[0] ?? null;
}

async function main() {
  const batchArg = process.argv[2]?.trim();
  if (!batchArg) {
    console.error('Usage: npx ts-node src/utils/batchOnboardingStatus.ts <batchNumber>');
    process.exit(1);
  }
  const wantedNum = batchNumber(batchArg);
  if (!wantedNum) {
    console.error(`Couldn't find a batch number in "${batchArg}" — try e.g. "17" or "Batch 17".`);
    process.exit(1);
  }

  const allStudents = await prisma.student.findMany({
    select: {
      id: true, studentCode: true, firstName: true, lastName: true, track: true,
      enrollments: { select: { schedule: { select: { batch: { select: { code: true } } } } } },
    },
  });
  const students = allStudents.filter((s) => s.enrollments.some((e) => batchNumber(e.schedule.batch.code) === wantedNum));

  if (!students.length) {
    console.log(`No students found for batch "${batchArg}".`);
    process.exit(0);
  }

  const batchLabel = students[0].enrollments.find((e) => batchNumber(e.schedule.batch.code) === wantedNum)?.schedule.batch.code || batchArg;
  console.log(`Batch ${batchLabel} — ${students.length} student(s)\n`);

  const stageBuckets: Record<string, typeof students> = { profile: [], documents: [], approval: [], done: [] };
  for (const s of students) {
    const status = await getOnboardingStatus(s.id); // also self-heals any stale flag along the way
    const st = status.student;
    const stage = !st.profileCompletedAt ? 'profile'
      : !st.documentsCompletedAt ? 'documents'
      : !st.onboardingApprovedAt ? 'approval'
      : 'done';
    stageBuckets[stage].push(s);
  }

  const labels: Record<string, string> = {
    profile: 'Profile pending', documents: 'Documents pending', approval: 'Awaiting approval', done: 'Onboarded (approved)',
  };
  for (const stage of ['profile', 'documents', 'approval', 'done']) {
    const list = stageBuckets[stage];
    console.log(`${labels[stage]}: ${list.length}`);
    for (const s of list) {
      console.log(`    ${s.studentCode} — ${s.firstName} ${s.lastName} (${s.track})`);
    }
  }

  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
