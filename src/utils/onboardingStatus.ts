import prisma from '../config/database';

export interface OnboardingItem {
  kind: 'template' | 'fee_declaration';
  id: string;
  title: string;
  signed: boolean;
  signedAt: Date | null;
  fileUrl?: string;
  // Present only once signed — the actual proof captured at signing time,
  // surfaced for admin review in the Approval screen.
  signatureUrl?: string | null;
  photoUrl?: string | null;
  location?: string | null;
  // The stamped, self-contained "signed copy" PDF — preferred for admin
  // review over the raw signature/photo images when present. Null for rows
  // signed before this existed, or if stamping failed at sign time.
  signedPdfUrl?: string | null;
  feeDeclaration?: {
    guardianName: string | null;
    courseName: string | null;
    dueDate: Date | null;
    rows: unknown;
  };
}

/**
 * Everything a student must sign before their onboarding "documents" step is
 * complete: every active OnboardingDocumentTemplate scoped to their track
 * (null/empty applicableTracks = applies to every track), plus any
 * per-student StudentFeeDeclaration an admin has created for them.
 *
 * Recomputed fresh on every call rather than trusted from a cached flag, so
 * a fee declaration added after the fact (or a track-scoped template) is
 * picked up immediately instead of relying on a stale `documentsCompletedAt`.
 */
export async function getOnboardingStatus(studentId: string) {
  const student = await prisma.student.findUnique({ where: { id: studentId } });
  if (!student) throw new Error('Student not found');

  const [templates, signatures, declarations] = await Promise.all([
    prisma.onboardingDocumentTemplate.findMany({
      where: { isActive: true },
      orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
    }),
    prisma.studentDocumentSignature.findMany({ where: { studentId } }),
    prisma.studentFeeDeclaration.findMany({ where: { studentId }, orderBy: { createdAt: 'asc' } }),
  ]);

  const signedByTemplate = new Map(signatures.map((s) => [s.templateId, s]));

  const templateItems: OnboardingItem[] = templates
    .filter((t) => {
      const tracks = Array.isArray(t.applicableTracks) ? (t.applicableTracks as unknown as string[]) : [];
      return tracks.length === 0 || tracks.includes(student.track);
    })
    .map((t) => {
      const sig = signedByTemplate.get(t.id);
      return {
        kind: 'template' as const,
        id: t.id,
        title: t.title,
        fileUrl: t.fileUrl,
        signed: !!sig,
        signedAt: sig?.signedAt ?? null,
        signatureUrl: sig?.signatureUrl ?? null,
        photoUrl: sig?.photoUrl ?? null,
        location: sig?.location ?? null,
        signedPdfUrl: sig?.signedPdfUrl ?? null,
      };
    });

  const declarationItems: OnboardingItem[] = declarations.map((d) => ({
    kind: 'fee_declaration' as const,
    id: d.id,
    title: 'Student Declaration Form for Pending Fee Payment',
    signed: !!d.signedAt,
    signedAt: d.signedAt,
    signatureUrl: d.signatureUrl,
    photoUrl: d.photoUrl,
    location: d.location,
    signedPdfUrl: d.signedPdfUrl,
    feeDeclaration: {
      guardianName: d.guardianName,
      courseName: d.courseName,
      dueDate: d.dueDate,
      rows: d.rows,
    },
  }));

  const items = [...templateItems, ...declarationItems];
  const signedCount = items.filter((i) => i.signed).length;
  // Vacuously "all signed" when nothing is required yet — matches the
  // existing behaviour of not blocking a student on an empty checklist.
  const allSigned = items.length === 0 || signedCount === items.length;

  // Self-heal: documentsCompletedAt/onboardingApprovedAt are write-once flags
  // set at the moment everything happened to be signed — nothing revisits
  // them later. If a new template is added (or an existing one is edited to
  // newly cover this student's track, or their track itself changes), this
  // function correctly detects allSigned=false on the very next call, but the
  // cached flags above would otherwise keep claiming "done" forever,
  // inflating batch-level counts (Reports, My Students) that read the raw
  // flag instead of recomputing. Whichever page happens to call this next
  // corrects it for everyone, rather than requiring a one-off script per drift.
  let correctedStudent = student;
  if (!allSigned && (student.documentsCompletedAt || student.onboardingApprovedAt)) {
    correctedStudent = await prisma.student.update({
      where: { id: studentId },
      data: { documentsCompletedAt: null, onboardingApprovedAt: null, onboardingApprovedById: null },
    });
  }

  return {
    student: correctedStudent,
    items,
    requiredCount: items.length,
    signedCount,
    allSigned,
  };
}

/**
 * Batched equivalent of the "allSigned" check above for many students at
 * once — used by list/report endpoints (My Students roster, Reports batch
 * cards) that would otherwise return the raw, possibly-stale
 * documentsCompletedAt/onboardingApprovedAt columns straight from the DB.
 * Those two endpoints never called getOnboardingStatus() per student (an
 * N+1 query cost that's fine for a single-student dossier or a CLI script,
 * but not for a roster of hundreds), so a student whose track or the active
 * template set changed after they last signed could sit indefinitely with a
 * stale "done" flag — which is exactly what produced the batch-scoped
 * My Students filter ("19 awaiting approval") disagreeing with the
 * system-wide Approval screen ("6"), since only the latter live-recomputes
 * via getOnboardingStatus(). This does the same computation in 3 queries
 * total regardless of student count, not 3-per-student.
 */
export async function liveSignedStatusByStudent(
  students: { id: string; track: string }[]
): Promise<Map<string, boolean>> {
  const ids = students.map((s) => s.id);
  if (ids.length === 0) return new Map();

  const [templates, signatures, declarations] = await Promise.all([
    prisma.onboardingDocumentTemplate.findMany({ where: { isActive: true } }),
    prisma.studentDocumentSignature.findMany({ where: { studentId: { in: ids } }, select: { studentId: true, templateId: true } }),
    prisma.studentFeeDeclaration.findMany({ where: { studentId: { in: ids } }, select: { studentId: true, signedAt: true } }),
  ]);

  const signedSet = new Set(signatures.map((s) => `${s.studentId}::${s.templateId}`));
  const declByStudent = new Map<string, { signedAt: Date | null }[]>();
  for (const d of declarations) {
    declByStudent.set(d.studentId, [...(declByStudent.get(d.studentId) || []), { signedAt: d.signedAt }]);
  }

  const result = new Map<string, boolean>();
  for (const s of students) {
    const required = templates.filter((t) => {
      const tracks = Array.isArray(t.applicableTracks) ? (t.applicableTracks as unknown as string[]) : [];
      return tracks.length === 0 || tracks.includes(s.track);
    });
    const allTemplatesSigned = required.every((t) => signedSet.has(`${s.id}::${t.id}`));
    const decls = declByStudent.get(s.id) || [];
    const allDeclsSigned = decls.every((d) => !!d.signedAt);
    const requiredCount = required.length + decls.length;
    result.set(s.id, requiredCount === 0 || (allTemplatesSigned && allDeclsSigned));
  }
  return result;
}

/**
 * Given rows that already carry the cached documentsCompletedAt/
 * onboardingApprovedAt flags, corrects any that disagree with the live
 * signed-status computed above — both in the returned array (so the caller's
 * response is accurate immediately) and in the database (one batched
 * updateMany), so the correction sticks instead of drifting back on the next
 * read. Mirrors getOnboardingStatus()'s self-heal, just batched.
 */
export async function reconcileFlagsBatch<
  T extends { id: string; track: string; documentsCompletedAt: Date | null; onboardingApprovedAt: Date | null }
>(students: T[]): Promise<T[]> {
  if (students.length === 0) return students;
  const liveSigned = await liveSignedStatusByStudent(students);
  const staleIds: string[] = [];
  const corrected = students.map((s) => {
    const signed = liveSigned.get(s.id) ?? true;
    if (!signed && (s.documentsCompletedAt || s.onboardingApprovedAt)) {
      staleIds.push(s.id);
      return { ...s, documentsCompletedAt: null, onboardingApprovedAt: null };
    }
    return s;
  });
  if (staleIds.length > 0) {
    await prisma.student.updateMany({
      where: { id: { in: staleIds } },
      data: { documentsCompletedAt: null, onboardingApprovedAt: null, onboardingApprovedById: null },
    });
  }
  return corrected;
}
