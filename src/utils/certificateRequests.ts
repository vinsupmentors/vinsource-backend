import prisma from '../config/database';

/**
 * Course Completion certificate: auto-created the moment a student's status
 * flips to IN_PLACEMENT, from any of the several places that can do that —
 * Production's per-sub-batch push, the general bulk-status tool, a single
 * manual edit, a trainer's one-at-a-time push, or Placements' bulk-by-code
 * push. Idempotent (studentId+type is unique), so calling this again for a
 * student who already has one is a silent no-op — safe to call from every
 * status-flip site without worrying about duplicates.
 *
 * PT (direct-placement) students never take a course at all, so if the
 * student has no enrollment yet this simply does nothing — there's no
 * course to put on a "course completion" certificate for them.
 */
export async function ensureCourseCompletionCertRequest(studentId: string): Promise<void> {
  try {
    const existing = await prisma.studentCertificateRequest.findUnique({
      where: { studentId_type: { studentId, type: 'COURSE_COMPLETION' } },
    });
    if (existing) return;

    const enrollment = await prisma.studentBatchEnrollment.findFirst({
      where: { studentId },
      include: { schedule: { select: { courseId: true } } },
      orderBy: { enrolledAt: 'desc' },
    });
    if (!enrollment) return;

    await prisma.studentCertificateRequest.create({
      data: { studentId, type: 'COURSE_COMPLETION', courseId: enrollment.schedule.courseId },
    });
  } catch {
    // Certificate bookkeeping should never block the actual status-flip
    // action it's piggybacking on (e.g. pushing a student to the Placement Pool).
  }
}

/**
 * Internship certificate: auto-created the moment a student's portfolio is
 * APPROVED. Idempotent for the same reason as above — a portfolio can be
 * rejected and re-approved without ever creating a second request.
 */
export async function ensureInternshipCertRequest(studentId: string): Promise<void> {
  try {
    const existing = await prisma.studentCertificateRequest.findUnique({
      where: { studentId_type: { studentId, type: 'INTERNSHIP' } },
    });
    if (existing) return;

    await prisma.studentCertificateRequest.create({
      data: { studentId, type: 'INTERNSHIP' },
    });
  } catch {
    // Don't block portfolio approval on this.
  }
}
