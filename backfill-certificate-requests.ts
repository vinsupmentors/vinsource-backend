/**
 * One-time backfill for the certificate approval workflow (added 2026-08-19).
 *
 * The auto-creation hooks (ensureCourseCompletionCertRequest /
 * ensureInternshipCertRequest) only fire going forward, at the exact moment
 * a student's status flips to IN_PLACEMENT or a portfolio gets approved.
 * Any student who was ALREADY in the Placement Pool, or ALREADY had an
 * approved portfolio, before this feature was deployed never got a
 * StudentCertificateRequest row created for them — the Certificates page
 * would show "no certificates yet" even though they qualify.
 *
 * This walks every existing IN_PLACEMENT student and every existing
 * APPROVED portfolio and creates the missing request, using the exact same
 * idempotent helpers the live hooks use (studentId+type is unique, so this
 * is always safe to re-run).
 *
 * USAGE
 *   cd backend
 *   npx ts-node backfill-certificate-requests.ts
 */
import prisma from './src/config/database';
import { ensureCourseCompletionCertRequest, ensureInternshipCertRequest } from './src/utils/certificateRequests';

async function main() {
  const before = await prisma.studentCertificateRequest.count();

  const poolStudents = await prisma.student.findMany({
    where: { status: 'IN_PLACEMENT' },
    select: { id: true, studentCode: true, firstName: true, lastName: true, track: true },
  });
  console.log(`Found ${poolStudents.length} student(s) currently IN_PLACEMENT — ensuring Course Completion requests...`);
  for (const s of poolStudents) {
    await ensureCourseCompletionCertRequest(s.id);
  }

  const approvedPortfolios = await prisma.studentPortfolio.findMany({
    where: { status: 'APPROVED' },
    select: { studentId: true, student: { select: { studentCode: true, firstName: true, lastName: true, track: true } } },
  });
  console.log(`Found ${approvedPortfolios.length} approved portfolio(s) — ensuring Internship requests...`);
  for (const p of approvedPortfolios) {
    await ensureInternshipCertRequest(p.studentId);
  }

  const after = await prisma.studentCertificateRequest.count();
  console.log(`\nDone. StudentCertificateRequest: ${before} -> ${after} row(s) (${after - before} created).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
