import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { computeGamification } from '../services/gamification.service';

/** Every handler needs a real studentId before touching Prisma — a User with no
 * linked Student record (orphaned account, stale token) must get a clean 403,
 * not a Prisma validation crash from `studentId: undefined` in a where clause. */
function getStudentId(req: AuthRequest): string {
  const studentId = req.user?.studentId;
  if (!studentId) throw new AppError('No student profile is linked to this account', 403);
  return studentId;
}

/**
 * Self-service portal for STUDENT-role users. Every handler scopes to
 * req.user.studentId — students can only ever see their own records.
 *
 * IMPORTANT: TrainerFeedback is never queried or returned here — it's
 * internal-only per product decision (rating, placement-readiness notes,
 * certificate eligibility opinion are for staff, not the student).
 */
export const studentPortalController = {
  async me(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const student = await prisma.student.findUnique({
        where: { id: getStudentId(req) },
        select: {
          id: true, studentCode: true, firstName: true, lastName: true, email: true, phone: true,
          photo: true, track: true, status: true, joiningDate: true,
          dateOfBirth: true, gender: true, address: true, city: true, state: true, pincode: true,
          emergencyContactName: true, emergencyContactPhone: true, education: true,
          aadharNumber: true, aadharPhoto: true, fatherName: true, fatherPhone: true, motherName: true, motherPhone: true,
          profileCompletedAt: true,
          user: { select: { email: true, mustChangePassword: true } },
        },
      });
      if (!student) throw new AppError('Student record not found', 404);
      res.json({ success: true, data: student });
    } catch (err) { next(err); }
  },

  /** Profile / MIS completion — personal, address, emergency contact, education. */
  async updateMe(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const {
        dateOfBirth, gender, address, city, state, pincode,
        emergencyContactName, emergencyContactPhone, education,
        firstName, lastName, phone,
        aadharNumber, fatherName, fatherPhone, motherName, motherPhone,
      } = req.body;

      if (aadharNumber && !/^\d{12}$/.test(String(aadharNumber).replace(/\s/g, ''))) {
        throw new AppError('Aadhar number must be 12 digits', 400);
      }

      const existing = await prisma.student.findUnique({ where: { id: getStudentId(req) } });
      if (!existing) throw new AppError('Student record not found', 404);

      // Mark the MIS complete the first time the student saves their profile.
      const completingNow = !existing.profileCompletedAt;

      const student = await prisma.student.update({
        where: { id: getStudentId(req) },
        data: {
          firstName, lastName, phone,
          dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
          gender, address, city, state, pincode,
          emergencyContactName, emergencyContactPhone,
          education: education ?? undefined,
          aadharNumber: aadharNumber ? String(aadharNumber).replace(/\s/g, '') : undefined,
          fatherName, fatherPhone, motherName, motherPhone,
          profileCompletedAt: completingNow ? new Date() : undefined,
        },
      });
      res.json({ success: true, data: student });
    } catch (err) { next(err); }
  },

  /** Profile photo — used on certificates, so callers should be told to upload a clear, professional headshot. */
  async uploadPhoto(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const file = req.file as Express.Multer.File | undefined;
      if (!file) throw new AppError('No photo file received', 400);
      const photoUrl = `/uploads/student-photos/${file.filename}`;
      const student = await prisma.student.update({
        where: { id: getStudentId(req) },
        data: { photo: photoUrl },
      });
      res.json({ success: true, data: { photo: student.photo } });
    } catch (err) { next(err); }
  },

  /** Aadhar card photo/scan — a KYC document, distinct from the certificate `photo`. */
  async uploadAadharPhoto(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const file = req.file as Express.Multer.File | undefined;
      if (!file) throw new AppError('No Aadhar photo file received', 400);
      const aadharPhotoUrl = `/uploads/student-aadhar/${file.filename}`;
      const student = await prisma.student.update({
        where: { id: getStudentId(req) },
        data: { aadharPhoto: aadharPhotoUrl },
      });
      res.json({ success: true, data: { aadharPhoto: student.aadharPhoto } });
    } catch (err) { next(err); }
  },

  async myEnrollments(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { studentId: getStudentId(req) },
        include: {
          schedule: {
            include: {
              course: { select: { id: true, name: true, totalHours: true } },
              batch: { select: { id: true, code: true, startDate: true, endDate: true, status: true } },
              trainers: { include: { trainer: { select: { id: true, firstName: true, lastName: true } } } },
            },
          },
        },
        orderBy: { enrolledAt: 'desc' },
      });
      res.json({ success: true, data: enrollments });
    } catch (err) { next(err); }
  },

  async myAttendance(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduleId } = req.query;
      const attendances = await prisma.studentAttendance.findMany({
        where: { studentId: getStudentId(req), scheduleId: scheduleId ? String(scheduleId) : undefined },
        include: { schedule: { include: { course: { select: { id: true, name: true } } } } },
        orderBy: { date: 'desc' },
      });
      const total = attendances.length;
      const present = attendances.filter((a) => a.status === 'PRESENT').length;
      const late = attendances.filter((a) => a.status === 'LATE').length;
      res.json({
        success: true,
        data: attendances,
        meta: { total, present, late, absent: total - present - late, percentage: total ? Math.round(((present + late) / total) * 100) : 0 },
      });
    } catch (err) { next(err); }
  },

  /**
   * Every offline/trainer-graded module test for the student's active enrollments,
   * not just the ones already marked — so the "Test" page can show ungraded tests
   * as locked instead of omitting them entirely. `marksObtained`/`remarks` are
   * null until the trainer enters a ModuleMark for this student.
   */
  async myMarks(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = getStudentId(req);
      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { studentId, status: 'ACTIVE' },
        select: { scheduleId: true },
      });
      const scheduleIds = enrollments.map((e) => e.scheduleId);

      const tests = await prisma.moduleTest.findMany({
        where: { scheduleId: { in: scheduleIds } },
        include: {
          module: { select: { id: true, title: true, order: true } },
          schedule: { include: { course: { select: { id: true, name: true } } } },
          marks: { where: { studentId } },
        },
        orderBy: { testDate: 'desc' },
      });

      const data = tests.map((t) => {
        const mark = t.marks[0] || null;
        return {
          id: mark?.id ?? t.id,
          marksObtained: mark?.marksObtained ?? null,
          remarks: mark?.remarks ?? null,
          graded: !!mark,
          test: {
            title: t.title,
            testDate: t.testDate,
            maxMarks: t.maxMarks,
            module: t.module,
            schedule: { course: t.schedule.course },
          },
        };
      });

      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  async myCertificates(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const certificates = await prisma.certificate.findMany({
        where: { studentId: getStudentId(req) },
        include: { course: { select: { id: true, name: true } } },
        orderBy: { issuedAt: 'desc' },
      });
      res.json({ success: true, data: certificates });
    } catch (err) { next(err); }
  },

  async myPlacements(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const [results, interviews] = await Promise.all([
        prisma.placementResult.findMany({
          where: { studentId: getStudentId(req) },
          include: { drive: { include: { partner: { select: { id: true, name: true, industry: true } } } } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.placementInterview.findMany({
          where: { studentId: getStudentId(req) },
          include: { drive: { include: { partner: { select: { id: true, name: true } } } } },
          orderBy: { scheduledAt: 'desc' },
        }),
      ]);
      res.json({ success: true, data: { results, interviews } });
    } catch (err) { next(err); }
  },

  /** Syllabus/modules for every course the student is enrolled in, with a covered flag from KRAEntry logs. */
  async courseContent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { studentId: getStudentId(req) },
        include: {
          schedule: {
            include: {
              course: {
                include: {
                  modules: { orderBy: { order: 'asc' } },
                  // Full material list from day one — never gated by class progress
                  materials: {
                    select: { id: true, moduleId: true, title: true, type: true, url: true, notes: true, createdAt: true },
                    orderBy: { createdAt: 'asc' },
                  },
                },
              },
              kraEntries: { select: { moduleId: true } },
            },
          },
        },
      });

      const data = enrollments.map((e) => {
        const coveredModuleIds = new Set(e.schedule.kraEntries.map((k) => k.moduleId).filter(Boolean));
        const materials = e.schedule.course.materials;
        return {
          scheduleId: e.scheduleId,
          courseId: e.schedule.course.id,
          courseName: e.schedule.course.name,
          // General (course-wide) materials are visible from enrollment
          generalMaterials: materials.filter((m) => !m.moduleId),
          modules: e.schedule.course.modules.map((m) => {
            const covered = coveredModuleIds.has(m.id);
            const moduleMaterials = materials.filter((mat) => mat.moduleId === m.id);
            return {
              id: m.id, order: m.order, title: m.title, hours: m.hours, dayRange: m.dayRange, topics: m.topics,
              covered,
              // Module materials UNLOCK only once the trainer has covered the module.
              // Uncovered modules expose only a locked count — never the files/links.
              materials: covered ? moduleMaterials : [],
              lockedMaterialsCount: covered ? 0 : moduleMaterials.length,
            };
          }),
        };
      });
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /** Attendance streak + auto-badges — computed live by the gamification service. */
  async gamification(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const data = await computeGamification(getStudentId(req));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /** Per-schedule rank among classmates, based on ModuleMark totals. No raw classmate data is exposed — only the computed rank/average. */
  async rankCard(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = getStudentId(req);
      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { studentId },
        include: { schedule: { include: { course: { select: { id: true, name: true } } } } },
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

        // My project submissions (with trainer grade, once graded) for this schedule.
        const projectSubmissions = await prisma.projectSubmission.findMany({
          where: { studentId, release: { scheduleId } },
          include: {
            release: { include: { project: { select: { title: true, module: { select: { title: true } } } } } },
          },
          orderBy: { submittedAt: 'desc' },
        });

        // Trainer's module-wise feedback for this schedule.
        const moduleFeedback = await prisma.moduleFeedback.findMany({
          where: { studentId, scheduleId },
          include: { module: { select: { title: true, order: true } }, trainer: { select: { firstName: true, lastName: true } } },
          orderBy: { updatedAt: 'desc' },
        });

        data.push({
          scheduleId,
          courseId: e.schedule.course.id,
          courseName: e.schedule.course.name,
          rank: myIndex === -1 ? null : myIndex + 1,
          totalStudents: ranked.length,
          marksObtained: myTotals.obtained,
          marksMax: myTotals.max,
          percentage: Math.round((myTotals.max ? (myTotals.obtained / myTotals.max) * 100 : 0) * 10) / 10,
          classAverage: Math.round(classAverage * 10) / 10,
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
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /** Student-authored feedback on a course/trainer — distinct from staff-only TrainerFeedback. */
  async listFeedback(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const feedback = await prisma.courseFeedback.findMany({
        where: { studentId: getStudentId(req) },
        include: { course: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: feedback });
    } catch (err) { next(err); }
  },

  async submitFeedback(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduleId, courseId, trainerRating, contentRating, comments } = req.body;
      if (!scheduleId || !courseId) throw new AppError('scheduleId and courseId are required', 400);

      const enrolled = await prisma.studentBatchEnrollment.findUnique({
        where: { studentId_scheduleId: { studentId: getStudentId(req), scheduleId } },
      });
      if (!enrolled) throw new AppError('You are not enrolled in this schedule', 403);

      const feedback = await prisma.courseFeedback.upsert({
        where: { studentId_scheduleId: { studentId: getStudentId(req), scheduleId } },
        update: { trainerRating, contentRating, comments },
        create: { studentId: getStudentId(req), scheduleId, courseId, trainerRating, contentRating, comments },
      });
      res.json({ success: true, data: feedback });
    } catch (err) { next(err); }
  },

  /** "Refer a friend" — a student-sourced lead, kept separate from the CRM Lead pipeline. */
  async listReferrals(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const referrals = await prisma.referral.findMany({
        where: { studentId: getStudentId(req) },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: referrals });
    } catch (err) { next(err); }
  },

  async createReferral(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, phone, email, courseInterest } = req.body;
      if (!name || !phone) throw new AppError('name and phone are required', 400);
      const referral = await prisma.referral.create({
        data: { studentId: getStudentId(req), name, phone, email, courseInterest },
      });
      res.status(201).json({ success: true, data: referral });
    } catch (err) { next(err); }
  },

  // ── PROJECTS ───────────────────────────────────────────────────────────────

  /** Projects released to any schedule I'm enrolled in, with my own submission (if any) attached. */
  async myProjects(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = getStudentId(req);
      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { studentId, status: 'ACTIVE' },
        select: { scheduleId: true },
      });
      const scheduleIds = enrollments.map((e) => e.scheduleId);

      const releases = await prisma.projectRelease.findMany({
        where: { scheduleId: { in: scheduleIds } },
        include: {
          project: { include: { module: { select: { id: true, title: true, order: true } } } },
          submissions: { where: { studentId } },
        },
        orderBy: { releasedAt: 'desc' },
      });

      const data = releases.map((r) => ({
        releaseId: r.id,
        status: r.status,
        releasedAt: r.releasedAt,
        project: r.project,
        mySubmission: r.submissions[0] ?? null,
      }));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /** Submit work for a released project — either a file upload or a link, plus an optional note. */
  async submitProject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = getStudentId(req);
      const { releaseId } = req.params;
      const { linkUrl, note } = req.body;
      const file = req.file as Express.Multer.File | undefined;

      const release = await prisma.projectRelease.findUnique({ where: { id: releaseId } });
      if (!release) throw new AppError('Project release not found', 404);
      if (release.status !== 'ACTIVE') throw new AppError('This project is no longer accepting submissions', 400);

      const enrolled = await prisma.studentBatchEnrollment.findUnique({
        where: { studentId_scheduleId: { studentId, scheduleId: release.scheduleId } },
      });
      if (!enrolled) throw new AppError('You are not enrolled in this schedule', 403);

      if (!file && !linkUrl) throw new AppError('A file or a link is required to submit', 400);

      const submission = await prisma.projectSubmission.upsert({
        where: { releaseId_studentId: { releaseId, studentId } },
        update: {
          fileUrl: file ? `/uploads/project-submissions/${file.filename}` : undefined,
          linkUrl: linkUrl ?? undefined,
          note: note ?? undefined,
          status: 'SUBMITTED',
          submittedAt: new Date(),
        },
        create: {
          releaseId,
          studentId,
          fileUrl: file ? `/uploads/project-submissions/${file.filename}` : undefined,
          linkUrl: linkUrl ?? undefined,
          note: note ?? undefined,
        },
      });
      res.status(201).json({ success: true, data: submission });
    } catch (err) { next(err); }
  },

  // ── FEEDBACK FORMS ─────────────────────────────────────────────────────────

  /** Feedback forms released to any schedule I'm enrolled in, with whether I've already responded. */
  async myFeedbackForms(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = getStudentId(req);
      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { studentId, status: 'ACTIVE' },
        select: { scheduleId: true },
      });
      const scheduleIds = enrollments.map((e) => e.scheduleId);

      const releases = await prisma.feedbackFormRelease.findMany({
        where: { scheduleId: { in: scheduleIds } },
        include: {
          form: { include: { module: { select: { id: true, title: true, order: true } }, questions: { orderBy: { order: 'asc' } } } },
          responses: { where: { studentId } },
        },
        orderBy: { releasedAt: 'desc' },
      });

      const data = releases.map((r) => ({
        releaseId: r.id,
        status: r.status,
        releasedAt: r.releasedAt,
        form: r.form,
        alreadyResponded: r.responses.length > 0,
      }));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /** Submit answers for a released feedback form. Body: { answers: [{ questionId, ratingValue?, textValue?, optionValue? }] } */
  async submitFeedbackForm(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = getStudentId(req);
      const { releaseId } = req.params;
      const { answers } = req.body as { answers: Array<{ questionId: string; ratingValue?: number; textValue?: string; optionValue?: string }> };

      const release = await prisma.feedbackFormRelease.findUnique({
        where: { id: releaseId },
        include: { form: { include: { questions: true } } },
      });
      if (!release) throw new AppError('Feedback form release not found', 404);
      if (release.status !== 'ACTIVE') throw new AppError('This feedback form is no longer accepting responses', 400);

      const enrolled = await prisma.studentBatchEnrollment.findUnique({
        where: { studentId_scheduleId: { studentId, scheduleId: release.scheduleId } },
      });
      if (!enrolled) throw new AppError('You are not enrolled in this schedule', 403);

      const existing = await prisma.feedbackFormResponse.findUnique({
        where: { releaseId_studentId: { releaseId, studentId } },
      });
      if (existing) throw new AppError('You have already submitted this feedback form', 409);

      if (!Array.isArray(answers)) throw new AppError('answers array is required', 400);
      const questionsById = new Map(release.form.questions.map((q) => [q.id, q]));
      for (const q of release.form.questions) {
        if (q.required && !answers.some((a) => a.questionId === q.id)) {
          throw new AppError(`Question "${q.prompt}" is required`, 400);
        }
      }
      for (const a of answers) {
        if (!questionsById.has(a.questionId)) throw new AppError('Unknown questionId in answers', 400);
      }

      const response = await prisma.$transaction(async (tx) => {
        const created = await tx.feedbackFormResponse.create({ data: { releaseId, studentId } });
        await tx.feedbackAnswer.createMany({
          data: answers.map((a) => ({
            responseId: created.id,
            questionId: a.questionId,
            ratingValue: a.ratingValue ?? undefined,
            textValue: a.textValue ?? undefined,
            optionValue: a.optionValue ?? undefined,
          })),
        });
        return created;
      });
      res.status(201).json({ success: true, data: response });
    } catch (err) { next(err); }
  },

  // ── ONLINE TESTS ───────────────────────────────────────────────────────────

  /** Online tests activated for any schedule I'm enrolled in, with my own attempt status (if started). */
  async myOnlineTests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = getStudentId(req);
      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { studentId, status: 'ACTIVE' },
        select: { scheduleId: true },
      });
      const scheduleIds = enrollments.map((e) => e.scheduleId);

      const releases = await prisma.onlineTestRelease.findMany({
        where: { scheduleId: { in: scheduleIds } },
        include: {
          test: { include: { module: { select: { id: true, title: true, order: true } }, _count: { select: { questions: true } } } },
          attempts: { where: { studentId } },
        },
        orderBy: { activatedAt: 'desc' },
      });

      const data = releases.map((r) => ({
        releaseId: r.id,
        status: r.status,
        activatedAt: r.activatedAt,
        test: { id: r.test.id, title: r.test.title, durationMinutes: r.test.durationMinutes, module: r.test.module, questionCount: r.test._count.questions },
        myAttempt: r.attempts[0]
          ? { id: r.attempts[0].id, status: r.attempts[0].status, startedAt: r.attempts[0].startedAt, deadlineAt: r.attempts[0].deadlineAt, score: r.attempts[0].score, totalMarks: r.attempts[0].totalMarks }
          : null,
      }));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  /** Start (or resume) my attempt for an activated test. Deadline is computed server-side, once, at first start. */
  async startOnlineTestAttempt(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = getStudentId(req);
      const { releaseId } = req.params;

      const release = await prisma.onlineTestRelease.findUnique({
        where: { id: releaseId },
        include: { test: { include: { questions: { orderBy: { order: 'asc' } } } } },
      });
      if (!release) throw new AppError('Test release not found', 404);
      if (release.status !== 'ACTIVE') throw new AppError('This test is not currently active', 400);

      const enrolled = await prisma.studentBatchEnrollment.findUnique({
        where: { studentId_scheduleId: { studentId, scheduleId: release.scheduleId } },
      });
      if (!enrolled) throw new AppError('You are not enrolled in this schedule', 403);

      let attempt = await prisma.onlineTestAttempt.findUnique({ where: { releaseId_studentId: { releaseId, studentId } } });
      if (!attempt) {
        const deadlineAt = new Date(Date.now() + release.test.durationMinutes * 60 * 1000);
        attempt = await prisma.onlineTestAttempt.create({ data: { releaseId, studentId, deadlineAt } });
      } else if (attempt.status !== 'IN_PROGRESS') {
        throw new AppError('You have already completed this test', 409);
      }

      const questions = release.test.questions.map((q) => ({ id: q.id, order: q.order, prompt: q.prompt, options: q.options, marks: q.marks }));
      res.status(201).json({ success: true, data: { attempt, questions } });
    } catch (err) { next(err); }
  },

  /** Resume/poll an in-progress attempt — used by the timer UI; never returns correctIndex. */
  async getOnlineTestAttempt(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = getStudentId(req);
      const { attemptId } = req.params;

      const attempt = await prisma.onlineTestAttempt.findUnique({
        where: { id: attemptId },
        include: {
          release: { include: { test: { include: { questions: { orderBy: { order: 'asc' } } } } } },
          answers: true,
        },
      });
      if (!attempt || attempt.studentId !== studentId) throw new AppError('Attempt not found', 404);

      // Auto-expire if the timer has run out but the attempt is still open.
      if (attempt.status === 'IN_PROGRESS' && attempt.deadlineAt.getTime() <= Date.now()) {
        await gradeAndCloseAttempt(attempt.id, 'EXPIRED');
        const refreshed = await prisma.onlineTestAttempt.findUnique({ where: { id: attemptId } });
        return res.json({ success: true, data: { attempt: refreshed, questions: [], answers: [] } });
      }

      const questions = attempt.release.test.questions.map((q) => ({ id: q.id, order: q.order, prompt: q.prompt, options: q.options, marks: q.marks }));
      const answers = attempt.answers.map((a) => ({ questionId: a.questionId, selectedIndex: a.selectedIndex }));
      res.json({ success: true, data: { attempt, questions, answers } });
    } catch (err) { next(err); }
  },

  /** Save/update one answer while the attempt is in progress. Body: { questionId, selectedIndex } */
  async saveOnlineTestAnswer(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = getStudentId(req);
      const { attemptId } = req.params;
      const { questionId, selectedIndex } = req.body;
      if (!questionId || selectedIndex === undefined || selectedIndex === null) {
        throw new AppError('questionId and selectedIndex are required', 400);
      }

      const attempt = await prisma.onlineTestAttempt.findUnique({ where: { id: attemptId } });
      if (!attempt || attempt.studentId !== studentId) throw new AppError('Attempt not found', 404);
      if (attempt.status !== 'IN_PROGRESS') throw new AppError('This attempt is no longer in progress', 400);
      if (attempt.deadlineAt.getTime() <= Date.now()) {
        await gradeAndCloseAttempt(attempt.id, 'EXPIRED');
        throw new AppError('Time is up — this attempt has been submitted automatically', 400);
      }

      const answer = await prisma.onlineTestAnswer.upsert({
        where: { attemptId_questionId: { attemptId, questionId } },
        update: { selectedIndex },
        create: { attemptId, questionId, selectedIndex },
      });
      res.json({ success: true, data: answer });
    } catch (err) { next(err); }
  },

  /**
   * Submit (finish) my attempt and reveal the score immediately, per product
   * decision. Body: { violation?: boolean } — set by the frontend the instant
   * a tab-switch/blur is detected during an active attempt, which forces an
   * AUTO_SUBMITTED_VIOLATION outcome (strictest policy, confirmed by product).
   */
  async submitOnlineTestAttempt(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = getStudentId(req);
      const { attemptId } = req.params;
      const { violation } = req.body as { violation?: boolean };

      const attempt = await prisma.onlineTestAttempt.findUnique({ where: { id: attemptId } });
      if (!attempt || attempt.studentId !== studentId) throw new AppError('Attempt not found', 404);
      if (attempt.status !== 'IN_PROGRESS') {
        const already = await prisma.onlineTestAttempt.findUnique({ where: { id: attemptId } });
        return res.json({ success: true, data: already });
      }

      const expired = attempt.deadlineAt.getTime() <= Date.now();
      const finalStatus = violation ? 'AUTO_SUBMITTED_VIOLATION' : expired ? 'EXPIRED' : 'SUBMITTED';
      const graded = await gradeAndCloseAttempt(attemptId, finalStatus);
      res.json({ success: true, data: graded });
    } catch (err) { next(err); }
  },

  /** My portfolio submission (education/skills/projects/experience) + its review status. */
  async getPortfolio(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const portfolio = await prisma.studentPortfolio.findUnique({
        where: { studentId: getStudentId(req) },
        include: { reviewedBy: { select: { firstName: true, lastName: true } } },
      });
      res.json({ success: true, data: portfolio });
    } catch (err) { next(err); }
  },

  /**
   * Create or update my portfolio submission. Every save (re)submits for review —
   * status is reset to PENDING and any prior approval (publicSlug, reviewedBy) is
   * cleared, since the approved content no longer matches what's on the public page.
   */
  async submitPortfolio(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = getStudentId(req);
      const { summary, education, skills, projects, experience } = req.body;

      const portfolio = await prisma.studentPortfolio.upsert({
        where: { studentId },
        update: {
          summary, education, skills, projects, experience,
          status: 'PENDING',
          submittedAt: new Date(),
          reviewedById: null,
          reviewedAt: null,
          reviewNote: null,
          publicSlug: null,
        },
        create: {
          studentId, summary, education, skills, projects, experience,
          status: 'PENDING',
          submittedAt: new Date(),
        },
      });
      res.json({ success: true, data: portfolio });
    } catch (err) { next(err); }
  },
};

/** Grades every answer for an attempt against OnlineTestQuestion.correctIndex, sets score/totalMarks/status. */
async function gradeAndCloseAttempt(
  attemptId: string,
  status: 'SUBMITTED' | 'AUTO_SUBMITTED_VIOLATION' | 'EXPIRED'
) {
  const attempt = await prisma.onlineTestAttempt.findUnique({
    where: { id: attemptId },
    include: { release: { include: { test: { include: { questions: true } } } }, answers: true },
  });
  if (!attempt) throw new AppError('Attempt not found', 404);
  if (attempt.status !== 'IN_PROGRESS') return attempt;

  const questionsById = new Map(attempt.release.test.questions.map((q) => [q.id, q]));
  let score = 0;
  const totalMarks = attempt.release.test.questions.reduce((sum, q) => sum + q.marks, 0);

  await prisma.$transaction(async (tx) => {
    for (const a of attempt.answers) {
      const q = questionsById.get(a.questionId);
      if (!q) continue;
      const isCorrect = a.selectedIndex !== null && a.selectedIndex === q.correctIndex;
      if (isCorrect) score += q.marks;
      await tx.onlineTestAnswer.update({ where: { id: a.id }, data: { isCorrect } });
    }
    await tx.onlineTestAttempt.update({
      where: { id: attemptId },
      data: { status, submittedAt: new Date(), score, totalMarks },
    });
  });

  return prisma.onlineTestAttempt.findUnique({ where: { id: attemptId } });
}
