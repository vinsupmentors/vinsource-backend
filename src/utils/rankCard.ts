import prisma from '../config/database';

/**
 * Rank card per enrollment — extracted from placements.controller.ts's
 * getStudentProfile so it can be reused by the certificate approval review
 * screen (which must show the student's rank card alongside their profile
 * during Fee/LDM approval), without duplicating this fairly large
 * computation. Behavior is unchanged from the original inline version.
 */
export async function computeRankCard(studentId: string) {
  const enrollments = await prisma.studentBatchEnrollment.findMany({
    where: { studentId },
    include: { schedule: { include: { course: { select: { id: true, name: true } }, batch: { select: { code: true } } } } },
  });

  return Promise.all(
    enrollments.map(async (e) => {
      const scheduleId = e.scheduleId;
      const classmateIds = (
        await prisma.studentBatchEnrollment.findMany({ where: { scheduleId }, select: { studentId: true } })
      ).map((c) => c.studentId);

      const marks = await prisma.moduleMark.findMany({
        where: { studentId: { in: classmateIds }, test: { scheduleId } },
        include: { test: { select: { maxMarks: true } } },
      });

      const totalsByStudent = new Map<string, { obtained: number; max: number }>();
      for (const sid of classmateIds) totalsByStudent.set(sid, { obtained: 0, max: 0 });
      for (const m of marks) {
        const t = totalsByStudent.get(m.studentId)!;
        t.obtained += m.marksObtained;
        t.max += m.test.maxMarks;
      }
      const onlineAttemptTotals = await prisma.onlineTestAttempt.findMany({
        where: { studentId: { in: classmateIds }, release: { scheduleId }, score: { not: null }, totalMarks: { not: null } },
        select: { studentId: true, score: true, totalMarks: true },
      });
      for (const a of onlineAttemptTotals) {
        const t = totalsByStudent.get(a.studentId);
        if (!t) continue;
        t.obtained += a.score ?? 0;
        t.max += a.totalMarks ?? 0;
      }

      const ranked = Array.from(totalsByStudent.entries())
        .map(([sid, t]) => ({ id: sid, pct: t.max ? (t.obtained / t.max) * 100 : 0 }))
        .sort((a, b) => b.pct - a.pct);

      const myIndex = ranked.findIndex((r) => r.id === studentId);
      const myTotals = totalsByStudent.get(studentId) ?? { obtained: 0, max: 0 };
      const classAverage = ranked.length ? ranked.reduce((s, r) => s + r.pct, 0) / ranked.length : 0;

      const projectSubmissions = await prisma.projectSubmission.findMany({
        where: { studentId, release: { scheduleId } },
        include: {
          release: { include: { project: { select: { title: true, isCapstone: true, module: { select: { title: true } } } } } },
        },
        orderBy: { submittedAt: 'desc' },
      });

      const moduleFeedback = await prisma.moduleFeedback.findMany({
        where: { studentId, scheduleId },
        include: {
          module: { select: { title: true, order: true } },
          trainer: { select: { firstName: true, lastName: true } },
        },
        orderBy: { updatedAt: 'desc' },
      });

      const [myModuleMarks, myOnlineAttempts] = await Promise.all([
        prisma.moduleMark.findMany({
          where: { studentId, test: { scheduleId } },
          include: { test: { select: { id: true, title: true, testDate: true, maxMarks: true } } },
        }),
        prisma.onlineTestAttempt.findMany({
          where: { studentId, release: { scheduleId }, score: { not: null }, totalMarks: { not: null } },
          include: { release: { include: { test: { select: { id: true, title: true } } } } },
        }),
      ]);
      const tests = [
        ...myModuleMarks.map((m) => ({
          id: m.id, title: m.test.title, type: 'Offline' as const,
          marksObtained: m.marksObtained, maxMarks: m.test.maxMarks, date: m.test.testDate,
        })),
        ...myOnlineAttempts.map((a) => ({
          id: a.id, title: a.release.test.title, type: 'Online' as const,
          marksObtained: a.score!, maxMarks: a.totalMarks!, date: a.submittedAt ?? a.startedAt,
        })),
      ].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

      const attendanceRows = await prisma.studentAttendance.findMany({
        where: { studentId, scheduleId },
        select: { status: true },
      });
      const attendance = {
        present: attendanceRows.filter((a) => a.status === 'PRESENT').length,
        absent: attendanceRows.filter((a) => a.status === 'ABSENT').length,
        late: attendanceRows.filter((a) => a.status === 'LATE').length,
        total: attendanceRows.length,
      };

      return {
        scheduleId,
        courseId: e.schedule.course.id,
        courseName: e.schedule.course.name,
        batchCode: e.schedule.batch.code,
        rank: myIndex === -1 ? null : myIndex + 1,
        totalStudents: ranked.length,
        marksObtained: myTotals.obtained,
        marksMax: myTotals.max,
        percentage: Math.round((myTotals.max ? (myTotals.obtained / myTotals.max) * 100 : 0) * 10) / 10,
        classAverage: Math.round(classAverage * 10) / 10,
        attendance,
        tests,
        projects: projectSubmissions.map((s) => ({
          id: s.id,
          projectTitle: s.release.project.title,
          moduleTitle: s.release.project.module.title,
          isCapstone: s.release.project.isCapstone,
          status: s.status,
          submittedAt: s.submittedAt,
          fileUrl: s.fileUrl,
          linkUrl: s.linkUrl,
          graded: s.grade !== null,
          grade: s.grade,
          maxGrade: s.maxGrade,
          reviewNote: s.reviewNote,
        })),
        moduleFeedback: moduleFeedback.map((f) => ({
          id: f.id,
          moduleTitle: f.module.title,
          order: f.module.order,
          rating: f.rating,
          comments: f.comments,
          trainerName: f.trainer ? `${f.trainer.firstName} ${f.trainer.lastName}` : null,
          updatedAt: f.updatedAt,
        })),
      };
    })
  );
}
