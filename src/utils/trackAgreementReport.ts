/**
 * Read-only reconciliation report: finds students whose current `track`
 * requires an onboarding document (e.g. the IOP agreement) they have never
 * actually signed. Exists for exactly the "bulk upload defaulted to JRP,
 * then someone edited a batch of students to IOP" scenario — the edit
 * changes what documents the system *requires*, but doesn't retroactively
 * make an unsigned agreement signed. This never writes anything; it only
 * lists who needs attention so an admin can decide, per student, whether to
 * revert them to JRP or actually collect the missing signature.
 *
 * Usage (from backend/):
 *   npx ts-node src/utils/trackAgreementReport.ts
 *   npx ts-node src/utils/trackAgreementReport.ts IOP        (filter to one track)
 */
import prisma from '../config/database';

async function main() {
  const trackFilter = process.argv[2]?.trim().toUpperCase();

  const [students, templates, signatures] = await Promise.all([
    prisma.student.findMany({
      where: trackFilter ? { track: trackFilter as never } : undefined,
      select: { id: true, studentCode: true, firstName: true, lastName: true, track: true },
    }),
    prisma.onboardingDocumentTemplate.findMany({ where: { isActive: true } }),
    prisma.studentDocumentSignature.findMany({ select: { studentId: true, templateId: true } }),
  ]);

  const signedSet = new Set(signatures.map((s) => `${s.studentId}::${s.templateId}`));

  type Row = { studentCode: string; name: string; track: string; missing: string[] };
  const rows: Row[] = [];

  for (const s of students) {
    const requiredTemplates = templates.filter((t) => {
      const tracks = Array.isArray(t.applicableTracks) ? (t.applicableTracks as unknown as string[]) : [];
      return tracks.length === 0 || tracks.includes(s.track);
    });
    const missing = requiredTemplates
      .filter((t) => !signedSet.has(`${s.id}::${t.id}`))
      .map((t) => t.title);
    if (missing.length) {
      rows.push({ studentCode: s.studentCode, name: `${s.firstName} ${s.lastName}`, track: s.track, missing });
    }
  }

  if (!rows.length) {
    console.log(trackFilter ? `No ${trackFilter} students with missing signatures.` : 'No students with missing signatures.');
    process.exit(0);
  }

  console.log(`${rows.length} student(s) with an unsigned document required for their current track:\n`);
  for (const r of rows) {
    console.log(`  ${r.studentCode} — ${r.name} (${r.track})`);
    for (const m of r.missing) console.log(`      missing: ${m}`);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
