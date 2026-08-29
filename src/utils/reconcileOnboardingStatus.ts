/**
 * READ-ONLY DIAGNOSTIC. Reports every student who currently claims to have
 * finished documents/approval but whose live-recomputed status disagrees —
 * e.g. after a new document template was added, or an existing one was
 * edited to cover more tracks. Useful for seeing how many students a new
 * template will affect before rolling it out.
 *
 * This used to also *write* the correction (null out documentsCompletedAt/
 * onboardingApprovedAt) for every student it found stale — via the same
 * self-heal getOnboardingStatus() used to do internally. That write was the
 * root cause of the 2026-08 incident where running this script (or even
 * just loading My Students/Reports) permanently locked every already-
 * completed student out of the portal, back to a fresh admin-approval
 * queue, the moment a new template applied to their track. Both the self-
 * heal in onboardingStatus.ts and the write here have been removed —
 * documentsCompletedAt/onboardingApprovedAt are write-once now, only ever
 * set by the actual sign/approve actions. This script no longer changes
 * anything; it just tells you who's outstanding on a newly-added document
 * so you can decide whether to nudge them, not silently re-lock them.
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
  let stale = 0;
  for (const s of scoped) {
    const wasDocsDone = !!s.documentsCompletedAt;
    const wasApproved = !!s.onboardingApprovedAt;
    const status = await getOnboardingStatus(s.id); // read-only — nothing is written
    if (wasDocsDone && !status.allSigned) {
      stale++;
      const batches = [...new Set(s.enrollments.map((e) => e.schedule.batch.code))].join(', ') || '(no enrollment)';
      const missing = status.items.filter((i) => !i.signed).map((i) => i.title).join('; ');
      console.log(`  outstanding: ${s.studentCode} — ${s.firstName} ${s.lastName} (${s.track}) — batch: ${batches}${wasApproved ? ' [currently approved]' : ''} — missing: ${missing}`);
    }
  }

  console.log(`\nDone. ${stale} of ${scoped.length} have a newly-required document outstanding. This is informational only — nothing was changed.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
