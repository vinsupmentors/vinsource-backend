import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { notificationService } from '../services/notification.service';
import { emailService } from '../services/email.service';

/**
 * "My Training" self-service surface for any logged-in Employee who has
 * TrainerAssignment rows. No module-access gate — every handler scopes to
 * the caller's own employeeId and verifies ownership of the schedule/test
 * before allowing reads or writes, since this sits outside the
 * department/designation-driven module-access system entirely.
 */

async function assertOwnsSchedule(employeeId: string | undefined, scheduleId: string) {
  if (!employeeId) throw new AppError('No trainer profile is linked to this account', 403);
  const assignment = await prisma.trainerAssignment.findUnique({
    where: { scheduleId_trainerId: { scheduleId, trainerId: employeeId } },
  });
  if (!assignment) throw new AppError('You are not assigned as a trainer for this sub-batch', 403);
}

function formatDeadline(deadline: Date | string | null | undefined): string | null {
  if (!deadline) return null;
  return new Date(deadline).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/**
 * Staff who should be cc'd on release-notification emails for a schedule:
 * every employee with effective EDIT access on PRODUCTION_TRAINING (i.e. the
 * Production Manager(s)) plus the trainer(s) assigned to this schedule.
 * Dedupes by email so a PM who is also the trainer only gets one copy.
 */
async function getStaffRecipients(scheduleId: string): Promise<{ name: string; email: string }[]> {
  const [managerGrants, trainerAssignments] = await Promise.all([
    prisma.userModuleAccess.findMany({
      where: { module: 'PRODUCTION_TRAINING', accessLevel: 'EDIT' },
      include: { user: { include: { employee: true } } },
    }),
    prisma.trainerAssignment.findMany({
      where: { scheduleId },
      include: { trainer: true },
    }),
  ]);

  const recipients = new Map<string, { name: string; email: string }>();
  for (const g of managerGrants) {
    const emp = g.user.employee;
    const email = emp?.email || g.user.email;
    if (email) recipients.set(email, { name: emp ? `${emp.firstName} ${emp.lastName}` : g.user.email, email });
  }
  for (const a of trainerAssignments) {
    if (a.trainer.email) {
      recipients.set(a.trainer.email, { name: `${a.trainer.firstName} ${a.trainer.lastName}`, email: a.trainer.email });
    }
  }
  return Array.from(recipients.values());
}

export const trainerPortalController = {
  /** Schedules (sub-batches) the caller is assigned to train. */
  async mySchedules(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId;
      if (!employeeId) return res.json({ success: true, data: [], meta: { employeeId: null, reason: 'no employeeId on token' } });
      const assignments = await prisma.trainerAssignment.findMany({
        where: { trainerId: employeeId },
        include: {
          schedule: {
            select: {
              id: true,
              code: true,
              timing: true,
              course: { select: { id: true, name: true, modules: { orderBy: { order: 'asc' } } } },
              batch: { select: { id: true, code: true, startDate: true, endDate: true, status: true } },
              _count: { select: { enrollments: true } },
            },
          },
        },
        orderBy: { assignedAt: 'desc' },
      });
      // TEMP DEBUG: remove `meta` once trainer-assignment visibility is confirmed working.
      res.json({ success: true, data: assignments, meta: { employeeId } });
    } catch (err) { next(err); }
  },

  /** Students enrolled in one of my assigned schedules. */
  async scheduleStudents(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      await assertOwnsSchedule(employeeId, scheduleId);

      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { scheduleId },
        include: {
          student: {
            select: { id: true, studentCode: true, firstName: true, lastName: true, email: true, phone: true, track: true, status: true, photo: true },
          },
        },
        orderBy: { enrolledAt: 'asc' },
      });
      res.json({ success: true, data: enrollments });
    } catch (err) { next(err); }
  },

  /** Attendance for one schedule + date — all enrolled students with their marked status (if any). */
  async getAttendance(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      const { date } = req.query;
      await assertOwnsSchedule(employeeId, scheduleId);
      if (!date) throw new AppError('date query param is required (YYYY-MM-DD)', 400);

      const day = new Date(String(date));
      const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());

      const [enrollments, marked] = await Promise.all([
        prisma.studentBatchEnrollment.findMany({
          where: { scheduleId, status: 'ACTIVE' },
          include: { student: { select: { id: true, studentCode: true, firstName: true, lastName: true } } },
          orderBy: { enrolledAt: 'asc' },
        }),
        prisma.studentAttendance.findMany({ where: { scheduleId, date: dayStart } }),
      ]);
      const byStudent = new Map(marked.map((m) => [m.studentId, m]));
      const roster = enrollments.map((e) => ({
        student: e.student,
        status: byStudent.get(e.studentId)?.status ?? null,
        attendanceId: byStudent.get(e.studentId)?.id ?? null,
      }));
      res.json({ success: true, data: roster });
    } catch (err) { next(err); }
  },

  /** Bulk mark/update attendance for a schedule + date. Body: { date, records: [{ studentId, status }] } */
  async markAttendance(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      const { date, records } = req.body;
      await assertOwnsSchedule(employeeId, scheduleId);
      if (!date || !Array.isArray(records) || !records.length) {
        throw new AppError('date and a non-empty records array are required', 400);
      }
      const day = new Date(String(date));
      const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());

      const results = await Promise.all(
        records.map((r: { studentId: string; status: 'PRESENT' | 'ABSENT' | 'LATE' }) =>
          prisma.studentAttendance.upsert({
            where: { studentId_scheduleId_date: { studentId: r.studentId, scheduleId, date: dayStart } },
            update: { status: r.status, markedById: employeeId },
            create: { studentId: r.studentId, scheduleId, date: dayStart, status: r.status, markedById: employeeId },
          })
        )
      );

      // Student lifecycle: the moment attendance is first marked for a
      // student, they move out of ENROLLED/ONBOARDED into ACTIVE. Once a
      // student is ACTIVE (or beyond), this is a no-op — the ACTIVE↔INACTIVE
      // toggle from here on is owned exclusively by the daily attendance-%
      // sync cron, not by individual attendance marks.
      const studentIds = records.map((r: { studentId: string }) => r.studentId);
      if (studentIds.length) {
        await prisma.student.updateMany({
          where: { id: { in: studentIds }, status: { in: ['ENROLLED', 'ONBOARDED'] } },
          data: { status: 'ACTIVE' },
        });
      }

      res.json({ success: true, data: results });
    } catch (err) { next(err); }
  },

  /** Tests for one of my assigned schedules. */
  async listTests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      await assertOwnsSchedule(employeeId, scheduleId);
      const tests = await prisma.moduleTest.findMany({
        where: { scheduleId },
        include: { module: { select: { id: true, title: true, order: true } }, _count: { select: { marks: true } } },
        orderBy: { testDate: 'desc' },
      });
      res.json({ success: true, data: tests });
    } catch (err) { next(err); }
  },

  /** Create a test for one of my modules. Body: { scheduleId, moduleId, title, testDate, maxMarks } */
  async createTest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId, moduleId, title, testDate, maxMarks } = req.body;
      if (!scheduleId || !moduleId || !title || !testDate) {
        throw new AppError('scheduleId, moduleId, title, and testDate are required', 400);
      }
      await assertOwnsSchedule(employeeId, scheduleId);
      const test = await prisma.moduleTest.create({
        data: { scheduleId, moduleId, title, testDate: new Date(testDate), maxMarks: maxMarks || undefined },
      });
      res.status(201).json({ success: true, data: test });
    } catch (err) { next(err); }
  },

  /** Marks for one test, joined with the enrolled roster so ungraded students show up too. */
  async testMarks(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { testId } = req.params;
      const test = await prisma.moduleTest.findUnique({ where: { id: testId } });
      if (!test) throw new AppError('Test not found', 404);
      await assertOwnsSchedule(employeeId, test.scheduleId);

      const [enrollments, marks] = await Promise.all([
        prisma.studentBatchEnrollment.findMany({
          where: { scheduleId: test.scheduleId, status: 'ACTIVE' },
          include: { student: { select: { id: true, studentCode: true, firstName: true, lastName: true } } },
        }),
        prisma.moduleMark.findMany({ where: { testId } }),
      ]);
      const byStudent = new Map(marks.map((m) => [m.studentId, m]));
      const roster = enrollments.map((e) => ({
        student: e.student,
        marksObtained: byStudent.get(e.studentId)?.marksObtained ?? null,
        remarks: byStudent.get(e.studentId)?.remarks ?? null,
        markId: byStudent.get(e.studentId)?.id ?? null,
      }));
      res.json({ success: true, data: { test, roster } });
    } catch (err) { next(err); }
  },

  /** Bulk upsert marks for a test. Body: { records: [{ studentId, marksObtained, remarks }] } */
  async upsertMarks(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { testId } = req.params;
      const { records } = req.body;
      const test = await prisma.moduleTest.findUnique({ where: { id: testId } });
      if (!test) throw new AppError('Test not found', 404);
      await assertOwnsSchedule(employeeId, test.scheduleId);
      if (!Array.isArray(records) || !records.length) {
        throw new AppError('A non-empty records array is required', 400);
      }

      const results = await Promise.all(
        records.map((r: { studentId: string; marksObtained: number; remarks?: string }) =>
          prisma.moduleMark.upsert({
            where: { testId_studentId: { testId, studentId: r.studentId } },
            update: { marksObtained: r.marksObtained, remarks: r.remarks },
            create: { testId, studentId: r.studentId, marksObtained: r.marksObtained, remarks: r.remarks },
          })
        )
      );
      res.json({ success: true, data: results });
    } catch (err) { next(err); }
  },

  /** My feedback entries for students in courses I train. */
  async listFeedback(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId;
      if (!employeeId) return res.json({ success: true, data: [] });
      const feedback = await prisma.trainerFeedback.findMany({
        where: { trainerId: employeeId },
        include: {
          student: { select: { id: true, studentCode: true, firstName: true, lastName: true, track: true } },
          course: { select: { id: true, name: true } },
        },
        orderBy: { updatedAt: 'desc' },
      });
      res.json({ success: true, data: feedback });
    } catch (err) { next(err); }
  },

  /** Create/update my feedback for a student+course. Body: { studentId, courseId, performanceRating, placementReadinessNote, jrpToIopRecommended, certificateEligible } */
  async upsertFeedback(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId;
      if (!employeeId) throw new AppError('No trainer profile is linked to this account', 403);
      const { studentId, courseId, performanceRating, placementReadinessNote, jrpToIopRecommended, certificateEligible } = req.body;
      if (!studentId || !courseId) throw new AppError('studentId and courseId are required', 400);

      // Ownership check: I must be assigned as trainer on a schedule for this course
      // that the student is enrolled in.
      const enrollment = await prisma.studentBatchEnrollment.findFirst({
        where: { studentId, schedule: { courseId, trainers: { some: { trainerId: employeeId } } } },
      });
      if (!enrollment) throw new AppError('You are not the assigned trainer for this student in this course', 403);

      const feedback = await prisma.trainerFeedback.upsert({
        where: { studentId_courseId: { studentId, courseId } },
        update: { trainerId: employeeId, performanceRating, placementReadinessNote, jrpToIopRecommended, certificateEligible },
        create: { studentId, courseId, trainerId: employeeId, performanceRating, placementReadinessNote, jrpToIopRecommended, certificateEligible },
      });
      res.json({ success: true, data: feedback });
    } catch (err) { next(err); }
  },

  /** My module-wise feedback entries for one schedule (defaults to all my schedules if scheduleId omitted via query). */
  async listModuleFeedback(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      await assertOwnsSchedule(employeeId, scheduleId);

      const [enrollments, modules, feedback] = await Promise.all([
        prisma.studentBatchEnrollment.findMany({
          where: { scheduleId, status: 'ACTIVE' },
          include: { student: { select: { id: true, studentCode: true, firstName: true, lastName: true } } },
        }),
        prisma.batchCourseSchedule.findUnique({ where: { id: scheduleId } }).then((s) =>
          s ? prisma.academyModule.findMany({ where: { courseId: s.courseId }, orderBy: { order: 'asc' } }) : []
        ),
        prisma.moduleFeedback.findMany({ where: { scheduleId } }),
      ]);

      res.json({ success: true, data: { students: enrollments.map((e) => e.student), modules, feedback } });
    } catch (err) { next(err); }
  },

  /** Create/update my module-wise feedback for a student. Body: { studentId, moduleId, rating?, comments } */
  async upsertModuleFeedback(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      const { studentId, moduleId, rating, comments } = req.body;
      if (!studentId || !moduleId || !comments) throw new AppError('studentId, moduleId, and comments are required', 400);
      await assertOwnsSchedule(employeeId, scheduleId);

      const enrollment = await prisma.studentBatchEnrollment.findUnique({
        where: { studentId_scheduleId: { studentId, scheduleId } },
      });
      if (!enrollment) throw new AppError('This student is not enrolled in this schedule', 400);

      const feedback = await prisma.moduleFeedback.upsert({
        where: { studentId_moduleId_scheduleId: { studentId, moduleId, scheduleId } },
        update: { trainerId: employeeId, rating: rating ?? undefined, comments },
        create: { studentId, moduleId, scheduleId, trainerId: employeeId, rating: rating ?? undefined, comments },
      });

      const enrollmentWithUser = await prisma.studentBatchEnrollment.findUnique({
        where: { studentId_scheduleId: { studentId, scheduleId } },
        include: { student: { select: { userId: true } } },
      });
      if (enrollmentWithUser?.student.userId) {
        await notificationService.bulkCreate([enrollmentWithUser.student.userId], {
          type: 'MODULE_FEEDBACK_GIVEN',
          title: 'New feedback from your trainer',
          message: 'Your trainer has shared module feedback on your Rank Card.',
          data: { moduleId, scheduleId },
        }).catch(() => undefined);
      }

      res.json({ success: true, data: feedback });
    } catch (err) { next(err); }
  },

  // ── DAILY KRA — topics covered, per sub-batch (track), per day ─────────────

  /** My KRA log entries for a schedule. Query: ?track=&from=&to= */
  async listMyKra(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      await assertOwnsSchedule(employeeId, scheduleId);

      const { track, from, to } = req.query as Record<string, string | undefined>;
      const where: Record<string, unknown> = { scheduleId, trainerId: employeeId };
      if (track) where.track = track;
      if (from || to) {
        const range: Record<string, Date> = {};
        if (from) range.gte = new Date(from);
        if (to) range.lte = new Date(to);
        where.date = range;
      }

      const entries = await prisma.kRAEntry.findMany({
        where,
        include: { module: { select: { id: true, title: true, order: true } } },
        orderBy: [{ date: 'desc' }],
      });
      res.json({ success: true, data: entries });
    } catch (err) { next(err); }
  },

  /** Log today's (or any day's) topics covered. Body: { date, track?, moduleId?, topicsCovered, notes? } */
  async createKra(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      const { date, track, moduleId, topicsCovered, notes } = req.body;
      if (!date || !topicsCovered) throw new AppError('date and topicsCovered are required', 400);
      await assertOwnsSchedule(employeeId, scheduleId);

      // Prisma forbids passing `null` for a nullable field inside the compound-unique
      // `where` shorthand (scheduleId_track_date_moduleId), so upsert() can't be used
      // directly when track/moduleId are optional. Do the lookup with a regular filter
      // (which does allow null) and create/update explicitly instead.
      const existing = await prisma.kRAEntry.findFirst({
        where: { scheduleId, track: track ?? null, date: new Date(date), moduleId: moduleId ?? null },
      });
      const entry = existing
        ? await prisma.kRAEntry.update({
            where: { id: existing.id },
            data: { topicsCovered, notes: notes ?? undefined, trainerId: employeeId },
          })
        : await prisma.kRAEntry.create({
            data: {
              scheduleId,
              trainerId: employeeId,
              track: track ?? null,
              moduleId: moduleId ?? null,
              date: new Date(date),
              topicsCovered,
              notes: notes ?? undefined,
            },
          });
      res.json({ success: true, data: entry });
    } catch (err) { next(err); }
  },

  /** Update one of my own KRA entries. Body: { topicsCovered?, notes? } */
  async updateKra(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { id } = req.params;
      const { topicsCovered, notes } = req.body;

      const existing = await prisma.kRAEntry.findUnique({ where: { id } });
      if (!existing) throw new AppError('KRA entry not found', 404);
      await assertOwnsSchedule(employeeId, existing.scheduleId);
      if (existing.trainerId !== employeeId) throw new AppError('You can only edit your own KRA entries', 403);

      const updated = await prisma.kRAEntry.update({
        where: { id },
        data: { topicsCovered: topicsCovered ?? undefined, notes: notes ?? undefined },
      });
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  /** Delete one of my own KRA entries. */
  async deleteKra(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { id } = req.params;

      const existing = await prisma.kRAEntry.findUnique({ where: { id } });
      if (!existing) throw new AppError('KRA entry not found', 404);
      await assertOwnsSchedule(employeeId, existing.scheduleId);
      if (existing.trainerId !== employeeId) throw new AppError('You can only delete your own KRA entries', 403);

      await prisma.kRAEntry.delete({ where: { id } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── PROJECTS / FEEDBACK FORMS / ONLINE TESTS — release & conduct ───────────

  /** PM-authored Projects/FeedbackForms/OnlineTests available to release for this schedule's course. */
  async releasableContent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      await assertOwnsSchedule(employeeId, scheduleId);

      const schedule = await prisma.batchCourseSchedule.findUnique({ where: { id: scheduleId } });
      if (!schedule) throw new AppError('Schedule not found', 404);

      const [projects, feedbackForms, onlineTests] = await Promise.all([
        prisma.project.findMany({
          where: { module: { courseId: schedule.courseId } },
          include: { module: { select: { id: true, title: true, order: true } }, releases: { where: { scheduleId } } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.feedbackForm.findMany({
          where: { module: { courseId: schedule.courseId } },
          include: { module: { select: { id: true, title: true, order: true } }, releases: { where: { scheduleId } } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.onlineTest.findMany({
          where: { module: { courseId: schedule.courseId } },
          include: {
            module: { select: { id: true, title: true, order: true } },
            releases: { where: { scheduleId } },
            _count: { select: { questions: true } },
          },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      res.json({ success: true, data: { projects, feedbackForms, onlineTests } });
    } catch (err) { next(err); }
  },

  /** Release a Project to a schedule — notifies + emails every enrolled student. */
  async releaseProject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      const { projectId, deadline } = req.body;
      if (!projectId) throw new AppError('projectId is required', 400);
      await assertOwnsSchedule(employeeId, scheduleId);

      const project = await prisma.project.findUnique({
        where: { id: projectId },
        include: { module: { select: { title: true, courseId: true } } },
      });
      if (!project) throw new AppError('Project not found', 404);

      const schedule = await prisma.batchCourseSchedule.findUnique({
        where: { id: scheduleId },
        include: { course: { select: { name: true } }, batch: { select: { code: true } } },
      });
      if (!schedule || schedule.courseId !== project.module.courseId) {
        throw new AppError('This project does not belong to this schedule\'s course', 400);
      }

      const deadlineDate = deadline ? new Date(deadline) : null;
      const release = await prisma.projectRelease.upsert({
        where: { projectId_scheduleId: { projectId, scheduleId } },
        update: { status: 'ACTIVE', releasedAt: new Date(), releasedById: employeeId, deadline: deadlineDate },
        create: { projectId, scheduleId, releasedById: employeeId, deadline: deadlineDate },
      });

      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { scheduleId, status: 'ACTIVE' },
        include: { student: { select: { id: true, userId: true, firstName: true, lastName: true, email: true, user: { select: { email: true } } } } },
      });

      await notificationService.bulkCreate(
        enrollments.map((e) => e.student.userId).filter((id): id is string => id !== null),
        {
          type: 'PROJECT_RELEASED',
          title: 'New project released',
          message: `${project.title} has been released for ${schedule.course.name}.`,
          data: { projectId: project.id, releaseId: release.id, scheduleId },
        }
      );

      const deadlineStr = formatDeadline(deadlineDate);

      for (const e of enrollments) {
        const to = e.student.email || e.student.user?.email;
        if (!to) continue;
        emailService
          .send({
            to,
            subject: `New project released: ${project.title}`,
            html: emailService.templates.projectReleased({
              studentName: `${e.student.firstName} ${e.student.lastName}`,
              projectTitle: project.title,
              moduleTitle: project.module.title,
              courseName: schedule.course.name,
              deadline: deadlineStr,
            }),
            template: 'projectReleased',
          })
          .catch(() => undefined); // best-effort; failures are already logged in EmailLog
      }

      const staff = await getStaffRecipients(scheduleId);
      for (const s of staff) {
        emailService
          .send({
            to: s.email,
            subject: `[Production] Project released: ${project.title}`,
            html: emailService.templates.staffReleaseNotice({
              recipientName: s.name,
              kindLabel: 'Project',
              title: project.title,
              courseName: schedule.course.name,
              scheduleLabel: `${schedule.batch.code} · ${schedule.course.name}`,
              deadline: deadlineStr,
              studentCount: enrollments.length,
            }),
            template: 'staffReleaseNotice',
          })
          .catch(() => undefined);
      }

      res.status(201).json({ success: true, data: release });
    } catch (err) { next(err); }
  },

  /** Release a Feedback Form template to a schedule. */
  async releaseFeedbackForm(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      const { formId, deadline } = req.body;
      if (!formId) throw new AppError('formId is required', 400);
      await assertOwnsSchedule(employeeId, scheduleId);

      const form = await prisma.feedbackForm.findUnique({
        where: { id: formId },
        include: { module: { select: { title: true, courseId: true } } },
      });
      if (!form) throw new AppError('Feedback form not found', 404);

      const schedule = await prisma.batchCourseSchedule.findUnique({
        where: { id: scheduleId },
        include: { course: { select: { name: true } }, batch: { select: { code: true } } },
      });
      if (!schedule || schedule.courseId !== form.module.courseId) {
        throw new AppError('This feedback form does not belong to this schedule\'s course', 400);
      }

      const deadlineDate = deadline ? new Date(deadline) : null;
      const release = await prisma.feedbackFormRelease.upsert({
        where: { formId_scheduleId: { formId, scheduleId } },
        update: { status: 'ACTIVE', releasedAt: new Date(), releasedById: employeeId, deadline: deadlineDate },
        create: { formId, scheduleId, releasedById: employeeId, deadline: deadlineDate },
      });

      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { scheduleId, status: 'ACTIVE' },
        include: { student: { select: { id: true, userId: true, firstName: true, lastName: true, email: true, user: { select: { email: true } } } } },
      });
      await notificationService.bulkCreate(
        enrollments.map((e) => e.student.userId).filter((id): id is string => id !== null),
        {
          type: 'FEEDBACK_FORM_RELEASED',
          title: 'Feedback form available',
          message: `Please fill out the feedback form: ${form.title}.`,
          data: { formId: form.id, releaseId: release.id, scheduleId },
        }
      );

      const deadlineStr = formatDeadline(deadlineDate);

      for (const e of enrollments) {
        const to = e.student.email || e.student.user?.email;
        if (!to) continue;
        emailService
          .send({
            to,
            subject: `Feedback form available: ${form.title}`,
            html: emailService.templates.feedbackFormReleased({
              studentName: `${e.student.firstName} ${e.student.lastName}`,
              formTitle: form.title,
              moduleTitle: form.module.title,
              courseName: schedule.course.name,
              deadline: deadlineStr,
            }),
            template: 'feedbackFormReleased',
          })
          .catch(() => undefined);
      }

      const staff = await getStaffRecipients(scheduleId);
      for (const s of staff) {
        emailService
          .send({
            to: s.email,
            subject: `[Production] Feedback form released: ${form.title}`,
            html: emailService.templates.staffReleaseNotice({
              recipientName: s.name,
              kindLabel: 'Feedback Form',
              title: form.title,
              courseName: schedule.course.name,
              scheduleLabel: `${schedule.batch.code} · ${schedule.course.name}`,
              deadline: deadlineStr,
              studentCount: enrollments.length,
            }),
            template: 'staffReleaseNotice',
          })
          .catch(() => undefined);
      }

      res.status(201).json({ success: true, data: release });
    } catch (err) { next(err); }
  },

  /** One-click manual activation of an Online Test for a schedule. */
  async activateOnlineTest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      const { testId, deadline } = req.body;
      if (!testId) throw new AppError('testId is required', 400);
      await assertOwnsSchedule(employeeId, scheduleId);

      const test = await prisma.onlineTest.findUnique({
        where: { id: testId },
        include: { module: { select: { title: true, courseId: true } }, _count: { select: { questions: true } } },
      });
      if (!test) throw new AppError('Online test not found', 404);
      if (test._count.questions === 0) throw new AppError('This test has no questions yet', 400);

      const schedule = await prisma.batchCourseSchedule.findUnique({
        where: { id: scheduleId },
        include: { course: { select: { name: true } }, batch: { select: { code: true } } },
      });
      if (!schedule || schedule.courseId !== test.module.courseId) {
        throw new AppError('This test does not belong to this schedule\'s course', 400);
      }

      const deadlineDate = deadline ? new Date(deadline) : null;
      const release = await prisma.onlineTestRelease.upsert({
        where: { testId_scheduleId: { testId, scheduleId } },
        update: { status: 'ACTIVE', activatedAt: new Date(), activatedById: employeeId, deadline: deadlineDate },
        create: { testId, scheduleId, activatedById: employeeId, deadline: deadlineDate },
      });

      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { scheduleId, status: 'ACTIVE' },
        include: { student: { select: { id: true, userId: true, firstName: true, lastName: true, email: true, user: { select: { email: true } } } } },
      });
      await notificationService.bulkCreate(
        enrollments.map((e) => e.student.userId).filter((id): id is string => id !== null),
        {
          type: 'TEST_ACTIVATED',
          title: 'Test activated',
          message: `${test.title} is now open. You have ${test.durationMinutes} minutes once you start.`,
          data: { testId: test.id, releaseId: release.id, scheduleId },
        }
      );

      const deadlineStr = formatDeadline(deadlineDate);

      for (const e of enrollments) {
        const to = e.student.email || e.student.user?.email;
        if (!to) continue;
        emailService
          .send({
            to,
            subject: `Online test activated: ${test.title}`,
            html: emailService.templates.testActivated({
              studentName: `${e.student.firstName} ${e.student.lastName}`,
              testTitle: test.title,
              moduleTitle: test.module.title,
              courseName: schedule.course.name,
              durationMinutes: test.durationMinutes,
              deadline: deadlineStr,
            }),
            template: 'testActivated',
          })
          .catch(() => undefined);
      }

      const staff = await getStaffRecipients(scheduleId);
      for (const s of staff) {
        emailService
          .send({
            to: s.email,
            subject: `[Production] Online test activated: ${test.title}`,
            html: emailService.templates.staffReleaseNotice({
              recipientName: s.name,
              kindLabel: 'Online Test',
              title: test.title,
              courseName: schedule.course.name,
              scheduleLabel: `${schedule.batch.code} · ${schedule.course.name}`,
              deadline: deadlineStr,
              studentCount: enrollments.length,
            }),
            template: 'staffReleaseNotice',
          })
          .catch(() => undefined);
      }

      res.status(201).json({ success: true, data: release });
    } catch (err) { next(err); }
  },

  /** Trainer can close a release/activation early (e.g. stop further submissions/attempts). */
  async closeRelease(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId } = req.params;
      const { kind, releaseId } = req.body as { kind: 'project' | 'feedback' | 'test'; releaseId: string };
      await assertOwnsSchedule(employeeId, scheduleId);
      if (!kind || !releaseId) throw new AppError('kind and releaseId are required', 400);

      if (kind === 'project') {
        const release = await prisma.projectRelease.findUnique({ where: { id: releaseId } });
        if (!release || release.scheduleId !== scheduleId) throw new AppError('Release not found for this schedule', 404);
        await prisma.projectRelease.update({ where: { id: releaseId }, data: { status: 'CLOSED' } });
      } else if (kind === 'feedback') {
        const release = await prisma.feedbackFormRelease.findUnique({ where: { id: releaseId } });
        if (!release || release.scheduleId !== scheduleId) throw new AppError('Release not found for this schedule', 404);
        await prisma.feedbackFormRelease.update({ where: { id: releaseId }, data: { status: 'CLOSED' } });
      } else if (kind === 'test') {
        const release = await prisma.onlineTestRelease.findUnique({ where: { id: releaseId } });
        if (!release || release.scheduleId !== scheduleId) throw new AppError('Release not found for this schedule', 404);
        await prisma.onlineTestRelease.update({ where: { id: releaseId }, data: { status: 'CLOSED' } });
      } else {
        throw new AppError('kind must be project, feedback, or test', 400);
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** Project submissions for a release, joined with the enrolled roster (so un-submitted students show too). */
  async projectSubmissions(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId, releaseId } = req.params;
      await assertOwnsSchedule(employeeId, scheduleId);

      const release = await prisma.projectRelease.findUnique({ where: { id: releaseId }, include: { project: true } });
      if (!release || release.scheduleId !== scheduleId) throw new AppError('Release not found for this schedule', 404);

      const [enrollments, submissions] = await Promise.all([
        prisma.studentBatchEnrollment.findMany({
          where: { scheduleId, status: 'ACTIVE' },
          include: { student: { select: { id: true, studentCode: true, firstName: true, lastName: true } } },
        }),
        prisma.projectSubmission.findMany({ where: { releaseId } }),
      ]);
      const byStudent = new Map(submissions.map((s) => [s.studentId, s]));
      const roster = enrollments.map((e) => ({ student: e.student, submission: byStudent.get(e.studentId) ?? null }));
      res.json({ success: true, data: { release, roster } });
    } catch (err) { next(err); }
  },

  /** Mark a project submission reviewed and grade it. Body: { reviewNote?, grade?, maxGrade? } */
  async reviewProjectSubmission(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId, submissionId } = req.params;
      const { reviewNote, grade, maxGrade } = req.body;
      await assertOwnsSchedule(employeeId, scheduleId);

      const submission = await prisma.projectSubmission.findUnique({ where: { id: submissionId }, include: { release: true } });
      if (!submission || submission.release.scheduleId !== scheduleId) throw new AppError('Submission not found for this schedule', 404);

      const updated = await prisma.projectSubmission.update({
        where: { id: submissionId },
        data: {
          status: 'REVIEWED',
          reviewedById: employeeId,
          reviewedAt: new Date(),
          reviewNote: reviewNote ?? undefined,
          grade: grade !== undefined ? Number(grade) : undefined,
          maxGrade: maxGrade !== undefined ? Number(maxGrade) : undefined,
        },
      });
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  // NOTE: Feedback form responses are intentionally not exposed here. Once a trainer
  // releases a feedback form and students respond, only the Production Manager can
  // read those responses — see productionContent.controller.ts feedbackFormResponses.

  /** Online test results for a release — every attempt, with score visible to the trainer too. */
  async onlineTestResults(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = req.user!.employeeId!;
      const { scheduleId, releaseId } = req.params;
      await assertOwnsSchedule(employeeId, scheduleId);

      const release = await prisma.onlineTestRelease.findUnique({ where: { id: releaseId }, include: { test: true } });
      if (!release || release.scheduleId !== scheduleId) throw new AppError('Release not found for this schedule', 404);

      const [enrollments, attempts] = await Promise.all([
        prisma.studentBatchEnrollment.findMany({
          where: { scheduleId, status: 'ACTIVE' },
          include: { student: { select: { id: true, studentCode: true, firstName: true, lastName: true } } },
        }),
        prisma.onlineTestAttempt.findMany({ where: { releaseId } }),
      ]);
      const byStudent = new Map(attempts.map((a) => [a.studentId, a]));
      const roster = enrollments.map((e) => ({
        student: e.student,
        attempt: byStudent.get(e.studentId) ?? null,
      }));
      res.json({ success: true, data: { release, roster } });
    } catch (err) { next(err); }
  },
};
