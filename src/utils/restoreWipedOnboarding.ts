/**
 * One-time remediation for the 2026-08 incident: the self-heal logic that
 * used to live in getOnboardingStatus()/reconcileFlagsBatch() (see
 * onboardingStatus.ts — now removed) permanently nulled out
 * documentsCompletedAt/onboardingApprovedAt for any already-completed
 * student the instant a live recheck disagreed with those cached flags —
 * which fired for basically every returning student the moment a new
 * OnboardingDocumentTemplate started applying to their track, or just from
 * someone opening My Students/Reports. That locked them out of the portal
 * entirely, back to "sign documents again" + a fresh admin-approval queue.
 *
 * The code no longer does this, but students already wiped by it are still
 * locked out today — their flags are null in the DB right now. This script
 * finds and restores exactly those students, and only those:
 *
 *   - profileCompletedAt is set (they genuinely finished that step), AND
 *   - documentsCompletedAt or onboardingApprovedAt is currently null, AND
 *   - the LIVE, freshly-recomputed check says every currently-required
 *     document/fee-declaration IS actually signed right now.
 *
 * That last condition is what makes this safe: a student who is genuinely
 * still missing a real, currently-required document is left untouched and
 * correctly still gated — this only restores students who are 100% caught
 * up today but whose flags were wiped out from under them.
 *
 * The original completion/approval timestamp and the original approving
 * admin can't be recovered (the wipe overwrote them) — restored students get
 * documentsCompletedAt/onboardingApprovedAt set to now(), with
 * onboardingApprovedById left null (no attributable approver). That's a
 * minor, acceptable audit-trail gap given the alternative is leaving them
 * locked out.
 *
 * Safe by default: prints what it *would* restore. Add --confirm to actually do it.
 *
 * Usage (from backend/):
 *   npx ts-node src/utils/restoreWipedOnboarding.ts            (dry run, all students)
 *   npx ts-node src/utils/restoreWipedOnboarding.ts --confirm  (actually restore)
 */
import prisma from '../config/database';
import { getOnboardingStatus } from './onboardingStatus';

async function main() {
  const confirm = process.argv.includes('--confirm');

  const candidates = await prisma.student.findMany({
    where: {
      profileCompletedAt: { not: null },
      OR: [{ documentsCompletedAt: null }, { onboardingApprovedAt: null }],
    },
    select: { id: true, studentCode: true, firstName: true, lastName: true, track: true, documentsCompletedAt: true, onboardingApprovedAt: true },
  });

  if (!candidates.length) {
    console.log('No candidates found — nobody currently has a null documentsCompletedAt/onboardingApprovedAt with a completed profile.');
    process.exit(0);
  }

  console.log(`Checking ${candidates.length} student(s) with a completed profile but missing document/approval flags...`);
  const toRestore: typeof candidates = [];
  for (const s of candidates) {
    const status = await getOnboardingStatus(s.id);
    if (status.allSigned) toRestore.push(s);
  }

  if (!toRestore.length) {
    console.log('\nNone of them are actually fully signed right now — nothing to restore. (They may be genuinely mid-onboarding, or still missing a real document.)');
    process.exit(0);
  }

  console.log(`\n${toRestore.length} of ${candidates.length} are fully signed right now but locked out by wiped flags:`);
  for (const s of toRestore) {
    console.log(`  ${s.studentCode} — ${s.firstName} ${s.lastName} (${s.track})`);
  }

  if (!confirm) {
    console.log('\nDry run only — nothing changed. Re-run with --confirm to restore access for the students listed above.');
    process.exit(0);
  }

  const now = new Date();
  await prisma.student.updateMany({
    where: { id: { in: toRestore.map((s) => s.id) } },
    data: { documentsCompletedAt: now, onboardingApprovedAt: now },
  });
  console.log(`\nRestored documentsCompletedAt/onboardingApprovedAt for ${toRestore.length} student(s). They can log in normally again.`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
