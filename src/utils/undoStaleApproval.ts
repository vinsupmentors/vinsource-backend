/**
 * Undoes a "profile approval" that's now stale because the student's track
 * changed after they were approved.
 *
 * approveStudent() re-validates allSigned() at approval time, so it can never
 * approve someone with a missing document — but nothing re-checks that after
 * the fact. If a student is approved while on JRP (their JRP-only documents
 * all signed), and their track is *later* edited to IOP, the onboarding
 * checklist is recomputed live and now includes the IOP agreement — but
 * onboardingApprovedAt is left untouched from before, so the student still
 * shows as "approved" despite now having an unsigned required document.
 *
 * This script finds exactly that mismatch — approved, but not actually fully
 * signed under their *current* track — and clears the approval so it matches
 * reality. It does NOT touch track, status, signatures, or anything else.
 *
 * Safe by default: prints what it *would* undo. Add --confirm to actually do it.
 *
 * Usage (from backend/):
 *   npx ts-node src/utils/undoStaleApproval.ts B17            (dry run)
 *   npx ts-node src/utils/undoStaleApproval.ts B17 --confirm  (actually undo)
 *   npx ts-node src/utils/undoStaleApproval.ts --confirm      (all batches)
 */
import prisma from '../config/database';
import { getOnboardingStatus } from './onboardingStatus';

// Batch.code is a free-text label like "Batch 17" (not "B17"), and this
// project's MySQL setup doesn't support Prisma's case-insensitive `mode`
// (throws at runtime — same constraint noted elsewhere in this codebase), so
// batch matching is done in JS by comparing the batch *number* rather than
// relying on a DB-level string match. Accepts "17", "B17", "Batch 17", etc.
function batchNumber(s: string): string | null {
  return s.match(/\d+/)?.[0] ?? null;
}

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const batchArg = args.find((a) => a !== '--confirm')?.trim();
  const wantedNum = batchArg ? batchNumber(batchArg) : null;
  if (batchArg && !wantedNum) {
    console.error(`Couldn't find a batch number in "${batchArg}" — try e.g. "17" or "Batch 17".`);
    process.exit(1);
  }

  const allApproved = await prisma.student.findMany({
    where: { onboardingApprovedAt: { not: null } },
    select: {
      id: true, studentCode: true, firstName: true, lastName: true, track: true,
      enrollments: { select: { schedule: { select: { batch: { select: { code: true } } } } } },
    },
  });

  const students = wantedNum
    ? allApproved.filter((s) => s.enrollments.some((e) => batchNumber(e.schedule.batch.code) === wantedNum))
    : allApproved;

  if (!students.length) {
    console.log(batchArg ? `No approved students found for batch "${batchArg}".` : 'No approved students found.');
    process.exit(0);
  }

  const toUndo: typeof students = [];
  for (const s of students) {
    const status = await getOnboardingStatus(s.id);
    if (!status.allSigned) toUndo.push(s);
  }

  if (!toUndo.length) {
    console.log('No stale approvals found — every approved student currently has all required documents signed.');
    process.exit(0);
  }

  console.log(`${toUndo.length} student(s) approved earlier but now missing a required document for their current track:\n`);
  for (const s of toUndo) {
    const batches = [...new Set(s.enrollments.map((e) => e.schedule.batch.code))].join(', ') || '(no enrollment)';
    console.log(`  ${s.studentCode} — ${s.firstName} ${s.lastName} (${s.track}) — batch: ${batches}`);
  }

  if (!confirm) {
    console.log('\nDry run only — nothing changed. Re-run with --confirm to clear their approval.');
    process.exit(0);
  }

  await prisma.student.updateMany({
    where: { id: { in: toUndo.map((s) => s.id) } },
    data: { onboardingApprovedAt: null, onboardingApprovedById: null },
  });
  console.log(`\nDone. Cleared approval for ${toUndo.length} student(s) — they'll show as pending approval again until the missing document is signed and an admin re-approves.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
