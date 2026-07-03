import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { hashPassword } from '../utils/helpers';
import { emailService } from '../services/email.service';
import { config } from '../config/env';

/**
 * Sends the student welcome email (credentials + first-login steps).
 * Skips synthetic placeholder addresses. Never blocks the request.
 */
function sendStudentWelcomeEmail(opts: { name?: string | null; studentCode: string; email?: string | null; batchLine?: string }) {
  const email = (opts.email || '').trim();
  if (!email || email.endsWith('.local')) return; // no real inbox to send to
  emailService.send({
    to: email,
    cc: 'v7032vinsup@gmail.com', // production team copy (Gaurav)
    subject: '🎓 Welcome to Vinsup Skill Academy — Your Student Portal Login',
    html: emailService.templates.studentWelcome({
      name: opts.name?.trim() || 'Student',
      studentCode: opts.studentCode,
      email: email.toLowerCase(),
      loginUrl: `${config.FRONTEND_URL}/login`,
      batchLine: opts.batchLine,
      logoUrl: `${config.FRONTEND_URL}/vinsup-logo.png`,
    }),
    template: 'student_welcome',
  }).catch((err) => console.error('Student welcome email failed:', err));
}

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };

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
async function buildStudentUserCreate(studentCode: string, email?: string | null) {
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

export const productionController = {
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
      const { name, description, totalHours, isActive } = req.body;
      const course = await prisma.academyCourse.update({
        where: { id: req.params.id },
        data: { name, description, totalHours: totalHours !== undefined ? Number(totalHours) : undefined, isActive },
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
              _count: { select: { enrollments: true } },
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
      const { timing, dayPattern, mode, startDate, endDate, capacity } = req.body;

      const schedule = await prisma.batchCourseSchedule.update({
        where: { id: scheduleId },
        data: {
          timing, dayPattern, mode,
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

      const [enrollmentCount, attendanceCount, testCount, kraCount] = await Promise.all([
        prisma.studentBatchEnrollment.count({ where: { scheduleId } }),
        prisma.studentAttendance.count({ where: { scheduleId } }),
        prisma.moduleTest.count({ where: { scheduleId } }),
        prisma.kRAEntry.count({ where: { scheduleId } }),
      ]);

      if (enrollmentCount || attendanceCount || testCount || kraCount) {
        throw new AppError(
          'Cannot delete this sub-batch — it has enrolled students, attendance, test, or KRA records. Remove those first.',
          400,
        );
      }

      await prisma.$transaction([
        prisma.trainerAssignment.deleteMany({ where: { scheduleId } }),
        prisma.batchCourseSchedule.delete({ where: { id: scheduleId } }),
      ]);

      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── STUDENTS & ENROLLMENTS ─────────────────────────────────────────────────
  async listStudents(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { track, status, phone, batchId, courseId, page, pageSize } = req.query;
      const where: Record<string, unknown> = {};
      if (track) where.track = track;
      if (status) where.status = status;
      if (phone) where.phone = { contains: String(phone) };

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
      const { studentCode, firstName, lastName, email, phone, track, leadId, subBatchCode } = req.body;
      let { scheduleId } = req.body;
      if (!studentCode || !email) {
        throw new AppError('studentCode and email are required', 400);
      }
      // Sub-batch code is the friendly way to map the student to a schedule
      if (!scheduleId && subBatchCode) scheduleId = await resolveScheduleByCode(subBatchCode);
      const createdById = req.user?.employeeId;

      const student = await prisma.student.create({
        data: {
          studentCode,
          firstName: firstName || 'Pending',
          lastName: lastName || 'Update',
          email,
          phone: phone || 'PENDING',
          track,
          leadId: leadId || undefined,
          ...(createdById ? { createdBy: { connect: { id: createdById } } } : {}),
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
      });

      res.status(201).json({ success: true, data: student, message: 'Student created. Login credentials emailed.' });
    } catch (err) { next(err); }
  },

  async updateStudent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { firstName, lastName, email, phone, track, status } = req.body;
      const existing = await prisma.student.findUnique({ where: { id: req.params.id } });
      // Starts the 90-day / 3-interview placement SLA clock the first time a
      // PAP/IOP student's status flips to COMPLETED (handed off to placement team).
      const startsPlacementClock = status === 'COMPLETED' && existing?.status !== 'COMPLETED' && !existing?.movedToPlacementAt;

      const student = await prisma.student.update({
        where: { id: req.params.id },
        data: {
          firstName, lastName, email, phone, track, status,
          movedToPlacementAt: startsPlacementClock ? new Date() : undefined,
        },
      });
      res.json({ success: true, data: student });
    } catch (err) { next(err); }
  },

  async bulkUploadStudents(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { students } = req.body;
      if (!Array.isArray(students) || !students.length) {
        throw new AppError('students array is required', 400);
      }
      const createdById = req.user?.employeeId;

      // Pre-fetch batches/courses once so we don't hit the DB per row.
      const [allBatches, allCourses] = await Promise.all([
        prisma.batch.findMany({ include: { schedules: true } }),
        prisma.academyCourse.findMany(),
      ]);
      const batchByCode = new Map(allBatches.map((b) => [b.code.trim().toLowerCase(), b]));
      const courseByName = new Map(allCourses.map((c) => [c.name.trim().toLowerCase(), c]));
      const scheduleByCode = new Map(
        allBatches.flatMap((b) => b.schedules.filter((s) => s.code).map((s) => [s.code!.toUpperCase(), s.id] as [string, string]))
      );

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
          const track = ['JRP', 'IOP', 'PAP'].includes(trackRaw) ? trackRaw : 'JRP';

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
          const student = await prisma.student.create({
            data: {
              studentCode,
              firstName,
              lastName: lastName || '',
              email: rowEmail,
              phone,
              track: track as never,
              ...(createdById ? { createdBy: { connect: { id: createdById } } } : {}),
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
      const { studentId, subBatchCode } = req.body;
      let { scheduleId } = req.body;
      if (!scheduleId && subBatchCode) scheduleId = await resolveScheduleByCode(subBatchCode);
      if (!studentId || !scheduleId) throw new AppError('studentId and scheduleId (or subBatchCode) are required', 400);

      const enrollment = await prisma.studentBatchEnrollment.create({
        data: { studentId, scheduleId },
        include: { student: true, schedule: { include: { course: true, batch: true } } },
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

      const schedule = await prisma.batchCourseSchedule.findUnique({
        where: { id: scheduleId },
        include: { course: true, batch: true },
      });
      if (!schedule) throw new AppError('Schedule not found', 404);

      const studentWhere: Record<string, unknown> = {
        enrollments: { some: { scheduleId } },
        status: { notIn: ['PLACED', 'BATCH_TRANSFER'] },
      };
      if (track) studentWhere.track = track;

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
          select: { id: true, movedToPlacementAt: true },
        });
        const now = new Date();
        const needsClockStart = candidates.filter((c) => !c.movedToPlacementAt).map((c) => c.id);
        const alreadyClocked = candidates.filter((c) => c.movedToPlacementAt).map((c) => c.id);

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

        return res.json({ success: true, data: { updated: candidates.length, status } });
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
