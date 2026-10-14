/**
 * Read-only diagnostic: finds students with MORE THAN ONE ACTIVE sub-batch
 * enrollment and says what kind of "double" each one is, so you can decide
 * per student whether it's legitimate or a leftover to clean up.
 *
 *   SAME COURSE, 2 sub-batches  -> almost always a mistake (e.g. a batch
 *       transfer that left the old enrollment ACTIVE, or enrolled twice by hand)
 *   DIFFERENT COURSES, same batch -> a combo course (allowed by design)
 *   DIFFERENT COURSES, different batches -> enrolled into a second batch on top
 *       of the first (usually a leftover from moving batches)
 *
 * Nothing is changed. Run from backend/:
 *   npm run check:double-enrollments
 */
import prisma from '../config/database';

async function main() {
  const rows = await prisma.studentBatchEnrollment.findMany({
    where: { status: 'ACTIVE' },
    include: {
      student: { select: { id: true, studentCode: true, firstName: true, lastName: true, status: true, track: true } },
      schedule: { select: { id: true, code: true, status: true, batch: { select: { code: true } }, course: { select: { id: true, name: true } } } },
    },
    orderBy: { enrolledAt: 'asc' },
  });

  const byStudent = new Map<string, typeof rows>();
  for (const r of rows) {
    if (!byStudent.has(r.studentId)) byStudent.set(r.studentId, []);
    byStudent.get(r.studentId)!.push(r);
  }
  const doubles = Array.from(byStudent.values()).filter((l) => l.length > 1);
  if (!doubles.length) { console.log('No student has more than one ACTIVE enrollment.'); return; }

  const buckets: Record<string, string[]> = { 'SAME COURSE, 2 sub-batches (likely a mistake)': [], 'DIFFERENT COURSES, same batch (combo — allowed)': [], 'DIFFERENT COURSES, different batches (likely leftover)': [] };
  for (const list of doubles) {
    const s = list[0].student;
    const courses = new Set(list.map((l) => l.schedule.course.id));
    const batches = new Set(list.map((l) => l.schedule.batch.code));
    const key = courses.size < list.length ? 'SAME COURSE, 2 sub-batches (likely a mistake)'
      : batches.size === 1 ? 'DIFFERENT COURSES, same batch (combo — allowed)' : 'DIFFERENT COURSES, different batches (likely leftover)';
    const detail = list.map((l) => `    - ${l.schedule.batch.code} / ${l.schedule.code || '—'} · ${l.schedule.course.name} [${l.schedule.status}] enrolled ${l.enrolledAt.toISOString().slice(0, 10)}`).join('\n');
    buckets[key].push(`  ${s.studentCode}  ${s.firstName} ${s.lastName}  (${s.track}, ${s.status})\n${detail}`);
  }

  console.log(`${doubles.length} student(s) with more than one ACTIVE enrollment (of ${byStudent.size} enrolled).\n`);
  for (const [k, v] of Object.entries(buckets)) {
    if (!v.length) continue;
    console.log(`=== ${k} — ${v.length} ===`);
    console.log(v.join('\n\n'));
    console.log('');
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
