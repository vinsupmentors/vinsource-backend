import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { hashPassword } from '../utils/helpers';
import { emailService } from '../services/email.service';
import { config } from '../config/env';
import { ensureCourseCompletionCertRequest } from '../utils/certificateRequests';

// Screen-recorded walkthrough of first login / registration on the student
// portal — linked from the welcome email so a student who gets stuck can
// just watch it instead of calling in. Update this if the recording moves.
const STUDENT_PORTAL_DEMO_VIDEO_URL = 'https://drive.google.com/file/d/1HCe3-I5WqnQXMvDMjdX1QxC-SN84y1QV/view?usp=sharing';

/**
 * Sends the student welcome email (credentials + first-login steps).
 * Skips synthetic placeholder addresses. Never blocks the request.
 *
 * CC's the production team copy (Gaurav) plus, when the student has a Skill
 * Advisor on file, that advisor's own email — so the Sales rep who enrolled
 * the student sees the credentials go out and has the same portal-demo link
 * on hand for follow-up.
 */
export function sendStudentWelcomeEmail(opts: {
  name?: string | null; studentCode: string; email?: string | null; batchLine?: string; advisorEmail?: string | null;
}) {
  const email = (opts.email || '').trim();
  if (!email || email.endsWith('.local')) return Promise.resolve(); // no real inbox to send to
  const cc = ['v7032vinsup@gmail.com']; // production team copy (Gaurav)
  const advisorEmail = opts.advisorEmail?.trim();
  if (advisorEmail && !cc.some((c) => c.toLowerCase() === advisorEmail.toLowerCase())) cc.push(advisorEmail);
  // Returns the send promise (existing fire-and-forget call sites just don't
  // await it) so one-off scripts like resendWelcomeEmail.ts CAN await it
  // before the process exits — otherwise node would exit before the SMTP
  // send actually completes.
  return emailService.send({
    to: email,
    cc,
    subject: '🎓 Welcome to Vinsup Skill Academy — Your Student Portal Login',
    html: emailService.templates.studentWelcome({
      name: opts.name?.trim() || 'Student',
      studentCode: opts.studentCode,
      email: email.toLowerCase(),
      loginUrl: `${config.FRONTEND_URL}/login`,
      batchLine: opts.batchLine,
      logoUrl: `${config.FRONTEND_URL}/vinsup-logo.png`,
      demoVideoUrl: STUDENT_PORTAL_DEMO_VIDEO_URL,
    }),
    template: 'student_welcome',
  }).catch((err) => console.error('Student welcome email failed:', err));
}

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };

/**
 * Runs the actual cascade-delete once a student deletion has been approved.
 * Still enforces the attendance/test/placement safety check at delete time
 * (not just at request time), since records may have been added between
 * when the deletion was requested and when an admin approved it — unless
 * `force` is set, in which case an Admin/Super Admin/Manager has explicitly
 * chosen to permanently erase the student along with all of that history
 * too. Before the row is actually removed, a snapshot of the student plus
 * the full request/approval trail is written to StudentDeletionLog — the
 * Student row (and the deletionRequestedAt/By/Reason fields living on it)
 * disappears the moment this transaction commits, so this is the only place
 * that history survives.
 */
async function performStudentDelete(id: string, force = false, approvedById?: string | null) {
  const student = await prisma.student.findUnique({
    where: { id },
    include: {
      _count: {
        select: {
          attendances: true,
          onlineTestAttempts: true,
          placementResults: true,
        },
      },
      enrollments: {
        include: { schedule: { include: { course: true, batch: true } } },
        orderBy: { enrolledAt: 'desc' },
        take: 1,
      },
    },
  });
  if (!student) throw new AppError('Student not found', 404);
  const { attendances, onlineTestAttempts, placementResults } = student._count;
  if (!force && attendances + onlineTestAttempts + placementResults > 0) {
    throw new AppError(
      'Cannot delete a student who has attendance, test, or placement records. Set their status to DROPPED instead, or use Force Delete to permanently erase everything.',
      409,
    );
  }
  const latestEnrollment = student.enrollments[0];
  // Cascade-delete FK-dependent records first, then delete the student (all
  // inside one transaction). The attendance/test/placement tables are only
  // touched here when force=true — normally the safety check above already
  // guarantees they're empty by this point.
  await prisma.$transaction(async (tx) => {
    await tx.studentDeletionLog.create({
      data: {
        studentId: student.id,
        studentCode: student.studentCode,
        firstName: student.firstName,
        lastName: student.lastName,
        email: student.email,
        phone: student.phone,
        track: student.track,
        status: student.status,
        courseName: latestEnrollment?.schedule?.course?.name ?? null,
        batchCode: latestEnrollment?.schedule?.batch?.code ?? null,
        deletionReason: student.deletionReason,
        requestedAt: student.deletionRequestedAt ?? new Date(),
        requestedById: student.deletionRequestedById,
        approvedById: approvedById ?? null,
        forced: force,
        attendanceCount: attendances,
        testAttemptCount: onlineTestAttempts,
        placementResultCount: placementResults,
      },
    });
    if (force) {
      await tx.studentAttendance.deleteMany({ where: { studentId: id } });
      await tx.onlineTestAttempt.deleteMany({ where: { studentId: id } }); // OnlineTestAnswer rows cascade via DB FK
      await tx.placementResult.deleteMany({ where: { studentId: id } });
    }
    await tx.feedbackFormResponse.deleteMany({ where: { studentId: id } });
    await tx.projectSubmission.deleteMany({ where: { studentId: id } });
    await tx.courseFeedback.deleteMany({ where: { studentId: id } });
    await tx.trainerFeedback.deleteMany({ where: { studentId: id } });
    await tx.moduleFeedback.deleteMany({ where: { studentId: id } });
    await tx.moduleMark.deleteMany({ where: { studentId: id } });
    await tx.certificate.deleteMany({ where: { studentId: id } });
    await tx.referral.deleteMany({ where: { studentId: id } });
    await tx.softskillAttendance.deleteMany({ where: { studentId: id } });
    await tx.softskillAttendanceDay.deleteMany({ where: { studentId: id } });
    await tx.softskillFeedback.deleteMany({ where: { studentId: id } });
    await tx.placementDriveCandidate.deleteMany({ where: { studentId: id } });
    await tx.placementInterview.deleteMany({ where: { studentId: id } });
    await tx.studentPortfolio.deleteMany({ where: { studentId: id } });
    await tx.studentBatchEnrollment.deleteMany({ where: { studentId: id } });
    await tx.student.delete({ where: { id } });

    // The Student row is gone, but its linked login account (User) isn't —
    // Student_userId_fkey is ON DELETE SET NULL, so deleting Student alone
    // leaves an orphaned User whose unique `email` blocks re-adding the same
    // student later. Clean up the User + its RESTRICT-FK dependents too.
    if (student.userId) {
      await tx.userSession.deleteMany({ where: { userId: student.userId } });
      await tx.notification.deleteMany({ where: { userId: student.userId } });
      await tx.notificationLog.deleteMany({ where: { userId: student.userId } });
      await tx.auditLog.deleteMany({ where: { userId: student.userId } });
      await tx.passwordLog.deleteMany({ where: { userId: student.userId } });
      await tx.userModuleAccess.deleteMany({ where: { userId: student.userId } });
      await tx.user.delete({ where: { id: student.userId } });
    }
  });
}

/**
 * Builds the nested `user.create` payload for a newly-created Student so a
 * STUDENT-role login is provisioned automatically. Initial password is the
 * student's own studentCode (per product decision); student must change it
 * on first login (`mustChangePassword: true`), at which point they're also
 * routed through the MIS-completion wizard.
 *
 * Student.email is optional, but User.email is required + unique, so rows
 * without a real email get a synthetic, obviously-fake placeholder address.
 */
export async function buildStudentUserCreate(studentCode: string, email?: string | null) {
  const loginEmail = (email && email.trim()) || `${studentCode.toLowerCase()}@students.vinsupacademy.local`;
  const password = await hashPassword(studentCode);
  return {
    create: {
      email: loginEmail.toLowerCase(),
      password,
      role: 'STUDENT' as never,
      mustChangePassword: true,
    },
  };
}

/**
 * Generates a readable, unique sub-batch code: <BATCH>-<COURSE INITIALS>-<TIMING>,
 * e.g. "B14-DA-EVE". Numeric suffix on collision (B14-DA-EVE-2).
 */
async function generateSubBatchCode(db: typeof prisma, batchId: string, courseId: string, timing: string): Promise<string> {
  const [batch, course] = await Promise.all([
    db.batch.findUnique({ where: { id: batchId }, select: { code: true } }),
    db.academyCourse.findUnique({ where: { id: courseId }, select: { name: true } }),
  ]);
  const batchPart = (batch?.code || 'B')
    .toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^BATCH/, 'B') || 'B';
  const coursePart = (course?.name || 'C')
    .split(/[^A-Za-z0-9]+/).filter(Boolean).map((w) => w[0].toUpperCase()).join('').slice(0, 4) || 'C';
  const timingPart = String(timing).slice(0, 3).toUpperCase();

  const base = `${batchPart}-${coursePart}-${timingPart}`;
  let code = base;
  let n = 2;
  while (await db.batchCourseSchedule.findUnique({ where: { code } })) {
    code = `${base}-${n++}`;
  }
  return code;
}

/** Resolves a sub-batch code (case-insensitive) to a schedule id. */
async function resolveScheduleByCode(subBatchCode: string): Promise<string> {
  const code = subBatchCode.trim().toUpperCase();
  const schedule = await prisma.batchCourseSchedule.findUnique({ where: { code } });
  if (!schedule) throw new AppError(`Sub-batch code "${code}" not found`, 404);
  return schedule.id;
}

/** Resolves a Skill Advisor's employee code (case-insensitive) to an Employee
 * id — used at student intake to link the student to the Sales rep who gets
 * "My Students" visibility over them. Any employee code is accepted (not
 * restricted to a specific designation). Throws on an unknown code so a typo
 * doesn't silently create an unlinked student. */
export async function resolveEmployeeByCode(employeeCode: string): Promise<{ id: string; email: string }> {
  const code = employeeCode.trim().toUpperCase();
  const employee = await prisma.employee.findUnique({ where: { employeeCode: code }, select: { id: true, email: true } });
  if (!employee) throw new AppError(`Skill Advisor employee code "${code}" not found`, 404);
  return employee;
}

export const productionController = {
  // ── COURSE MATERIALS ──────────────────────────────────────────────────────
  // Students see ALL of a course's materials from day one of enrollment.
  async listMaterials(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const materials = await prisma.courseMaterial.findMany({
        where: { courseId: req.params.courseId },
        include: {
          module: { select: { id: true, order: true, title: true } },
          uploadedBy: { select: employeeSelect },
        },
        orderBy: [{ module: { order: 'asc' } }, { createdAt: 'asc' }],
      });
      res.json({ success: true, data: materials });
    } catch (err) { next(err); }
  },

  async addMaterial(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { courseId } = req.params;
      const { title, type, url, moduleId, notes } = req.body;

      let finalUrl: string;
      let finalType: string;
      if (req.file) {
        finalUrl = `/uploads/materials/${req.file.filename}`;
        finalType = 'FILE';
      } else {
        if (!url?.trim()) throw new AppError('Provide a file or a link URL', 400);
        finalUrl = String(url).trim();
        if (!/^https?:\/\//i.test(finalUrl)) throw new AppError('Link must start with http:// or https://', 400);
        finalType = type === 'VIDEO' ? 'VIDEO' : 'LINK';
      }
      if (!title?.trim()) throw new AppError('Title is required', 400);

      const material = await prisma.courseMaterial.create({
        data: {
          courseId,
          moduleId: moduleId || null,
          title: String(title).trim(),
          type: finalType as never,
          url: finalUrl,
          notes: notes?.trim() || null,
          uploadedById: req.user?.employeeId || null,
        },
        include: { module: { select: { id: true, order: true, title: true } } },
      });
      res.status(201).json({ success: true, data: material });
    } catch (err) { next(err); }
  },

  async removeMaterial(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.courseMaterial.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Material removed' });
    } catch (err) { next(err); }
  },

  // ── COURSES & MODULES ─────────────────────────────────────────────────────
  async listCourses(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const courses = await prisma.academyCourse.findMany({
        include: { modules: { orderBy: { order: 'asc' } }, _count: { select: { schedules: true } } },
        orderBy: { name: 'asc' },
      });
      res.json({ success: true, data: courses });
    } catch (err) { next(err); }
  },

  async createCourse(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, description, totalHours, isCustom } = req.body;
      if (!name) throw new AppError('Course name is required', 400);

      const course = await prisma.academyCourse.create({
        data: { name, description, totalHours: totalHours ? Number(totalHours) : undefined, isCustom: !!isCustom },
      });
      res.status(201).json({ success: true, data: course });
    } catch (err) { next(err); }
  },

  async updateCourse(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, description, totalHours, isActive, isCustom } = req.body;
      const course = await prisma.academyCourse.update({
        where: { id: req.params.id },
        data: {
          name, description,
          totalHours: totalHours !== undefined ? Number(totalHours) : undefined,
          isActive,
          isCustom: isCustom !== undefined ? !!isCustom : undefined,
        },
      });
      res.json({ success: true, data: course });
    } catch (err) { next(err); }
  },

  async addModule(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { courseId } = req.params;
      const { order, title, hours, dayRange, topics } = req.body;
      if (!title) throw new AppError('Module title is required', 400);

      const nextOrder = order ?? (await prisma.academyModule.count({ where: { courseId } })) + 1;
      const module = await prisma.academyModule.create({
        data: { courseId, order: Number(nextOrder), title, hours: hours ? Number(hours) : undefined, dayRange, topics },
      });
      res.status(201).json({ success: true, data: module });
    } catch (err) { next(err); }
  },

  async updateModule(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { order, title, hours, dayRange, topics } = req.body;
      const module = await prisma.academyModule.update({
        where: { id: req.params.id },
        data: { order: order !== undefined ? Number(order) : undefined, title, hours: hours !== undefined ? Number(hours) : undefined, dayRange, topics },
      });
      res.json({ success: true, data: module });
    } catch (err) { next(err); }
  },

  // ── BATCHES & SCHEDULES ────────────────────────────────────────────────────
  async listBatches(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status } = req.query;
      const where: Record<string, unknown> = {};
      if (status) where.status = status;

      const batches = await prisma.batch.findMany({
        where,
        include: {
          createdBy: { select: employeeSelect },
          schedules: {
            include: {
              course: { select: { id: true, name: true } },
              trainers: { include: { trainer: { select: employeeSelect } } },
              // Filtered to ACTIVE — an unfiltered count would keep counting
              // DROPPED rows (e.g. from a batch move) forever, making the
              // "N students" badge never shrink even after a transfer.
              _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: batches });
    } catch (err) { next(err); }
  },

  async createBatch(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { code, startDate, endDate } = req.body;
      if (!code) throw new AppError('Batch name is required', 400);

      const createdById = req.user?.employeeId;
      const batch = await prisma.batch.create({
        data: {
          code,
          startDate: startDate ? new Date(startDate) : new Date(),
          endDate: endDate ? new Date(endDate) : undefined,
          createdById,
        },
      });
      res.status(201).json({ success: true, data: batch });
    } catch (err) { next(err); }
  },

  async updateBatch(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { code, startDate, endDate, status } = req.body;

      // A Batch can only be marked COMPLETED once every non-cancelled
      // sub-batch (course) within it is itself COMPLETED — different courses
      // in the same batch finish at different times, so this used to be a
      // no-op check (sub-batches had no status of their own at all).
      if (status === 'COMPLETED') {
        const schedules = await prisma.batchCourseSchedule.findMany({
          where: { batchId: req.params.id },
          include: { course: { select: { name: true } } },
        });
        const relevant = schedules.filter((s) => s.status !== 'CANCELLED');
        if (relevant.length === 0) {
          throw new AppError('Cannot mark this batch Completed — it has no sub-batches yet.', 400);
        }
        const notDone = relevant.filter((s) => s.status !== 'COMPLETED');
        if (notDone.length > 0) {
          const names = notDone.map((s) => s.code || s.course.name).join(', ');
          throw new AppError(`Cannot mark this batch Completed — these sub-batches aren't Completed yet: ${names}`, 400);
        }
      }

      const batch = await prisma.batch.update({
        where: { id: req.params.id },
        data: {
          code, status,
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate ? new Date(endDate) : undefined,
        },
      });
      res.json({ success: true, data: batch });
    } catch (err) { next(err); }
  },

  async addSchedule(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { batchId } = req.params;
      const {
        courseId, timing, dayPattern, mode, startDate, endDate, capacity,
        trainerIds, studentIds,
      } = req.body;
      if (!courseId || !timing || !dayPattern || !mode) {
        throw new AppError('courseId, timing, dayPattern, and mode are required', 400);
      }

      const subBatchCode = await generateSubBatchCode(prisma, batchId, courseId, timing);

      const schedule = await prisma.$transaction(async (tx) => {
        const created = await tx.batchCourseSchedule.create({
          data: {
            code: subBatchCode,
            batchId, courseId, timing, dayPattern, mode,
            startDate: startDate ? new Date(startDate) : new Date(),
            endDate: endDate ? new Date(endDate) : undefined,
            capacity: capacity ? Number(capacity) : undefined,
          },
        });

        if (Array.isArray(trainerIds) && trainerIds.length) {
          await tx.trainerAssignment.createMany({
            data: trainerIds.map((trainerId: string) => ({ scheduleId: created.id, trainerId })),
            skipDuplicates: true,
          });
        }
        if (Array.isArray(studentIds) && studentIds.length) {
          await tx.studentBatchEnrollment.createMany({
            data: studentIds.map((studentId: string) => ({ scheduleId: created.id, studentId })),
            skipDuplicates: true,
          });
        }

        return tx.batchCourseSchedule.findUnique({
          where: { id: created.id },
          include: {
            course: true,
            trainers: { include: { trainer: { select: employeeSelect } } },
            _count: { select: { enrollments: true } },
          },
        });
      });

      res.status(201).json({ success: true, data: schedule });
    } catch (err) { next(err); }
  },

  async assignTrainer(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduleId } = req.params;
      const { trainerId } = req.body;
      if (!trainerId) throw new AppError('trainerId is required', 400);

      const assignment = await prisma.trainerAssignment.upsert({
        where: { scheduleId_trainerId: { scheduleId, trainerId } },
        update: {},
        create: { scheduleId, trainerId },
        include: { trainer: { select: employeeSelect } },
      });
      res.status(201).json({ success: true, data: assignment });
    } catch (err) { next(err); }
  },

  async removeTrainer(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduleId, trainerId } = req.params;
      await prisma.trainerAssignment.delete({ where: { scheduleId_trainerId: { scheduleId, trainerId } } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async updateSchedule(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduleId } = req.params;
      const { timing, dayPattern, mode, startDate, endDate, capacity, status } = req.body;

      const schedule = await prisma.batchCourseSchedule.update({
        where: { id: scheduleId },
        data: {
          timing, dayPattern, mode, status,
          startDate: startDate ? new Date(startDate) : undefined,
          endDate: endDate === '' ? null : endDate ? new Date(endDate) : undefined,
          capacity: capacity === '' ? null : capacity !== undefined ? Number(capacity) : undefined,
        },
        include: {
          course: true,
          trainers: { include: { trainer: { select: employeeSelect } } },
          _count: { select: { enrollments: true } },
        },
      });
      res.json({ success: true, data: schedule });
    } catch (err) { next(err); }
  },

  async deleteSchedule(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduleId } = req.params;

      // Only enrollments that still represent "this student is/was actually
      // being taught here" should block deletion. DROPPED rows are left behind
      // by batch transfers (student moved to a different sub-batch) and carry
      // no attendance/marks/tests of their own here — they're safe to clean up
      // along with the schedule itself rather than blocking its deletion forever.
      const [liveEnrollmentCount, attendanceCount, testCount, kraCount] = await Promise.all([
        prisma.studentBatchEnrollment.count({ where: { scheduleId, status: { not: 'DROPPED' } } }),
        prisma.studentAttendance.count({ where: { scheduleId } }),
        prisma.moduleTest.count({ where: { scheduleId } }),
        prisma.kRAEntry.count({ where: { scheduleId } }),
      ]);

      if (liveEnrollmentCount || attendanceCount || testCount || kraCount) {
        throw new AppError(
          'Cannot delete this sub-batch — it has enrolled students, attendance, test, or KRA records. Remove those first.',
          400,
        );
      }

      await prisma.$transaction([
        prisma.trainerAssignment.deleteMany({ where: { scheduleId } }),
        prisma.studentBatchEnrollment.deleteMany({ where: { scheduleId } }),
        prisma.batchCourseSchedule.delete({ where: { id: scheduleId } }),
      ]);

      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── STUDENTS & ENROLLMENTS ─────────────────────────────────────────────────
  async listStudents(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { track, status, phone, search, batchId, courseId, page, pageSize } = req.query;
      const where: Record<string, unknown> = {};
      if (track) where.track = track;
      if (status) where.status = status;
      if (phone) where.phone = { contains: String(phone) };
      if (search) {
        where.OR = [
          { firstName: { contains: String(search) } },
          { lastName: { contains: String(search) } },
          { studentCode: { contains: String(search) } },
          { phone: { contains: String(search) } },
        ];
      }

      if (batchId || courseId) {
        const scheduleWhere: Record<string, unknown> = {};
        if (batchId) scheduleWhere.batchId = String(batchId);
        if (courseId) scheduleWhere.courseId = String(courseId);
        where.enrollments = { some: { schedule: scheduleWhere } };
      }

      const take = Math.min(Math.max(Number(pageSize) || 100, 1), 500);
      const currentPage = Math.max(Number(page) || 1, 1);
      const skip = (currentPage - 1) * take;

      const [students, total] = await Promise.all([
        prisma.student.findMany({
          where,
          include: {
            enrollments: { include: { schedule: { include: { course: true, batch: true } } } },
            // PM-facing visibility fix: surface trainer's internal eligibility/feedback
            // opinion (certificateEligible, placement readiness, etc.) and the
            // student-visible module feedback, both previously invisible outside the
            // Trainer Portal / deep student-report drilldown.
            trainerFeedbacks: {
              include: { course: { select: { id: true, name: true } }, trainer: { select: employeeSelect } },
              orderBy: { updatedAt: 'desc' },
            },
            moduleFeedbacks: {
              include: { module: { select: { id: true, title: true } }, trainer: { select: employeeSelect } },
              orderBy: { updatedAt: 'desc' },
            },
            skillAdvisor: { select: employeeSelect },
          },
          orderBy: { createdAt: 'desc' },
          skip,
          take,
        }),
        prisma.student.count({ where }),
      ]);

      res.json({
        success: true,
        data: students,
        pagination: { page: currentPage, pageSize: take, total, totalPages: Math.ceil(total / take) || 1 },
      });
    } catch (err) { next(err); }
  },

  /**
   * Minimal student intake: Production Manager only supplies studentCode,
   * email, and (optionally) the schedule to enroll into right away — the
   * rest of the MIS (name, phone, address, photo, Aadhar, parents, etc.) is
   * filled in by the student themselves on first login via the
   * complete-profile wizard. firstName/lastName/phone get obvious placeholder
   * values here so downstream UI (lists, certificates) doesn't break before
   * the student finishes their profile.
   */
  async createStudent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const {
        studentCode, firstName, lastName, email, phone, track, leadId, subBatchCode,
        trainingMode, totalProgramFee, amountPaid, paymentMode, skillAdvisorCode,
      } = req.body;
      let { scheduleId } = req.body;
      if (!studentCode || !email) {
        throw new AppError('studentCode and email are required', 400);
      }
      // Sub-batch code is the friendly way to map the student to a schedule
      if (!scheduleId && subBatchCode) scheduleId = await resolveScheduleByCode(subBatchCode);
      // Links the student to the Sales rep who owns them for "My Students" —
      // resolved from an employee code entered at intake rather than an id.
      // Also CC'd on the welcome email below.
      const advisor = skillAdvisorCode ? await resolveEmployeeByCode(skillAdvisorCode) : undefined;
      const createdById = req.user?.employeeId;

      // Balance is derived from total/paid when both are given, rather than
      // trusted verbatim from the client — keeps the three numbers internally
      // consistent even if the admin only fills in two of them.
      const total = totalProgramFee !== undefined && totalProgramFee !== '' ? Number(totalProgramFee) : undefined;
      const paid = amountPaid !== undefined && amountPaid !== '' ? Number(amountPaid) : undefined;
      const balance = total !== undefined && paid !== undefined ? total - paid : undefined;

      const student = await prisma.student.create({
        data: {
          studentCode,
          firstName: firstName || 'Pending',
          lastName: lastName || 'Update',
          email,
          phone: phone || 'PENDING',
          track,
          leadId: leadId || undefined,
          trainingMode: trainingMode || undefined,
          totalProgramFee: total,
          amountPaid: paid,
          balanceAmount: balance,
          paymentMode: paymentMode || undefined,
          ...(createdById ? { createdBy: { connect: { id: createdById } } } : {}),
          ...(advisor ? { skillAdvisor: { connect: { id: advisor.id } } } : {}),
          user: await buildStudentUserCreate(studentCode, email),
          ...(scheduleId ? { enrollments: { create: { scheduleId } } } : {}),
        },
        include: {
          user: { select: { id: true, email: true } },
          enrollments: { include: { schedule: { include: { course: true, batch: true } } } },
        },
      });

      // Welcome email with credentials + first-login steps
      const enr = student.enrollments[0];
      sendStudentWelcomeEmail({
        name: `${student.firstName} ${student.lastName}`.replace('Pending Update', '').trim() || undefined,
        studentCode,
        email,
        batchLine: enr ? `${enr.schedule.batch.code} — ${enr.schedule.course.name} (${enr.schedule.timing})` : undefined,
        advisorEmail: advisor?.email,
      });

      res.status(201).json({ success: true, data: student, message: 'Student created. Login credentials emailed.' });
    } catch (err) { next(err); }
  },

  async updateStudent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const {
        firstName, lastName, email, phone, track, status,
        trainingMode, totalProgramFee, amountPaid, paymentMode, skillAdvisorCode,
      } = req.body;
      const existing = await prisma.student.findUnique({ where: { id: req.params.id } });
      // Empty string clears the advisor link; omitted leaves it untouched;
      // a code resolves to the matching employee (throws if unknown).
      const skillAdvisorId = skillAdvisorCode !== undefined
        ? (skillAdvisorCode ? (await resolveEmployeeByCode(skillAdvisorCode)).id : null)
        : undefined;
      // JRP is course-only, non-placement — block a direct edit from ever
      // setting a JRP student's status to IN_PLACEMENT (covers whichever
      // track — the one already on file, or a new one being set in this
      // same request — ends up applying).
      const resultingTrack = track !== undefined ? track : existing?.track;
      if (status === 'IN_PLACEMENT' && resultingTrack === 'JRP') {
        throw new AppError('JRP students cannot be moved to the Placement Pool', 400);
      }
      // Starts the 90-day / 3-interview placement SLA clock the first time a
      // PAP/IOP student's status flips to COMPLETED (handed off to placement team).
      const startsPlacementClock = status === 'COMPLETED' && existing?.status !== 'COMPLETED' && !existing?.movedToPlacementAt;

      // Same derive-balance-from-total/paid rule as createStudent — only
      // recomputed when at least one of the two is actually being changed,
      // otherwise fall back to whatever's already on file.
      const total = totalProgramFee !== undefined && totalProgramFee !== '' ? Number(totalProgramFee) : existing?.totalProgramFee ?? undefined;
      const paid = amountPaid !== undefined && amountPaid !== '' ? Number(amountPaid) : existing?.amountPaid ?? undefined;
      const balance = total !== undefined && paid !== undefined ? total - paid : undefined;

      const student = await prisma.student.update({
        where: { id: req.params.id },
        data: {
          firstName, lastName, email, phone, track, status,
          skillAdvisorId,
          movedToPlacementAt: startsPlacementClock ? new Date() : undefined,
          trainingMode: trainingMode !== undefined ? (trainingMode || null) : undefined,
          totalProgramFee: totalProgramFee !== undefined ? total : undefined,
          amountPaid: amountPaid !== undefined ? paid : undefined,
          balanceAmount: (totalProgramFee !== undefined || amountPaid !== undefined) ? balance : undefined,
          paymentMode: paymentMode !== undefined ? (paymentMode || null) : undefined,
        },
      });
      if (status === 'IN_PLACEMENT' && existing?.status !== 'IN_PLACEMENT') {
        await ensureCourseCompletionCertRequest(student.id);
      }
      res.json({ success: true, data: student });
    } catch (err) { next(err); }
  },

  /**
   * "Delete a student" no longer deletes anything directly — it raises a
   * pending deletion request that shows up in the Production > Deletion
   * Requests tab, which only an Admin/Super Admin can approve. This is the
   * secondary-check the PM asked for: any user can flag a student for
   * deletion, but only an admin's approval actually removes the record.
   */
  async deleteStudent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { reason } = req.body;
      const student = await prisma.student.findUnique({ where: { id } });
      if (!student) throw new AppError('Student not found', 404);
      if (student.deletionRequestedAt) {
        throw new AppError('A deletion request for this student is already pending admin approval.', 409);
      }
      await prisma.student.update({
        where: { id },
        data: {
          deletionRequestedAt: new Date(),
          deletionRequestedById: req.user?.employeeId || null,
          deletionReason: (reason && String(reason).trim()) || null,
        },
      });
      res.json({ success: true, message: 'Deletion request submitted for admin approval.' });
    } catch (err) { next(err); }
  },

  /**
   * Lists students with a pending deletion request, for the Production
   * "Deletion Requests" tab (Admin/Super Admin approve or reject from here).
   */
  async listDeletionRequests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const students = await prisma.student.findMany({
        where: { deletionRequestedAt: { not: null } },
        include: {
          enrollments: { include: { schedule: { include: { course: true, batch: true } } } },
          deletionRequestedBy: { select: employeeSelect },
        },
        orderBy: { deletionRequestedAt: 'desc' },
      });
      res.json({ success: true, data: students });
    } catch (err) { next(err); }
  },

  /**
   * Admin/Super Admin approves a pending deletion request — runs the real
   * cascade-delete (with the safety check re-verified at this point, since
   * time may have passed since the request was made).
   */
  async approveDeleteStudent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      // force=true is an explicit Admin/Super Admin override (this route is
      // already requireRole('ADMIN','SUPER_ADMIN')-gated) — it bypasses the
      // attendance/test/placement safety check and permanently erases that
      // history along with the student. Only sent after a second, explicit
      // confirmation on the frontend.
      const force = req.body?.force === true;
      const student = await prisma.student.findUnique({ where: { id } });
      if (!student) throw new AppError('Student not found', 404);
      if (!student.deletionRequestedAt) {
        throw new AppError('This student has no pending deletion request.', 409);
      }
      await performStudentDelete(id, force, req.user?.employeeId);
      res.json({ success: true, message: 'Student deleted.' });
    } catch (err) { next(err); }
  },

  /**
   * Audit trail of past student deletions — the actual Student rows are
   * long gone, this reads from the permanent StudentDeletionLog snapshot
   * instead. Same access level as the pending-requests list.
   */
  async listDeletionLog(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const logs = await prisma.studentDeletionLog.findMany({
        include: {
          requestedBy: { select: employeeSelect },
          approvedBy: { select: employeeSelect },
        },
        orderBy: { approvedAt: 'desc' },
        take: 200,
      });
      res.json({ success: true, data: logs });
    } catch (err) { next(err); }
  },

  /**
   * Admin/Super Admin rejects a pending deletion request — just clears the
   * request fields, student is untouched.
   */
  async cancelDeleteRequest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const student = await prisma.student.findUnique({ where: { id } });
      if (!student) throw new AppError('Student not found', 404);
      if (!student.deletionRequestedAt) {
        throw new AppError('This student has no pending deletion request.', 409);
      }
      await prisma.student.update({
        where: { id },
        data: { deletionRequestedAt: null, deletionRequestedById: null, deletionReason: null },
      });
      res.json({ success: true, message: 'Deletion request rejected.' });
    } catch (err) { next(err); }
  },

  async bulkUploadStudents(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { students } = req.body;
      if (!Array.isArray(students) || !students.length) {
        throw new AppError('students array is required', 400);
      }
      const createdById = req.user?.employeeId;

      // Pre-fetch batches/courses/employees once so we don't hit the DB per row.
      const [allBatches, allCourses, allEmployees] = await Promise.all([
        prisma.batch.findMany({ include: { schedules: true } }),
        prisma.academyCourse.findMany(),
        prisma.employee.findMany({ select: { id: true, employeeCode: true, email: true } }),
      ]);
      const batchByCode = new Map(allBatches.map((b) => [b.code.trim().toLowerCase(), b]));
      const courseByName = new Map(allCourses.map((c) => [c.name.trim().toLowerCase(), c]));
      const scheduleByCode = new Map(
        allBatches.flatMap((b) => b.schedules.filter((s) => s.code).map((s) => [s.code!.toUpperCase(), s.id] as [string, string]))
      );
      const employeeByCode = new Map(allEmployees.map((e) => [e.employeeCode.trim().toUpperCase(), { id: e.id, email: e.email }]));

      const existingCodesCount = await prisma.student.count();
      let autoSeq = existingCodesCount;

      const results: Array<{ row: number; status: 'created' | 'error'; message?: string; studentId?: string }> = [];

      for (let i = 0; i < students.length; i++) {
        const row = students[i] || {};
        const rowNum = i + 1;
        try {
          const firstName = String(row.firstName || '').trim();
          const lastName = String(row.lastName || '').trim();
          const phone = String(row.phone || '').trim();
          if (!firstName || !phone) {
            results.push({ row: rowNum, status: 'error', message: 'firstName and phone are required' });
            continue;
          }

          let studentCode = String(row.studentCode || '').trim();
          if (!studentCode) {
            do {
              autoSeq += 1;
              studentCode = `STU${String(autoSeq).padStart(5, '0')}`;
            } while (await prisma.student.findUnique({ where: { studentCode } }));
          } else {
            const dup = await prisma.student.findUnique({ where: { studentCode } });
            if (dup) {
              results.push({ row: rowNum, status: 'error', message: `studentCode "${studentCode}" already exists` });
              continue;
            }
          }

          const trackRaw = String(row.track || 'JRP').trim().toUpperCase();
          const track = ['JRP', 'IOP', 'PAP', 'PT'].includes(trackRaw) ? trackRaw : 'JRP';

          // Preferred: direct sub-batch code (e.g. "B14-DA-EVE") maps the student exactly
          const rowSubBatch = String(row.subBatchCode || row.subBatch || '').trim().toUpperCase();
          if (rowSubBatch && !scheduleByCode.has(rowSubBatch)) {
            results.push({ row: rowNum, status: 'error', message: `Sub-batch code "${rowSubBatch}" not found` });
            continue;
          }

          const batchCode = String(row.batch || row.batchCode || row.batchNumber || '').trim();
          const batch = batchCode ? batchByCode.get(batchCode.toLowerCase()) : undefined;
          if (!rowSubBatch && batchCode && !batch) {
            results.push({ row: rowNum, status: 'error', message: `Batch "${batchCode}" not found` });
            continue;
          }

          let scheduleId: string | undefined = rowSubBatch ? scheduleByCode.get(rowSubBatch) : undefined;
          if (!scheduleId && batch) {
            const schedules = batch.schedules;
            const courseName = String(row.course || '').trim();
            if (courseName) {
              const course = courseByName.get(courseName.toLowerCase());
              const match = course ? schedules.find((s) => s.courseId === course.id) : undefined;
              scheduleId = match?.id;
              if (!scheduleId) {
                results.push({ row: rowNum, status: 'error', message: `No sub-batch for course "${courseName}" in batch "${batchCode}"` });
              }
            } else if (schedules.length === 1) {
              scheduleId = schedules[0].id;
            } else if (schedules.length > 1) {
              results.push({ row: rowNum, status: 'error', message: `Batch "${batchCode}" has multiple sub-batches; specify a course` });
            }
          }

          const rowEmail = row.email ? String(row.email).trim() : undefined;

          const rowAdvisorCode = String(row.skillAdvisorCode || row.skillAdvisor || '').trim().toUpperCase();
          let rowAdvisor: { id: string; email: string } | undefined;
          if (rowAdvisorCode) {
            rowAdvisor = employeeByCode.get(rowAdvisorCode);
            if (!rowAdvisor) {
              results.push({ row: rowNum, status: 'error', message: `Skill Advisor employee code "${rowAdvisorCode}" not found` });
              continue;
            }
          }

          const student = await prisma.student.create({
            data: {
              studentCode,
              firstName,
              lastName: lastName || '',
              email: rowEmail,
              phone,
              track: track as never,
              ...(createdById ? { createdBy: { connect: { id: createdById } } } : {}),
              ...(rowAdvisor ? { skillAdvisor: { connect: { id: rowAdvisor.id } } } : {}),
              user: await buildStudentUserCreate(studentCode, rowEmail),
            },
          });

          if (scheduleId) {
            await prisma.studentBatchEnrollment.create({
              data: { studentId: student.id, scheduleId },
            }).catch(() => null);
          }

          // Welcome email with credentials (skipped automatically when no real email)
          sendStudentWelcomeEmail({
            name: `${firstName} ${lastName}`.trim(),
            studentCode,
            email: rowEmail,
            advisorEmail: rowAdvisor?.email,
          });

          results.push({ row: rowNum, status: 'created', studentId: student.id });
        } catch (rowErr) {
          results.push({ row: rowNum, status: 'error', message: rowErr instanceof Error ? rowErr.message : 'Unknown error' });
        }
      }

      const created = results.filter((r) => r.status === 'created').length;
      res.status(201).json({ success: true, data: { results, created, failed: results.length - created } });
    } catch (err) { next(err); }
  },

  async enrollStudent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { studentId, subBatchCode, previousEnrollmentId } = req.body;
      let { scheduleId } = req.body;
      if (!scheduleId && subBatchCode) scheduleId = await resolveScheduleByCode(subBatchCode);
      if (!studentId || !scheduleId) throw new AppError('studentId and scheduleId (or subBatchCode) are required', 400);

      // previousEnrollmentId marks this as a *move* (Edit Student's "move to a
      // different batch/schedule") rather than an additional concurrent
      // enrollment (the separate "Enroll Student" flow, where a student can
      // legitimately be active in more than one course at once). When
      // present, retire the old enrollment in the same transaction so the
      // student portal only ever reflects the current batch/trainer — not
      // both — without touching any other, unrelated enrollments.
      const enrollment = await prisma.$transaction(async (tx) => {
        if (previousEnrollmentId) {
          const prev = await tx.studentBatchEnrollment.findUnique({ where: { id: previousEnrollmentId } });
          if (prev && prev.studentId === studentId && prev.status === 'ACTIVE') {
            await tx.studentBatchEnrollment.update({ where: { id: previousEnrollmentId }, data: { status: 'DROPPED' } });
          }
        }
        return tx.studentBatchEnrollment.create({
          data: { studentId, scheduleId },
          include: { student: true, schedule: { include: { course: true, batch: true } } },
        });
      });
      res.status(201).json({ success: true, data: enrollment });
    } catch (err) { next(err); }
  },

  async bulkEnrollStudents(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { studentIds, scheduleId } = req.body;
      if (!scheduleId) throw new AppError('scheduleId is required', 400);
      if (!Array.isArray(studentIds) || !studentIds.length) {
        throw new AppError('studentIds array is required', 400);
      }

      const schedule = await prisma.batchCourseSchedule.findUnique({ where: { id: scheduleId } });
      if (!schedule) throw new AppError('Schedule not found', 404);

      const existing = await prisma.studentBatchEnrollment.findMany({
        where: { scheduleId, studentId: { in: studentIds } },
        select: { studentId: true },
      });
      const existingIds = new Set(existing.map((e) => e.studentId));
      const toCreate = studentIds.filter((id: string) => !existingIds.has(id));

      if (toCreate.length) {
        await prisma.studentBatchEnrollment.createMany({
          data: toCreate.map((studentId: string) => ({ studentId, scheduleId })),
          skipDuplicates: true,
        });
      }

      res.status(201).json({
        success: true,
        data: {
          enrolled: toCreate.length,
          alreadyEnrolled: existingIds.size,
          total: studentIds.length,
        },
      });
    } catch (err) { next(err); }
  },

  /**
   * Production Manager "push to Placements" action — operates at the
   * sub-batch level (a BatchCourseSchedule, optionally narrowed by
   * StudentTrack, matching the same granularity KRAEntry already uses for
   * "sub-batch"). This is a free judgment call for the PM — no eligibility
   * gate is enforced (e.g. certificateEligible is NOT required) — they now
   * have feedback/eligibility visibility (see listStudents) to inform that
   * call themselves.
   *
   * Semantics: this ONLY flags students — sets status = IN_PLACEMENT and
   * (write-once, same pattern as updateStudent) movedToPlacementAt — so the
   * original placement-SLA clock start date is preserved if a student was
   * already moved earlier. It does NOT create PlacementResult or any other
   * downstream record; that remains a manual Placements-side action.
   */
  async pushToPlacements(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduleId, track } = req.body;
      if (!scheduleId) throw new AppError('scheduleId is required', 400);
      // JRP is course-only, non-placement — only IOP/PAP students may ever be
      // pushed to Placements.
      if (track === 'JRP') throw new AppError('JRP students cannot be pushed to Placements', 400);

      const schedule = await prisma.batchCourseSchedule.findUnique({
        where: { id: scheduleId },
        include: { course: true, batch: true },
      });
      if (!schedule) throw new AppError('Schedule not found', 404);

      const studentWhere: Record<string, unknown> = {
        enrollments: { some: { scheduleId } },
        status: { notIn: ['PLACED', 'BATCH_TRANSFER'] },
        // When no specific track was requested ("ALL"), still silently
        // exclude JRP students rather than pushing the whole sub-batch.
        track: track || { not: 'JRP' },
      };

      const candidates = await prisma.student.findMany({
        where: studentWhere,
        select: { id: true, status: true, movedToPlacementAt: true },
      });

      if (!candidates.length) {
        return res.json({ success: true, data: { pushed: 0, total: 0 } });
      }

      const now = new Date();
      // Write-once: only backfill movedToPlacementAt for students who don't
      // already have one set (preserves the original SLA clock start date).
      const needsClockStart = candidates.filter((c) => !c.movedToPlacementAt).map((c) => c.id);
      const alreadyClocked = candidates.filter((c) => c.movedToPlacementAt).map((c) => c.id);

      await prisma.$transaction([
        ...(needsClockStart.length
          ? [prisma.student.updateMany({
              where: { id: { in: needsClockStart } },
              data: { status: 'IN_PLACEMENT', movedToPlacementAt: now },
            })]
          : []),
        ...(alreadyClocked.length
          ? [prisma.student.updateMany({
              where: { id: { in: alreadyClocked } },
              data: { status: 'IN_PLACEMENT' },
            })]
          : []),
      ]);

      await Promise.all(candidates.map((c) => ensureCourseCompletionCertRequest(c.id)));

      res.json({
        success: true,
        data: {
          pushed: candidates.length,
          total: candidates.length,
          schedule: { id: schedule.id, course: schedule.course.name, batch: schedule.batch.code },
          track: track || 'ALL',
        },
      });
    } catch (err) { next(err); }
  },

  /**
   * Bulk status change for an explicit, PM-picked list of students — the
   * general-purpose counterpart to pushToPlacements. The frontend gathers
   * studentIds by filtering to a sub-batch (same scheduleId/track
   * granularity as pushToPlacements) and then letting the PM check/uncheck
   * individual students within that list, so a batch of 70 can be updated in
   * one call instead of editing each student record by hand.
   *
   * If the target status is IN_PLACEMENT, movedToPlacementAt is backfilled
   * write-once (identical semantics to pushToPlacements) so this tool can
   * also be used as a more selective alternative to the "push entire
   * sub-batch" action.
   */
  async bulkUpdateStudentStatus(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { studentIds, status } = req.body;
      const validStatuses = ['ENROLLED', 'ONBOARDED', 'ACTIVE', 'INACTIVE', 'COMPLETED', 'IN_PLACEMENT', 'PLACED', 'BATCH_TRANSFER'];

      if (!Array.isArray(studentIds) || !studentIds.length) {
        throw new AppError('studentIds (non-empty array) is required', 400);
      }
      if (!status || !validStatuses.includes(status)) {
        throw new AppError(`status must be one of: ${validStatuses.join(', ')}`, 400);
      }

      if (status === 'IN_PLACEMENT') {
        const candidates = await prisma.student.findMany({
          where: { id: { in: studentIds } },
          select: { id: true, track: true, movedToPlacementAt: true },
        });
        // JRP is course-only, non-placement — silently exclude JRP students
        // from this bulk push rather than failing the whole batch.
        const skippedJrp = candidates.filter((c) => c.track === 'JRP').map((c) => c.id);
        const eligible = candidates.filter((c) => c.track !== 'JRP');
        const now = new Date();
        const needsClockStart = eligible.filter((c) => !c.movedToPlacementAt).map((c) => c.id);
        const alreadyClocked = eligible.filter((c) => c.movedToPlacementAt).map((c) => c.id);

        await prisma.$transaction([
          ...(needsClockStart.length
            ? [prisma.student.updateMany({
                where: { id: { in: needsClockStart } },
                data: { status, movedToPlacementAt: now },
              })]
            : []),
          ...(alreadyClocked.length
            ? [prisma.student.updateMany({
                where: { id: { in: alreadyClocked } },
                data: { status },
              })]
            : []),
        ]);

        await Promise.all(eligible.map((c) => ensureCourseCompletionCertRequest(c.id)));

        return res.json({ success: true, data: { updated: eligible.length, status, skippedJrp: skippedJrp.length } });
      }

      const result = await prisma.student.updateMany({
        where: { id: { in: studentIds } },
        data: { status },
      });

      res.json({ success: true, data: { updated: result.count, status } });
    } catch (err) { next(err); }
  },

  async updateEnrollment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status } = req.body;
      const enrollment = await prisma.studentBatchEnrollment.update({
        where: { id: req.params.id },
        data: { status },
      });
      res.json({ success: true, data: enrollment });
    } catch (err) { next(err); }
  },

  async stats(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const [ongoingBatches, upcomingBatches, totalStudents, activeStudents] = await Promise.all([
        prisma.batch.count({ where: { status: 'ONGOING' } }),
        prisma.batch.count({ where: { status: 'UPCOMING' } }),
        prisma.student.count(),
        prisma.student.count({ where: { status: 'ACTIVE' } }),
      ]);

      res.json({
        success: true,
        data: {
          ongoingBatches,
          upcomingBatches,
          totalStudents,
          activeStudents,
        },
      });
    } catch (err) { next(err); }
  },
};
