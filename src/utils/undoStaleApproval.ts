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

async function main() {
  const args = process.argv.slice(2);
  const confirm = args.includes('--confirm');
  const batchPrefix = args.find((a) => a !== '--confirm')?.trim().toUpperCase();

  const students = await prisma.student.findMany({
    where: {
      onboardingApprovedAt: { not: null },
      ...(batchPrefix
        ? { enrollments: { some: { schedule: { batch: { code: { startsWith: batchPrefix } } } } } }
        : {}),
    },
    select: {
      id: true, studentCode: true, firstName: true, lastName: true, track: true,
      enrollments: { select: { schedule: { select: { batch: { select: { code: true } } } } } },
    },
  });

  if (!students.length) {
    console.log(batchPrefix ? `No approved students found for batch "${batchPrefix}".` : 'No approved students found.');
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
