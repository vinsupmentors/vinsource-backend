import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };
const studentSelect = { id: true, firstName: true, lastName: true, studentCode: true, track: true, status: true, phone: true, email: true };
// Extended profile fields shown only on the full A-Z student report (kept separate from
// studentSelect so the lightweight list/search endpoint doesn't pull all this every keystroke).
const studentProfileSelect = {
  ...studentSelect,
  dateOfBirth: true, gender: true, address: true, city: true, state: true, pincode: true,
  joiningDate: true, fatherName: true, fatherPhone: true, motherName: true, motherPhone: true,
  photo: true, aadharNumber: true, aadharPhoto: true, emergencyContactName: true, emergencyContactPhone: true,
  movedToPlacementAt: true,
};

/** Parses `?from=YYYY-MM-DD&to=YYYY-MM-DD` into a Prisma date-range filter, defaulting to the last 30 days. */
function parseDateRange(req: AuthRequest) {
  const { from, to } = req.query;
  const toDate = to ? new Date(String(to)) : new Date();
  const fromDate = from ? new Date(String(from)) : new Date(toDate.getTime() - 29 * 86400000);
  fromDate.setHours(0, 0, 0, 0);
  toDate.setHours(23, 59, 59, 999);
  return { fromDate, toDate };
}

export const productionReportsController = {
  // ── TRAINER REPORT ──────────────────────────────────────────────────────────
  // Per-trainer rollup: schedules assigned, students taught, KRA logs filed,
  // tests set, and feedback given — across an optional date range.
  async trainerReport(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { fromDate, toDate } = parseDateRange(req);
      const { trainerId } = req.query;

      const assignments = await prisma.trainerAssignment.findMany({
        where: trainerId ? { trainerId: String(trainerId) } : undefined,
        include: {
          trainer: { select: employeeSelect },
          schedule: {
            include: {
              course: { select: { id: true, name: true } },
              batch: { select: { id: true, code: true } },
              _count: { select: { enrollments: true } },
            },
          },
        },
      });

      const byTrainer = new Map<string, {
        trainer: typeof assignments[number]['trainer'];
        schedules: { scheduleId: string; courseName: string; batchCode: string; studentCount: number }[];
      }>();
      for (const a of assignments) {
        if (!a.trainer) continue;
        if (!byTrainer.has(a.trainerId)) byTrainer.set(a.trainerId, { trainer: a.trainer, schedules: [] });
        byTrainer.get(a.trainerId)!.schedules.push({
          scheduleId: a.scheduleId,
          courseName: a.schedule.course.name,
          batchCode: a.schedule.batch.code,
          studentCount: a.schedule._count.enrollments,
        });
      }

      const trainerIds = Array.from(byTrainer.keys());
      const [kraCounts, testCounts, feedbackCounts] = await Promise.all([
        prisma.kRAEntry.groupBy({
          by: ['trainerId'],
          where: { trainerId: { in: trainerIds }, date: { gte: fromDate, lte: toDate } },
          _count: { _all: true },
        }),
        prisma.moduleTest.findMany({
          where: { schedule: { trainers: { some: { trainerId: { in: trainerIds } } } }, testDate: { gte: fromDate, lte: toDate } },
          include: { schedule: { include: { trainers: true } } },
        }),
        prisma.moduleFeedback.groupBy({
          by: ['trainerId'],
          where: { trainerId: { in: trainerIds }, createdAt: { gte: fromDate, lte: toDate } },
          _count: { _all: true },
        }),
      ]);
      const kraByTrainer = new Map(kraCounts.map((k) => [k.trainerId, k._count._all]));
      const feedbackByTrainer = new Map(feedbackCounts.map((f) => [f.trainerId, f._count._all]));
      const testsByTrainer = new Map<string, number>();
      for (const t of testCounts) {
        for (const tr of t.schedule.trainers) {
          if (trainerIds.includes(tr.trainerId)) testsByTrainer.set(tr.trainerId, (testsByTrainer.get(tr.trainerId) || 0) + 1);
        }
      }

      const data = Array.from(byTrainer.entries()).map(([id, v]) => ({
        trainerId: id,
        trainerName: `${v.trainer!.firstName} ${v.trainer!.lastName}`,
        employeeCode: v.trainer!.employeeCode,
        scheduleCount: v.schedules.length,
        totalStudents: v.schedules.reduce((s, sch) => s + sch.studentCount, 0),
        schedules: v.schedules,
        kraEntriesLogged: kraByTrainer.get(id) || 0,
        testsSet: testsByTrainer.get(id) || 0,
        feedbackGiven: feedbackByTrainer.get(id) || 0,
      }));

      res.json({ success: true, data, range: { from: fromDate, to: toDate } });
    } catch (err) { next(err); }
  },

  // ── BATCH-WISE & SUB-BATCH-WISE REPORT ──────────────────────────────────────
  // "Batch-wise" = one row per Batch (rolled up across all its course schedules).
  // "Sub-batch-wise" = one row per BatchCourseSchedule, further broken down by
  // student track (JRP/IOP/PAP) since that's how trainers think of "sub-batch".
  async batchReport(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { batchId, courseId } = req.query;
      const where: Record<string, unknown> = {};
      if (batchId) where.id = String(batchId);
      if (courseId) where.schedules = { some: { courseId: String(courseId) } };
      const batches = await prisma.batch.findMany({
        where: Object.keys(where).length ? where : undefined,
        include: {
          schedules: {
            where: courseId ? { courseId: String(courseId) } : undefined,
            include: {
              course: { select: { id: true, name: true } },
              trainers: { include: { trainer: { select: employeeSelect } } },
              enrollments: { include: { student: { select: studentSelect } } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      const data = batches.map((b) => {
        const subBatches = b.schedules.map((s) => {
          const trackCounts: Record<string, number> = { JRP: 0, IOP: 0, PAP: 0 };
          for (const e of s.enrollments) trackCounts[e.student.track] = (trackCounts[e.student.track] || 0) + 1;
          return {
            scheduleId: s.id,
            courseName: s.course.name,
            timing: s.timing,
            dayPattern: s.dayPattern,
            mode: s.mode,
            trainers: s.trainers.map((t) => `${t.trainer.firstName} ${t.trainer.lastName}`),
            studentCount: s.enrollments.length,
            trackBreakdown: trackCounts,
          };
        });
        return {
          batchId: b.id,
          batchCode: b.code,
          status: b.status,
          startDate: b.startDate,
          endDate: b.endDate,
          subBatchCount: subBatches.length,
          totalStudents: subBatches.reduce((s, sb) => s + sb.studentCount, 0),
          subBatches,
        };
      });

      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  // ── STUDENT ATTENDANCE REPORT ────────────────────────────────────────────────
  // Per-student attendance % and absentee list over a date range, optionally
  // scoped to a schedule (sub-batch) or batch.
  async attendanceReport(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { fromDate, toDate } = parseDateRange(req);
      const { scheduleId, batchId, courseId, track, trainerId } = req.query;

      const scheduleWhere: Record<string, unknown> = {};
      if (scheduleId) scheduleWhere.id = String(scheduleId);
      if (batchId) scheduleWhere.batchId = String(batchId);
      if (courseId) scheduleWhere.courseId = String(courseId);
      if (trainerId) scheduleWhere.trainers = { some: { trainerId: String(trainerId) } };

      const enrollmentWhere: Record<string, unknown> = { status: 'ACTIVE' };
      if (scheduleId || batchId || courseId || trainerId) enrollmentWhere.schedule = scheduleWhere;
      if (track) enrollmentWhere.student = { track: String(track) };

      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: enrollmentWhere,
        include: {
          student: { select: studentSelect },
          schedule: { select: { id: true, batch: { select: { code: true } }, course: { select: { name: true } } } },
        },
      });

      const studentIds = enrollments.map((e) => e.studentId);
      const attendances = await prisma.studentAttendance.findMany({
        where: { studentId: { in: studentIds }, date: { gte: fromDate, lte: toDate } },
      });
      const byStudent = new Map<string, typeof attendances>();
      for (const a of attendances) {
        if (!byStudent.has(a.studentId)) byStudent.set(a.studentId, []);
        byStudent.get(a.studentId)!.push(a);
      }

      const data = enrollments.map((e) => {
        const records = byStudent.get(e.studentId) || [];
        const present = records.filter((r) => r.status === 'PRESENT' || r.status === 'LATE').length;
        const absent = records.filter((r) => r.status === 'ABSENT').length;
        const total = records.length;
        return {
          enrollmentId: e.id,
          studentId: e.studentId,
          studentName: `${e.student.firstName} ${e.student.lastName}`,
          studentCode: e.student.studentCode,
          track: e.student.track,
          batchCode: e.schedule.batch.code,
          courseName: e.schedule.course.name,
          totalDays: total,
          present,
          absent,
          attendancePct: total ? Math.round((present / total) * 1000) / 10 : null,
          absentDates: records.filter((r) => r.status === 'ABSENT').map((r) => r.date),
        };
      });

      res.json({ success: true, data, range: { from: fromDate, to: toDate } });
    } catch (err) { next(err); }
  },

  // ── CONSOLIDATED STUDENT REPORT ("A to Z") ──────────────────────────────────
  // Everything about one student in one place: enrollments, rank/marks,
  // projects, trainer module feedback, and attendance — reusing the same
  // ranking logic as the student-facing Rank Card.
  async studentReport(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { studentId } = req.params;
      const student = await prisma.student.findUnique({ where: { id: studentId }, select: studentProfileSelect });
      if (!student) throw new AppError('Student not found', 404);

      const certificates = await prisma.certificate.findMany({
        where: { studentId },
        include: { course: { select: { name: true } } },
        orderBy: { issuedAt: 'desc' },
      });

      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { studentId },
        orderBy: { enrolledAt: 'desc' },
        include: { schedule: { include: { course: { select: { id: true, name: true } }, batch: { select: { code: true } } } } },
      });

      const data = [];
      for (const e of enrollments) {
        const scheduleId = e.scheduleId;
        const classmateIds = (
          await prisma.studentBatchEnrollment.findMany({ where: { scheduleId }, select: { studentId: true } })
        ).map((c) => c.studentId);

        const marks = await prisma.moduleMark.findMany({
          where: { studentId: { in: classmateIds }, test: { scheduleId } },
          include: { test: { select: { maxMarks: true } } },
        });
        const totalsByStudent = new Map<string, { obtained: number; max: number }>();
        for (const id of classmateIds) totalsByStudent.set(id, { obtained: 0, max: 0 });
        for (const m of marks) {
          const t = totalsByStudent.get(m.studentId)!;
          t.obtained += m.marksObtained;
          t.max += m.test.maxMarks;
        }
        const ranked = Array.from(totalsByStudent.entries())
          .map(([id, t]) => ({ id, pct: t.max ? (t.obtained / t.max) * 100 : 0 }))
          .sort((a, b) => b.pct - a.pct);
        const myIndex = ranked.findIndex((r) => r.id === studentId);
        const myTotals = totalsByStudent.get(studentId)!;
        const classAverage = ranked.length ? ranked.reduce((s, r) => s + r.pct, 0) / ranked.length : 0;

        const projectSubmissions = await prisma.projectSubmission.findMany({
          where: { studentId, release: { scheduleId } },
          include: { release: { include: { project: { select: { title: true, module: { select: { title: true } } } } } } },
          orderBy: { submittedAt: 'desc' },
        });
        const moduleFeedback = await prisma.moduleFeedback.findMany({
          where: { studentId, scheduleId },
          include: { module: { select: { title: true, order: true } }, trainer: { select: { firstName: true, lastName: true } } },
          orderBy: { updatedAt: 'desc' },
        });
        const attendance = await prisma.studentAttendance.findMany({ where: { studentId, scheduleId }, orderBy: { date: 'desc' } });
        const present = attendance.filter((a) => a.status === 'PRESENT' || a.status === 'LATE').length;

        const testAttempts = await prisma.onlineTestAttempt.findMany({
          where: { studentId, release: { scheduleId } },
          include: { release: { include: { test: { select: { title: true, module: { select: { title: true } } } } } } },
          orderBy: { submittedAt: 'desc' },
        });

        data.push({
          scheduleId,
          batchCode: e.schedule.batch.code,
          courseId: e.schedule.course.id,
          courseName: e.schedule.course.name,
          enrollmentStatus: e.status,
          enrolledAt: e.enrolledAt,
          rank: myIndex === -1 ? null : myIndex + 1,
          totalStudents: ranked.length,
          marksObtained: myTotals.obtained,
          marksMax: myTotals.max,
          percentage: Math.round((myTotals.max ? (myTotals.obtained / myTotals.max) * 100 : 0) * 10) / 10,
          classAverage: Math.round(classAverage * 10) / 10,
          attendancePct: attendance.length ? Math.round((present / attendance.length) * 1000) / 10 : null,
          attendanceLog: attendance.map((a) => ({ date: a.date, status: a.status })),
          onlineTests: testAttempts.map((t) => ({
            id: t.id,
            testTitle: t.release.test.title,
            moduleTitle: t.release.test.module.title,
            status: t.status,
            score: t.score,
            totalMarks: t.totalMarks,
            submittedAt: t.submittedAt,
          })),
          projects: projectSubmissions.map((s) => ({
            id: s.id,
            projectTitle: s.release.project.title,
            moduleTitle: s.release.project.module.title,
            status: s.status,
            submittedAt: s.submittedAt,
            graded: s.grade !== null,
            grade: s.grade,
            maxGrade: s.maxGrade,
            reviewNote: s.reviewNote,
            fileUrl: s.fileUrl,
            linkUrl: s.linkUrl,
          })),
          moduleFeedback: moduleFeedback.map((f) => ({
            id: f.id,
            moduleTitle: f.module.title,
            rating: f.rating,
            comments: f.comments,
            trainerName: f.trainer ? `${f.trainer.firstName} ${f.trainer.lastName}` : null,
            updatedAt: f.updatedAt,
          })),
        });
      }

      // ── Placement (surfaced only once the student has been pushed in; harmless empty-state otherwise) ──
      const [portfolio, softskillAttendance, driveCandidacies, interviews, placementResults] = await Promise.all([
        prisma.studentPortfolio.findFirst({ where: { studentId }, select: { status: true, publicSlug: true } }),
        prisma.softskillAttendance.findMany({
          where: { studentId },
          include: { session: { select: { type: true, topic: true, sessionDate: true } } },
          orderBy: { sessionId: 'asc' },
        }),
        prisma.placementDriveCandidate.findMany({
          where: { studentId },
          include: { drive: { include: { partner: { select: { name: true } } } } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.placementInterview.findMany({
          where: { studentId },
          include: {
            drive: { include: { partner: { select: { name: true } } } },
            feedbackGivenBy: { select: { firstName: true, lastName: true } },
          },
          orderBy: { scheduledAt: 'desc' },
        }),
        prisma.placementResult.findMany({
          where: { studentId },
          include: { drive: { include: { partner: { select: { name: true } } } } },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      const capstoneSubmissions = await prisma.projectSubmission.findMany({
        where: { studentId, release: { project: { isCapstone: true } } },
        select: { status: true, release: { select: { project: { select: { title: true } } } } },
      });

      const placementMissing: string[] = [];
      if (capstoneSubmissions.length === 0) {
        placementMissing.push('Capstone project not yet assigned/submitted');
      } else if (capstoneSubmissions.some((s) => s.status !== 'REVIEWED')) {
        placementMissing.push('Capstone project awaiting trainer review');
      }
      if (!portfolio) placementMissing.push('Portfolio not yet submitted');
      else if (portfolio.status !== 'APPROVED') placementMissing.push(portfolio.status === 'PENDING' ? 'Portfolio awaiting approval' : 'Portfolio rejected — needs resubmission');

      res.json({
        success: true,
        data: {
          student,
          certificates: certificates.map((c) => ({ id: c.id, certificateNo: c.certificateNo, courseName: c.course.name, issuedAt: c.issuedAt })),
          schedules: data,
          placement: {
            movedToPlacementAt: student.movedToPlacementAt ?? null,
            readiness: { ready: placementMissing.length === 0, missing: placementMissing },
            portfolio: portfolio ? { status: portfolio.status, publicSlug: portfolio.publicSlug } : null,
            softskillAttendance: softskillAttendance.map((a) => ({
              id: a.id, type: a.session.type, topic: a.session.topic, sessionDate: a.session.sessionDate,
              present: a.present, score: a.score,
            })),
            driveCandidacies: driveCandidacies.map((c) => ({
              id: c.id, status: c.status, partnerName: c.drive.partner.name, role: c.drive.role, driveDate: c.drive.driveDate,
            })),
            interviews: interviews.map((iv) => ({
              id: iv.id, companyName: iv.companyName || iv.drive?.partner.name || null, round: iv.round,
              scheduledAt: iv.scheduledAt, outcome: iv.outcome, rating: iv.rating, feedback: iv.feedback,
              feedbackGivenBy: iv.feedbackGivenBy ? `${iv.feedbackGivenBy.firstName} ${iv.feedbackGivenBy.lastName}` : null,
            })),
            results: placementResults.map((r) => ({
              id: r.id, partnerName: r.drive?.partner?.name ?? null, result: r.result, package: r.package,
              designation: r.designation, joiningDate: r.joiningDate, offerLetterUrl: r.offerLetterUrl,
            })),
          },
        },
      });
    } catch (err) { next(err); }
  },

  /** Lightweight list for the Reports tab's student picker. */
  async studentList(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { batchId, scheduleId, courseId, track, search } = req.query;
      const where: Record<string, unknown> = {};
      if (track) where.track = String(track);
      if (search) {
        where.OR = [
          { firstName: { contains: String(search) } },
          { lastName: { contains: String(search) } },
          { studentCode: { contains: String(search) } },
        ];
      }
      if (batchId || scheduleId || courseId) {
        const scheduleWhere: Record<string, unknown> = {};
        if (scheduleId) scheduleWhere.id = String(scheduleId);
        if (batchId) scheduleWhere.batchId = String(batchId);
        if (courseId) scheduleWhere.courseId = String(courseId);
        where.enrollments = { some: { schedule: scheduleWhere } };
      }
      const students = await prisma.student.findMany({
        where, select: studentSelect, orderBy: { firstName: 'asc' }, take: 500,
      });
      res.json({ success: true, data: students });
    } catch (err) { next(err); }
  },

  // ── DAILY KRA — cross-trainer read-only view for PM/admin ──────────────────
  // Trainer-initiated writes (create/update/delete) live in trainerPortal.controller.ts,
  // scoped via assertOwnsSchedule, consistent with attendance/marks/module-feedback.
  async listKra(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduleId, batchId, courseId, track, trainerId, from, to } = req.query;
      const where: Record<string, unknown> = {};
      if (scheduleId) {
        where.scheduleId = String(scheduleId);
      } else if (batchId || courseId) {
        const scheduleWhere: Record<string, unknown> = {};
        if (batchId) scheduleWhere.batchId = String(batchId);
        if (courseId) scheduleWhere.courseId = String(courseId);
        const matching = await prisma.batchCourseSchedule.findMany({ where: scheduleWhere, select: { id: true } });
        where.scheduleId = { in: matching.map((s) => s.id) };
      }
      if (track) where.track = String(track);
      if (trainerId) where.trainerId = String(trainerId);
      if (from || to) {
        where.date = {
          ...(from ? { gte: new Date(String(from)) } : {}),
          ...(to ? { lte: new Date(String(to)) } : {}),
        };
      }
      const entries = await prisma.kRAEntry.findMany({
        where,
        include: {
          schedule: { select: { id: true, batch: { select: { code: true } }, course: { select: { name: true } } } },
          module: { select: { id: true, title: true } },
          trainer: { select: employeeSelect },
        },
        orderBy: { date: 'desc' },
      });
      res.json({ success: true, data: entries });
    } catch (err) { next(err); }
  },

  // ── REPORT RECIPIENTS (settings) ────────────────────────────────────────────
  async listRecipients(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { type } = req.query;
      const recipients = await prisma.reportRecipient.findMany({
        where: type ? { type: String(type) as never } : undefined,
        orderBy: { createdAt: 'asc' },
      });
      res.json({ success: true, data: recipients });
    } catch (err) { next(err); }
  },

  async addRecipient(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { type, email, name } = req.body;
      if (!type || !email) throw new AppError('type and email are required', 400);
      const recipient = await prisma.reportRecipient.upsert({
        where: { type_email: { type, email: String(email).toLowerCase() } },
        update: { name },
        create: { type, email: String(email).toLowerCase(), name },
      });
      res.status(201).json({ success: true, data: recipient });
    } catch (err) { next(err); }
  },

  async removeRecipient(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.reportRecipient.delete({ where: { id: req.params.id } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};
