import prisma from '../config/database';

export interface Badge {
  id: string;
  emoji: string;
  label: string;
  desc: string;
  earned: boolean;
}

export interface Gamification {
  streak: number;
  badges: Badge[];
}

/**
 * Computes the attendance streak and auto-badges for a student.
 * Everything is derived live from existing data — nothing is stored.
 *
 * Streak: consecutive most-recent class days (across all the student's
 * sub-batches) where they were PRESENT or LATE. Days without any class
 * don't break the streak; an ABSENT day does.
 */
export async function computeGamification(studentId: string): Promise<Gamification> {
  const [attendance, projectSubmissionCount, certCount, myMarks, enrollments] = await Promise.all([
    prisma.studentAttendance.findMany({
      where: { studentId },
      select: { date: true, status: true },
      orderBy: { date: 'desc' },
    }),
    prisma.projectSubmission.count({ where: { studentId } }),
    prisma.certificate.count({ where: { studentId } }),
    prisma.moduleMark.findMany({
      where: { studentId },
      select: { marksObtained: true, test: { select: { maxMarks: true } } },
    }),
    prisma.studentBatchEnrollment.findMany({ where: { studentId }, select: { scheduleId: true } }),
  ]);

  // ── Streak: collapse to one status per calendar day (PRESENT/LATE beats ABSENT) ──
  const byDay = new Map<string, boolean>(); // day -> attended?
  for (const a of attendance) {
    const day = a.date.toISOString().slice(0, 10);
    const attended = a.status !== 'ABSENT';
    byDay.set(day, (byDay.get(day) ?? false) || attended);
  }
  const days = Array.from(byDay.keys()).sort().reverse(); // newest first
  let streak = 0;
  for (const day of days) {
    if (byDay.get(day)) streak += 1;
    else break;
  }

  // ── 90% attendance in any calendar month (min 8 class days) ──
  const byMonth = new Map<string, { total: number; attended: number }>();
  for (const [day, attended] of byDay) {
    const month = day.slice(0, 7);
    const m = byMonth.get(month) ?? { total: 0, attended: 0 };
    m.total += 1;
    if (attended) m.attended += 1;
    byMonth.set(month, m);
  }
  const has90Month = Array.from(byMonth.values()).some((m) => m.total >= 8 && m.attended / m.total >= 0.9);

  // ── Top-3 rank in any sub-batch (needs at least 4 classmates and real marks) ──
  let top3 = false;
  for (const e of enrollments) {
    const classmateIds = (
      await prisma.studentBatchEnrollment.findMany({ where: { scheduleId: e.scheduleId }, select: { studentId: true } })
    ).map((c) => c.studentId);
    if (classmateIds.length < 4) continue;

    const marks = await prisma.moduleMark.findMany({
      where: { studentId: { in: classmateIds }, test: { scheduleId: e.scheduleId } },
      select: { studentId: true, marksObtained: true, test: { select: { maxMarks: true } } },
    });
    if (!marks.length) continue;

    const totals = new Map<string, { obtained: number; max: number }>();
    for (const id of classmateIds) totals.set(id, { obtained: 0, max: 0 });
    for (const m of marks) {
      const t = totals.get(m.studentId)!;
      t.obtained += m.marksObtained;
      t.max += m.test.maxMarks;
    }
    const mine = totals.get(studentId);
    if (!mine || mine.max === 0) continue;

    const ranked = Array.from(totals.entries())
      .map(([id, t]) => ({ id, pct: t.max ? t.obtained / t.max : 0 }))
      .sort((a, b) => b.pct - a.pct);
    const myRank = ranked.findIndex((r) => r.id === studentId) + 1;
    if (myRank >= 1 && myRank <= 3) { top3 = true; break; }
  }

  const perfectScore = myMarks.some((m) => m.test.maxMarks > 0 && m.marksObtained >= m.test.maxMarks);

  const badges: Badge[] = [
    { id: 'STREAK_7', emoji: '🔥', label: 'Week Warrior', desc: '7-day attendance streak', earned: streak >= 7 },
    { id: 'STREAK_30', emoji: '⚡', label: 'Unstoppable', desc: '30-day attendance streak', earned: streak >= 30 },
    { id: 'ATTENDANCE_90', emoji: '🗓️', label: '90% Attendance Month', desc: '90%+ attendance in a calendar month', earned: has90Month },
    { id: 'FIRST_PROJECT', emoji: '🚀', label: 'First Project Submitted', desc: 'Submitted your first project', earned: projectSubmissionCount >= 1 },
    { id: 'PROJECT_PRO', emoji: '🛠️', label: 'Project Pro', desc: '3+ projects submitted', earned: projectSubmissionCount >= 3 },
    { id: 'TOP_3', emoji: '🏆', label: 'Top 3 Rank', desc: 'Ranked top 3 in your sub-batch', earned: top3 },
    { id: 'PERFECT_SCORE', emoji: '💯', label: 'Perfect Score', desc: 'Full marks in a module test', earned: perfectScore },
    { id: 'CERTIFIED', emoji: '🎖️', label: 'Certified', desc: 'Earned a course certificate', earned: certCount >= 1 },
  ];

  return { streak, badges };
}
