/**
 * Forces a fresh onboarding-status check for every student who currently
 * claims to have finished documents/approval, so the self-heal logic in
 * getOnboardingStatus() (see utils/onboardingStatus.ts) fires immediately for
 * all of them instead of waiting for someone to happen to open each one's
 * page. Corrects the exact mismatch where Reports/My Students show "Docs
 * signed" for students the Approval screen (which recomputes live) no longer
 * considers fully signed — e.g. after a new document template was added or
 * an existing one was edited to cover more tracks.
 *
 * Read-then-write only where actually stale — students who are genuinely
 * fully signed are untouched. Safe to re-run any time; this just syncs the
 * cached flags to the same ground truth every other onboarding screen uses.
 *
 * Usage (from backend/):
 *   npx ts-node src/utils/reconcileOnboardingStatus.ts        (all students)
 *   npx ts-node src/utils/reconcileOnboardingStatus.ts 17     (one batch)
 */
import prisma from '../config/database';
import { getOnboardingStatus } from './onboardingStatus';

function batchNumber(s: string): string | null {
  return s.match(/\d+/)?.[0] ?? null;
}

async function main() {
  const batchArg = process.argv[2]?.trim();
  const wantedNum = batchArg ? batchNumber(batchArg) : null;
  if (batchArg && !wantedNum) {
    console.error(`Couldn't find a batch number in "${batchArg}" — try e.g. "17" or "Batch 17".`);
    process.exit(1);
  }

  const candidates = await prisma.student.findMany({
    where: { OR: [{ documentsCompletedAt: { not: null } }, { onboardingApprovedAt: { not: null } }] },
    select: {
      id: true, studentCode: true, firstName: true, lastName: true, track: true,
      documentsCompletedAt: true, onboardingApprovedAt: true,
      enrollments: { select: { schedule: { select: { batch: { select: { code: true } } } } } },
    },
  });

  const scoped = wantedNum
    ? candidates.filter((s) => s.enrollments.some((e) => batchNumber(e.schedule.batch.code) === wantedNum))
    : candidates;

  if (!scoped.length) {
    console.log(batchArg ? `No candidates found for batch "${batchArg}".` : 'No candidates found.');
    process.exit(0);
  }

  console.log(`Checking ${scoped.length} student(s)...`);
  let corrected = 0;
  for (const s of scoped) {
    const wasDocsDone = !!s.documentsCompletedAt;
    const wasApproved = !!s.onboardingApprovedAt;
    const status = await getOnboardingStatus(s.id); // self-heal happens inside this call
    const nowDocsDone = !!status.student.documentsCompletedAt;
    if (wasDocsDone && !nowDocsDone) {
      corrected++;
      const batches = [...new Set(s.enrollments.map((e) => e.schedule.batch.code))].join(', ') || '(no enrollment)';
      console.log(`  corrected: ${s.studentCode} — ${s.firstName} ${s.lastName} (${s.track}) — batch: ${batches}${wasApproved ? ' [was also approved]' : ''}`);
    }
  }

  console.log(`\nDone. ${corrected} of ${scoped.length} were stale and have been corrected. The rest were already accurate.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
