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

  return {
    student,
    items,
    requiredCount: items.length,
    signedCount,
    // Vacuously "all signed" when nothing is required yet — matches the
    // existing behaviour of not blocking a student on an empty checklist.
    allSigned: items.length === 0 || signedCount === items.length,
  };
}
