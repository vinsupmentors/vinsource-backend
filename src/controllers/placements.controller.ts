import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { emailService } from '../services/email.service';

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };

// Same convention used elsewhere (onboarding signed-document emails): skip
// placeholder ".local" addresses rather than let a real send attempt fail.
const hasRealEmail = (email?: string | null): email is string => !!email && !email.trim().endsWith('.local');

const SLA_MIN_INTERVIEWS = 3;
const SLA_WINDOW_DAYS = 90;

// Computes the "Ready for Placement" / "Not Yet Ready" split for one pool
// student: ready = every isCapstone Project released to a schedule the
// student is enrolled in has a REVIEWED submission from them, AND their
// StudentPortfolio is APPROVED. `missing` lists exactly what's outstanding.
function computeReadiness(
  student: {
    portfolio: { status: string } | null;
    projectSubmissions: { releaseId: string; status: string }[];
  },
  capstoneReleasesByScheduleId: Map<string, { id: string; project: { title: string } }[]>,
  scheduleIds: string[]
) {
  const missing: string[] = [];

  const requiredReleases = new Map<string, { id: string; project: { title: string } }>();
  for (const scheduleId of scheduleIds) {
    for (const release of capstoneReleasesByScheduleId.get(scheduleId) || []) {
      requiredReleases.set(release.id, release);
    }
  }

  if (requiredReleases.size === 0) {
    missing.push('Capstone project not yet assigned by the trainer');
  } else {
    for (const release of requiredReleases.values()) {
      const submission = student.projectSubmissions.find((s) => s.releaseId === release.id);
      if (!submission) {
        missing.push(`Capstone project "${release.project.title}" not yet submitted`);
      } else if (submission.status !== 'REVIEWED') {
        missing.push(`Capstone project "${release.project.title}" awaiting trainer review`);
      }
    }
  }

  if (!student.portfolio) {
    missing.push('Portfolio not yet submitted');
  } else if (student.portfolio.status !== 'APPROVED') {
    missing.push(student.portfolio.status === 'PENDING' ? 'Portfolio awaiting approval' : 'Portfolio was rejected — needs resubmission');
  }

  return { ready: missing.length === 0, missing };
}

// Interview-SLA: a pool student should have at least SLA_MIN_INTERVIEWS
// within SLA_WINDOW_DAYS of entering the pool (Student.movedToPlacementAt).
// "At risk" only fires once the window has actually elapsed — a student who
// entered the pool last week isn't behind yet just because they have 0
// interviews so far, they still have time.
function computeSlaStatus(movedToPlacementAt: Date | null, interviewCount: number) {
  if (!movedToPlacementAt) return { daysInPool: null, slaAtRisk: false };
  const daysInPool = Math.floor((Date.now() - movedToPlacementAt.getTime()) / (1000 * 60 * 60 * 24));
  const slaAtRisk = daysInPool >= SLA_WINDOW_DAYS && interviewCount < SLA_MIN_INTERVIEWS;
  return { daysInPool, slaAtRisk };
}

/** Fires the "you've been selected" email once a result transitions into
 * SELECTED. Company name prefers the linked drive's partner (source of
 * truth for drive-linked offers) and falls back to the manually-entered
 * companyName field for off-campus offers. Silently skipped if there's no
 * studentId or no real email on file — never throws into the caller. */
async function notifyOfferReceived(result: {
  studentId: string | null;
  studentName: string;
  package: number | null;
  designation: string | null;
  companyName: string | null;
  drive?: { partner: { name: string } } | null;
}) {
  if (!result.studentId) return;
  const student = await prisma.student.findUnique({ where: { id: result.studentId }, select: { email: true } });
  const email = student?.email;
  if (!hasRealEmail(email)) return;

  const companyName = result.drive?.partner.name || result.companyName || 'the company';
  const packageLabel = result.package ? `₹${result.package.toLocaleString('en-IN')} LPA` : null;

  emailService.send({
    to: email,
    subject: `Congratulations — You've Been Selected by ${companyName}!`,
    html: emailService.templates.placementOfferReceived({
      studentName: result.studentName,
      companyName,
      designation: result.designation,
      packageLabel,
    }),
    template: 'placement_offer_received',
  }).catch((err) => console.error('Placement offer-received email failed:', err));
}

const SOFTSKILL_TYPE_LABEL: Record<string, string> = {
  SOFTSKILL: 'Softskill', APTITUDE: 'Aptitude', SK_APT: 'Softskill & Aptitude',
};

async function notifySoftskillSession(
  session: { type: string; topic: string; startDate: Date; endDate: Date | null; trainerId: string | null },
  studentIds: string[],
) {
  if (!studentIds.length) return;
  const [students, trainer] = await Promise.all([
    prisma.student.findMany({ where: { id: { in: studentIds } }, select: { firstName: true, lastName: true, email: true } }),
    session.trainerId
      ? prisma.employee.findUnique({ where: { id: session.trainerId }, select: { firstName: true, lastName: true } })
      : Promise.resolve(null),
  ]);
  const trainerName = trainer ? `${trainer.firstName} ${trainer.lastName}` : undefined;
  const typeLabel = SOFTSKILL_TYPE_LABEL[session.type] || 'Softskill';
  const dateOpts: Intl.DateTimeFormatOptions = { day: '2-digit', month: 'short', year: 'numeric' };

  for (const s of students) {
    if (!hasRealEmail(s.email)) continue;
    emailService.send({
      to: s.email,
      cc: 'v7032vinsup@gmail.com',
      subject: `${typeLabel} session scheduled — ${session.topic}`,
      html: emailService.templates.softskillSessionScheduled({
        studentName: `${s.firstName} ${s.lastName}`,
        topic: session.topic,
        typeLabel,
        startDate: session.startDate.toLocaleDateString('en-IN', dateOpts),
        endDateLabel: session.endDate ? session.endDate.toLocaleDateString('en-IN', dateOpts) : null,
        trainerName,
      }),
      template: 'softskill_session_scheduled',
    }).catch((err) => console.error('Softskill session email failed:', err));
  }
}

export const placementsController = {
  async listPartners(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const partners = await prisma.hiringPartner.findMany({
        include: { _count: { select: { drives: true } } },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: partners });
    } catch (err) { next(err); }
  },

  async createPartner(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, industry, contactName, contactEmail, contactPhone, notes } = req.body;
      if (!name) throw new AppError('Name is required', 400);

      const partner = await prisma.hiringPartner.create({
        data: { name, industry, contactName, contactEmail, contactPhone, notes },
      });
      res.status(201).json({ success: true, data: partner });
    } catch (err) { next(err); }
  },

  async listDrives(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status, partnerId } = req.query;
      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (partnerId) where.partnerId = partnerId;

      const drives = await prisma.placementDrive.findMany({
        where,
        include: {
          partner: { select: { id: true, name: true, industry: true } },
          organizedBy: { select: employeeSelect },
          _count: { select: { results: true, interviews: true } },
        },
        orderBy: { driveDate: 'desc' },
      });

      // PlacementDrive has no back-relation declared to PlacementDriveCandidate
      // in schema.prisma, so it can't be counted via `_count.select`. Count it
      // separately via groupBy instead, keyed by driveId.
      const candidateCounts = await prisma.placementDriveCandidate.groupBy({
        by: ['driveId'],
        _count: { _all: true },
      });
      const candidateCountByDrive = new Map(candidateCounts.map((c) => [c.driveId, c._count._all]));

      const drivesWithCandidateCount = drives.map((d) => ({
        ...d,
        _count: { ...d._count, candidates: candidateCountByDrive.get(d.id) || 0 },
      }));

      res.json({ success: true, data: drivesWithCandidateCount });
    } catch (err) { next(err); }
  },

  async createDrive(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { partnerId, role, driveDate, organizedById, notes } = req.body;
      if (!partnerId || !role || !driveDate) throw new AppError('partnerId, role, and driveDate are required', 400);

      const drive = await prisma.placementDrive.create({
        data: { partnerId, role, driveDate: new Date(driveDate), organizedById, notes },
        include: { partner: true, organizedBy: { select: employeeSelect } },
      });
      res.status(201).json({ success: true, data: drive });
    } catch (err) { next(err); }
  },

  async updateDrive(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { role, driveDate, status, organizedById, notes } = req.body;
      const drive = await prisma.placementDrive.update({
        where: { id: req.params.id },
        data: {
          role, status, organizedById, notes,
          driveDate: driveDate ? new Date(driveDate) : undefined,
        },
      });
      res.json({ success: true, data: drive });
    } catch (err) { next(err); }
  },

  async listResults(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { driveId, studentId } = req.query;
      const where: Record<string, unknown> = {};
      if (driveId) where.driveId = driveId;
      if (studentId) where.studentId = studentId;

      const results = await prisma.placementResult.findMany({
        where,
        include: { drive: { include: { partner: true } } },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: results });
    } catch (err) { next(err); }
  },

  async createResult(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { driveId, studentId, studentName, result, package: pkg, designation, joiningDate, companyName } = req.body;
      if (!studentName) throw new AppError('studentName is required', 400);

      const file = req.file as Express.Multer.File | undefined;

      const placementResult = await prisma.placementResult.create({
        data: {
          driveId: driveId || undefined,
          studentId: studentId || undefined,
          studentName,
          result,
          package: pkg ? Number(pkg) : undefined,
          designation: designation || undefined,
          joiningDate: joiningDate ? new Date(joiningDate) : undefined,
          offerLetterUrl: file ? `/uploads/offer-letters/${file.filename}` : undefined,
          offerSentAt: file ? new Date() : undefined,
          // Only meaningful for off-campus offers — drive-linked ones resolve
          // the company from drive.partner.name instead (see schema comment).
          companyName: driveId ? undefined : (companyName || undefined),
        },
        include: { drive: { include: { partner: { select: { name: true } } } } },
      });

      // A SELECTED result with a studentId moves the student to PLACED.
      if (studentId && result === 'SELECTED') {
        await prisma.student.update({ where: { id: studentId }, data: { status: 'PLACED' } });
        await notifyOfferReceived(placementResult);
      }

      res.status(201).json({ success: true, data: placementResult });
    } catch (err) { next(err); }
  },

  async updateResult(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { result, package: pkg, designation, joiningDate, companyName } = req.body;
      const file = req.file as Express.Multer.File | undefined;

      const existing = await prisma.placementResult.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Result not found', 404);

      const updated = await prisma.placementResult.update({
        where: { id: req.params.id },
        data: {
          result: result || undefined,
          package: pkg !== undefined ? Number(pkg) : undefined,
          designation: designation || undefined,
          joiningDate: joiningDate ? new Date(joiningDate) : undefined,
          offerLetterUrl: file ? `/uploads/offer-letters/${file.filename}` : undefined,
          offerSentAt: file ? new Date() : undefined,
          companyName: existing.driveId ? undefined : (companyName || undefined),
        },
        include: { drive: { include: { partner: { select: { name: true } } } } },
      });

      // Only fire the "you're selected" email on the transition INTO
      // SELECTED — re-saving an already-SELECTED result (e.g. attaching the
      // offer letter afterward) shouldn't re-send it.
      if (existing.studentId && result === 'SELECTED' && existing.result !== 'SELECTED') {
        await prisma.student.update({ where: { id: existing.studentId }, data: { status: 'PLACED' } });
        await notifyOfferReceived(updated);
      }

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  /** Records whether the student actually accepted or declined a SELECTED offer. */
  async recordOfferResponse(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { offerStatus } = req.body;
      if (!['ACCEPTED', 'DECLINED', 'PENDING'].includes(offerStatus)) {
        throw new AppError('offerStatus must be ACCEPTED, DECLINED, or PENDING', 400);
      }
      const updated = await prisma.placementResult.update({
        where: { id: req.params.id },
        data: { offerStatus, offerRespondedAt: offerStatus === 'PENDING' ? null : new Date() },
      });
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  /**
   * Placement Pool — students the Production Manager has pushed in (status
   * IN_PLACEMENT). Splits students into "Ready for Placement" (capstone
   * project reviewed + portfolio approved) and "Not Yet Ready" (with an
   * explicit list of what's missing for each).
   */
  async pool(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { track, batchId, courseId, readiness } = req.query;
      const where: Record<string, unknown> = { status: 'IN_PLACEMENT' };
      if (track) where.track = track;
      if (batchId || courseId) {
        const scheduleWhere: Record<string, unknown> = {};
        if (batchId) scheduleWhere.batchId = String(batchId);
        if (courseId) scheduleWhere.courseId = String(courseId);
        where.enrollments = { some: { schedule: scheduleWhere } };
      }

      const students = await prisma.student.findMany({
        where,
        include: {
          enrollments: { include: { schedule: { include: { course: true, batch: true } } } },
          trainerFeedbacks: {
            include: { course: { select: { id: true, name: true } } },
            orderBy: { updatedAt: 'desc' },
          },
          portfolio: { select: { status: true, publicSlug: true } },
          projectSubmissions: {
            where: { release: { project: { isCapstone: true } } },
            select: { releaseId: true, status: true },
          },
        },
        orderBy: { movedToPlacementAt: 'desc' },
      });

      const allStudentIds = students.map((s) => s.id);

      // Interview summary per student: count + most-recent outcome
      const [interviewCounts, recentInterviews, selectedResults] = await Promise.all([
        prisma.placementInterview.groupBy({
          by: ['studentId'],
          where: { studentId: { in: allStudentIds } },
          _count: { _all: true },
        }),
        prisma.placementInterview.findMany({
          where: { studentId: { in: allStudentIds } },
          select: { studentId: true, outcome: true, scheduledAt: true },
          orderBy: { scheduledAt: 'desc' },
        }),
        // students who have at least one SELECTED result → "Placed"
        prisma.placementResult.findMany({
          where: { studentId: { in: allStudentIds }, result: 'SELECTED' },
          select: { id: true, studentId: true, package: true, designation: true, offerStatus: true },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      const interviewCountMap = new Map(interviewCounts.map((r) => [r.studentId, r._count._all]));
      // deduplicate — keep only the first (most recent) entry per student
      const lastOutcomeMap = new Map<string, string>();
      for (const iv of recentInterviews) {
        if (!lastOutcomeMap.has(iv.studentId)) lastOutcomeMap.set(iv.studentId, iv.outcome);
      }
      // keep only the most-recent SELECTED result per student — id/offerStatus
      // let the Pool UI record the accept/decline decision directly, without
      // needing to know which Drive (if any) the offer came from.
      const placedMap = new Map<string, { id: string; package: number | null; designation: string | null; offerStatus: string }>();
      for (const r of selectedResults) {
        if (!r.studentId) continue;
        if (!placedMap.has(r.studentId)) placedMap.set(r.studentId, { id: r.id, package: r.package, designation: r.designation, offerStatus: r.offerStatus });
      }

      const allScheduleIds = Array.from(
        new Set(students.flatMap((s) => s.enrollments.map((e) => e.schedule.id)))
      );

      const capstoneReleases = allScheduleIds.length
        ? await prisma.projectRelease.findMany({
            where: { scheduleId: { in: allScheduleIds }, project: { isCapstone: true } },
            select: { id: true, scheduleId: true, project: { select: { title: true } } },
          })
        : [];

      const capstoneReleasesByScheduleId = new Map<string, { id: string; project: { title: string } }[]>();
      for (const release of capstoneReleases) {
        const list = capstoneReleasesByScheduleId.get(release.scheduleId) || [];
        list.push({ id: release.id, project: release.project });
        capstoneReleasesByScheduleId.set(release.scheduleId, list);
      }

      const allWithReadiness = students.map((s) => {
        const scheduleIds = s.enrollments.map((e) => e.schedule.id);
        const { ready, missing } = computeReadiness(s, capstoneReleasesByScheduleId, scheduleIds);
        const interviewCount = interviewCountMap.get(s.id) || 0;
        return {
          ...s,
          placementReadiness: { ready, missing },
          interviewSummary: {
            count: interviewCount,
            lastOutcome: lastOutcomeMap.get(s.id) || null,
          },
          isPlaced: placedMap.has(s.id),
          placedInfo: placedMap.get(s.id) || null,
          sla: computeSlaStatus(s.movedToPlacementAt, interviewCount),
        };
      });

      let withReadiness = allWithReadiness;
      if (readiness === 'ready') withReadiness = withReadiness.filter((s) => s.placementReadiness.ready);
      if (readiness === 'not_ready') withReadiness = withReadiness.filter((s) => !s.placementReadiness.ready);
      if (readiness === 'placed') withReadiness = withReadiness.filter((s) => s.isPlaced);
      if (readiness === 'sla_at_risk') withReadiness = withReadiness.filter((s) => s.sla.slaAtRisk);

      res.json({
        success: true,
        data: withReadiness,
        total: withReadiness.length,
        readyCount: allWithReadiness.filter((s) => s.placementReadiness.ready).length,
        slaAtRiskCount: allWithReadiness.filter((s) => s.sla.slaAtRisk).length,
      });
    } catch (err) { next(err); }
  },

  /**
   * Bulk-push students into the Placement Pool from an uploaded list of
   * student codes (e.g. an Excel sheet with a studentCode column) — the same
   * status/movedToPlacementAt flip as Production's "Push Sub-batch to
   * Placements" and the trainer's one-at-a-time push, just keyed by
   * studentCode instead of scheduleId/studentId since that's what's visible
   * to whoever is preparing the spreadsheet. Returns a per-row outcome so the
   * uploader can see exactly what happened to each code.
   */
  async bulkPushToPool(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { studentCodes } = req.body;
      if (!Array.isArray(studentCodes) || !studentCodes.length) {
        throw new AppError('studentCodes (non-empty array) is required', 400);
      }
      const codes = Array.from(new Set(studentCodes.map((c) => String(c).trim()).filter(Boolean)));
      if (!codes.length) throw new AppError('No valid student codes found in the upload', 400);

      const students = await prisma.student.findMany({
        where: { studentCode: { in: codes } },
        select: { id: true, studentCode: true, firstName: true, lastName: true, status: true, track: true, movedToPlacementAt: true },
      });
      const byCode = new Map(students.map((s) => [s.studentCode, s]));

      type RowResult = { studentCode: string; outcome: 'pushed' | 'already_in_pool' | 'skipped' | 'not_found'; studentName?: string; message?: string };
      const results: RowResult[] = [];
      const needsClockStart: string[] = [];
      const alreadyClocked: string[] = [];

      for (const code of codes) {
        const s = byCode.get(code);
        if (!s) { results.push({ studentCode: code, outcome: 'not_found', message: 'No student with this code' }); continue; }
        const studentName = `${s.firstName} ${s.lastName}`;
        // JRP is course-only, non-placement — only IOP/PAP students may ever
        // be moved into the Placement Pool.
        if (s.track === 'JRP') {
          results.push({ studentCode: code, outcome: 'skipped', studentName, message: 'JRP students cannot be pushed to Placements' });
          continue;
        }
        if (s.status === 'PLACED' || s.status === 'BATCH_TRANSFER') {
          results.push({ studentCode: code, outcome: 'skipped', studentName, message: `Currently ${s.status} — not moved` });
          continue;
        }
        if (s.status === 'IN_PLACEMENT') {
          results.push({ studentCode: code, outcome: 'already_in_pool', studentName });
          continue;
        }
        if (s.movedToPlacementAt) alreadyClocked.push(s.id); else needsClockStart.push(s.id);
        results.push({ studentCode: code, outcome: 'pushed', studentName });
      }

      const now = new Date();
      await prisma.$transaction([
        ...(needsClockStart.length
          ? [prisma.student.updateMany({ where: { id: { in: needsClockStart } }, data: { status: 'IN_PLACEMENT', movedToPlacementAt: now } })]
          : []),
        ...(alreadyClocked.length
          ? [prisma.student.updateMany({ where: { id: { in: alreadyClocked } }, data: { status: 'IN_PLACEMENT' } })]
          : []),
      ]);

      res.json({
        success: true,
        data: { results, pushed: needsClockStart.length + alreadyClocked.length, total: codes.length },
      });
    } catch (err) { next(err); }
  },

  /**
   * Lightweight option lists for the Pool filters (Course / Batch dropdowns).
   * Scoped under PLACEMENTS so non-Production users can populate filters
   * without needing PRODUCTION_TRAINING access.
   */
  async listFilterOptions(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const [courses, batches, schedules] = await Promise.all([
        prisma.academyCourse.findMany({
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        prisma.batch.findMany({
          select: { id: true, code: true },
          orderBy: { code: 'asc' },
        }),
        // Sub-batches with an active-student count — used by the Softskill/
        // Aptitude "New Session" roster picker so Placements-only users (who
        // don't have PRODUCTION_TRAINING access) can still pick a sub-batch's
        // students without hitting /api/production/batches.
        prisma.batchCourseSchedule.findMany({
          select: {
            id: true, code: true, timing: true,
            batch: { select: { code: true } },
            course: { select: { name: true } },
            _count: { select: { enrollments: { where: { status: 'ACTIVE' } } } },
          },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      res.json({
        success: true,
        data: {
          courses, batches,
          schedules: schedules.map((s) => ({
            id: s.id, code: s.code, timing: s.timing,
            batchCode: s.batch.code, courseName: s.course.name,
            activeStudentCount: s._count.enrollments,
          })),
        },
      });
    } catch (err) { next(err); }
  },

  /**
   * Placements Reports — month-scoped KPIs (total students in pool, ready,
   * not ready, 1st interview given, placed, drives this month) plus a
   * batch-wise breakdown. Reuses the same readiness logic as pool().
   */
  async reports(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const monthParam = String(req.query.month || '');
      const now = new Date();
      let year = now.getFullYear();
      let monthIdx = now.getMonth();
      if (/^\d{4}-\d{2}$/.test(monthParam)) {
        const [y, m] = monthParam.split('-').map(Number);
        year = y;
        monthIdx = m - 1;
      }
      const monthStart = new Date(year, monthIdx, 1);
      const monthEnd = new Date(year, monthIdx + 1, 1);
      const monthLabel = `${year}-${String(monthIdx + 1).padStart(2, '0')}`;

      const students = await prisma.student.findMany({
        where: { status: { in: ['IN_PLACEMENT', 'PLACED'] } },
        include: {
          enrollments: { include: { schedule: { include: { course: true, batch: true } } } },
          portfolio: { select: { status: true } },
          projectSubmissions: {
            where: { release: { project: { isCapstone: true } } },
            select: { releaseId: true, status: true },
          },
          _count: { select: { interviews: true } },
        },
      });

      const allScheduleIds = Array.from(
        new Set(students.flatMap((s) => s.enrollments.map((e) => e.schedule.id)))
      );

      const capstoneReleases = allScheduleIds.length
        ? await prisma.projectRelease.findMany({
            where: { scheduleId: { in: allScheduleIds }, project: { isCapstone: true } },
            select: { id: true, scheduleId: true, project: { select: { title: true } } },
          })
        : [];

      const capstoneReleasesByScheduleId = new Map<string, { id: string; project: { title: string } }[]>();
      for (const release of capstoneReleases) {
        const list = capstoneReleasesByScheduleId.get(release.scheduleId) || [];
        list.push({ id: release.id, project: release.project });
        capstoneReleasesByScheduleId.set(release.scheduleId, list);
      }

      const withReady = students.map((s) => {
        const scheduleIds = s.enrollments.map((e) => e.schedule.id);
        const { ready } = computeReadiness(s, capstoneReleasesByScheduleId, scheduleIds);
        return { ...s, ready };
      });

      const totalStudents = withReady.length;
      const readyCount = withReady.filter((s) => s.ready).length;
      const notReadyCount = totalStudents - readyCount;
      const placedCount = withReady.filter((s) => s.status === 'PLACED').length;
      const firstInterviewGivenCount = withReady.filter((s) => (s._count?.interviews || 0) >= 1).length;
      const slaAtRiskCount = withReady.filter((s) => computeSlaStatus(s.movedToPlacementAt, s._count?.interviews || 0).slaAtRisk).length;

      const [drivesThisMonth, drivesThisMonthByStatusRaw] = await Promise.all([
        prisma.placementDrive.count({ where: { driveDate: { gte: monthStart, lt: monthEnd } } }),
        prisma.placementDrive.groupBy({
          by: ['status'],
          where: { driveDate: { gte: monthStart, lt: monthEnd } },
          _count: { _all: true },
        }),
      ]);
      const drivesThisMonthByStatus = Object.fromEntries(
        drivesThisMonthByStatusRaw.map((r) => [r.status, r._count._all])
      );

      // Batch-wise breakdown — a student with multiple sub-batch enrollments
      // is counted once per distinct Batch code (mirrors the Pool table's
      // existing "Batch · Course" display, just grouped by Batch).
      const byBatchMap = new Map<string, { batchCode: string; total: number; ready: number; notReady: number; placed: number; firstInterviewGiven: number }>();
      for (const s of withReady) {
        const batchCodes = Array.from(new Set(s.enrollments.map((e) => e.schedule.batch.code)));
        const codes = batchCodes.length ? batchCodes : ['Unassigned'];
        for (const code of codes) {
          const entry = byBatchMap.get(code) || { batchCode: code, total: 0, ready: 0, notReady: 0, placed: 0, firstInterviewGiven: 0 };
          entry.total += 1;
          if (s.ready) entry.ready += 1; else entry.notReady += 1;
          if (s.status === 'PLACED') entry.placed += 1;
          if ((s._count?.interviews || 0) >= 1) entry.firstInterviewGiven += 1;
          byBatchMap.set(code, entry);
        }
      }
      const byBatch = Array.from(byBatchMap.values()).sort((a, b) => a.batchCode.localeCompare(b.batchCode));

      res.json({
        success: true,
        data: {
          month: monthLabel,
          totals: {
            totalStudents,
            readyCount,
            notReadyCount,
            firstInterviewGivenCount,
            placedCount,
            drivesThisMonth,
            slaAtRiskCount,
          },
          drivesThisMonthByStatus,
          byBatch,
        },
      });
    } catch (err) { next(err); }
  },

  /**
   * Placements Analytics — placement rate, the shortlisted → interviewed →
   * selected conversion funnel, package distribution, and a monthly
   * placements trend. ADMIN-only (cross-cohort aggregate view), separate
   * from the operational month-scoped `reports` above.
   */
  async analytics(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const monthsBack = Math.max(1, Math.min(24, Number(req.query.months) || 6));
      const now = new Date();
      const trendStart = new Date(now.getFullYear(), now.getMonth() - (monthsBack - 1), 1);

      const [poolCount, placedCount, shortlisted, interviewed, selectedResults, offerResponses] = await Promise.all([
        prisma.student.count({ where: { status: { in: ['IN_PLACEMENT', 'PLACED'] } } }),
        prisma.student.count({ where: { status: 'PLACED' } }),
        prisma.placementDriveCandidate.findMany({ select: { studentId: true }, distinct: ['studentId'] }),
        prisma.placementInterview.findMany({ select: { studentId: true }, distinct: ['studentId'] }),
        prisma.placementResult.findMany({
          where: { result: 'SELECTED' },
          select: { studentId: true, package: true, createdAt: true, offerStatus: true },
        }),
        prisma.placementResult.groupBy({
          by: ['offerStatus'],
          where: { result: 'SELECTED' },
          _count: { _all: true },
        }),
      ]);

      const selectedStudentIds = new Set(selectedResults.filter((r) => r.studentId).map((r) => r.studentId as string));

      const funnel = {
        shortlisted: shortlisted.length,
        interviewed: interviewed.length,
        selected: selectedStudentIds.size,
      };

      const packages = selectedResults
        .map((r) => r.package)
        .filter((p): p is number => p !== null && p !== undefined)
        .sort((a, b) => a - b);
      const sum = packages.reduce((s, p) => s + p, 0);
      const packageDistribution = packages.length
        ? {
            min: packages[0],
            max: packages[packages.length - 1],
            avg: Math.round((sum / packages.length) * 100) / 100,
            median: packages.length % 2 === 0
              ? Math.round(((packages[packages.length / 2 - 1] + packages[packages.length / 2]) / 2) * 100) / 100
              : packages[Math.floor(packages.length / 2)],
            count: packages.length,
          }
        : null;

      // Monthly trend — every month in the window gets an entry, even 0.
      const trendMap = new Map<string, number>();
      for (let i = 0; i < monthsBack; i++) {
        const d = new Date(trendStart.getFullYear(), trendStart.getMonth() + i, 1);
        trendMap.set(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, 0);
      }
      for (const r of selectedResults) {
        if (r.createdAt < trendStart) continue;
        const key = `${r.createdAt.getFullYear()}-${String(r.createdAt.getMonth() + 1).padStart(2, '0')}`;
        if (trendMap.has(key)) trendMap.set(key, (trendMap.get(key) || 0) + 1);
      }
      const trend = Array.from(trendMap.entries()).map(([month, placements]) => ({ month, placements }));

      res.json({
        success: true,
        data: {
          placementRate: poolCount ? Math.round((placedCount / poolCount) * 1000) / 10 : 0,
          poolCount,
          placedCount,
          funnel,
          packageDistribution,
          offerResponseBreakdown: Object.fromEntries(offerResponses.map((r) => [r.offerStatus, r._count._all])),
          trend,
        },
      });
    } catch (err) { next(err); }
  },

  async stats(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const [totalPartners, upcomingDrives, totalPlaced, avgPackage] = await Promise.all([
        prisma.hiringPartner.count(),
        prisma.placementDrive.count({ where: { status: 'SCHEDULED', driveDate: { gte: new Date() } } }),
        prisma.placementResult.count({ where: { result: 'SELECTED' } }),
        prisma.placementResult.aggregate({ _avg: { package: true }, where: { result: 'SELECTED' } }),
      ]);

      res.json({
        success: true,
        data: {
          totalPartners,
          upcomingDrives,
          totalPlaced,
          avgPackage: avgPackage._avg.package || 0,
        },
      });
    } catch (err) { next(err); }
  },

  // ── Softskill / Aptitude sessions ───────────────────────────────────────
  async listSoftskillSessions(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { type } = req.query;
      const where: Record<string, unknown> = {};
      if (type) where.type = type;

      const sessions = await prisma.softskillSession.findMany({
        where,
        include: {
          trainer: { select: employeeSelect },
          _count: { select: { attendances: true } },
        },
        orderBy: { startDate: 'desc' },
      });
      res.json({ success: true, data: sessions });
    } catch (err) { next(err); }
  },

  /**
   * Creates a session and, in the same call, seeds its student roster from an
   * uploaded list of student codes (e.g. an Excel sheet with a studentCode
   * column) — same input shape as bulkPushToPool, since that's what
   * Placements-team users have on hand rather than internal schedule/student
   * ids. scheduleIds/studentIds are still accepted for backward compatibility
   * but the frontend no longer offers a sub-batch picker. Seeded as
   * SoftskillAttendance rows with present:false — that roster IS the
   * attendance list from then on (see getSoftskillAttendance), and everyone
   * in it gets an email now. Unresolved codes are reported back, not thrown,
   * so a typo in one row doesn't block creating the session.
   */
  async createSoftskillSession(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { type, topic, startDate, endDate, trainerId, notes, scheduleIds, studentIds, studentCodes } = req.body;
      if (!type || !topic || !startDate) throw new AppError('type, topic, and startDate are required', 400);

      const rosterIds = new Set<string>(Array.isArray(studentIds) ? studentIds : []);
      if (Array.isArray(scheduleIds) && scheduleIds.length) {
        const enrollments = await prisma.studentBatchEnrollment.findMany({
          where: { scheduleId: { in: scheduleIds }, status: 'ACTIVE' },
          select: { studentId: true },
        });
        for (const e of enrollments) rosterIds.add(e.studentId);
      }
      const notFoundCodes: string[] = [];
      if (Array.isArray(studentCodes) && studentCodes.length) {
        const codes = Array.from(new Set(studentCodes.map((c: string) => String(c).trim()).filter(Boolean)));
        const matched = await prisma.student.findMany({ where: { studentCode: { in: codes } }, select: { id: true, studentCode: true } });
        const byCode = new Set(matched.map((s) => s.studentCode));
        for (const code of codes) { if (byCode.has(code)) { /* resolved below */ } else notFoundCodes.push(code); }
        for (const s of matched) rosterIds.add(s.id);
      }

      const session = await prisma.softskillSession.create({
        data: {
          type, topic,
          startDate: new Date(startDate),
          endDate: endDate ? new Date(endDate) : undefined,
          trainerId: trainerId || undefined,
          notes,
        },
      });

      if (rosterIds.size) {
        await prisma.softskillAttendance.createMany({
          data: Array.from(rosterIds).map((studentId) => ({ sessionId: session.id, studentId, present: false })),
          skipDuplicates: true,
        });
        notifySoftskillSession(session, Array.from(rosterIds)).catch((err) => console.error('notifySoftskillSession failed:', err));
      }

      res.status(201).json({ success: true, data: { ...session, rosterCount: rosterIds.size, notFoundCodes } });
    } catch (err) { next(err); }
  },

  /** Adds more students to an existing session's roster by student code (Excel upload, same shape as bulkPushToPool) — only the newly-added ones get the email, not the whole roster again. */
  async addStudentsToSession(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { scheduleIds, studentIds, studentCodes } = req.body;
      const sessionId = req.params.id;
      const session = await prisma.softskillSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new AppError('Session not found', 404);

      const candidateIds = new Set<string>(Array.isArray(studentIds) ? studentIds : []);
      if (Array.isArray(scheduleIds) && scheduleIds.length) {
        const enrollments = await prisma.studentBatchEnrollment.findMany({
          where: { scheduleId: { in: scheduleIds }, status: 'ACTIVE' },
          select: { studentId: true },
        });
        for (const e of enrollments) candidateIds.add(e.studentId);
      }
      const notFoundCodes: string[] = [];
      if (Array.isArray(studentCodes) && studentCodes.length) {
        const codes = Array.from(new Set(studentCodes.map((c: string) => String(c).trim()).filter(Boolean)));
        const matched = await prisma.student.findMany({ where: { studentCode: { in: codes } }, select: { id: true, studentCode: true } });
        const byCode = new Set(matched.map((s) => s.studentCode));
        for (const code of codes) { if (!byCode.has(code)) notFoundCodes.push(code); }
        for (const s of matched) candidateIds.add(s.id);
      }
      if (!candidateIds.size) throw new AppError('No students to add — check the student codes and try again', 400);

      const existing = await prisma.softskillAttendance.findMany({
        where: { sessionId, studentId: { in: Array.from(candidateIds) } },
        select: { studentId: true },
      });
      const existingIds = new Set(existing.map((e) => e.studentId));
      const toAdd = Array.from(candidateIds).filter((id) => !existingIds.has(id));

      if (toAdd.length) {
        await prisma.softskillAttendance.createMany({
          data: toAdd.map((studentId) => ({ sessionId, studentId, present: false })),
          skipDuplicates: true,
        });
        notifySoftskillSession(session, toAdd).catch((err) => console.error('notifySoftskillSession failed:', err));
      }

      res.status(201).json({ success: true, data: { added: toAdd.length, alreadyIn: existingIds.size, notFoundCodes } });
    } catch (err) { next(err); }
  },

  /**
   * Roster + attendance status for one calendar day within the session's
   * date range — mirrors the course attendance pattern (schedules/:id/attendance?date=).
   * Roster membership itself still comes from SoftskillAttendance (unchanged);
   * this only reads/writes the per-day mark in SoftskillAttendanceDay.
   */
  async getSoftskillAttendance(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const sessionId = req.params.id;
      const { date } = req.query;
      if (!date) throw new AppError('date query param is required (YYYY-MM-DD)', 400);
      const day = new Date(String(date));
      const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());

      const [roster, marked] = await Promise.all([
        prisma.softskillAttendance.findMany({
          where: { sessionId },
          include: { student: { select: { id: true, firstName: true, lastName: true, studentCode: true } } },
        }),
        prisma.softskillAttendanceDay.findMany({ where: { sessionId, date: dayStart } }),
      ]);
      const byStudent = new Map(marked.map((m) => [m.studentId, m]));
      const data = roster.map((r) => ({
        student: r.student,
        status: byStudent.get(r.studentId)?.status ?? null,
        score: byStudent.get(r.studentId)?.score ?? null,
        remarks: byStudent.get(r.studentId)?.remarks ?? null,
      }));
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },

  // Bulk upsert attendance for a session + date: body.date, body.records = [{ studentId, status, score, remarks }]
  async markSoftskillAttendance(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const sessionId = req.params.id;
      const { date, records } = req.body as { date: string; records: { studentId: string; status: 'PRESENT' | 'ABSENT' | 'LATE'; score?: number; remarks?: string }[] };
      if (!date || !Array.isArray(records) || !records.length) throw new AppError('date and a non-empty records array are required', 400);
      const day = new Date(String(date));
      const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());

      const results = await prisma.$transaction(
        records.map((entry) =>
          prisma.softskillAttendanceDay.upsert({
            where: { sessionId_studentId_date: { sessionId, studentId: entry.studentId, date: dayStart } },
            create: {
              sessionId,
              studentId: entry.studentId,
              date: dayStart,
              status: entry.status,
              score: entry.score !== undefined ? Number(entry.score) : undefined,
              remarks: entry.remarks,
              markedById: req.user?.employeeId || undefined,
            },
            update: {
              status: entry.status,
              score: entry.score !== undefined ? Number(entry.score) : undefined,
              remarks: entry.remarks,
              markedById: req.user?.employeeId || undefined,
            },
          })
        )
      );
      res.json({ success: true, data: results });
    } catch (err) { next(err); }
  },

  // ── Drive candidate shortlist ────────────────────────────────────────────
  async listDriveCandidates(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { driveId } = req.query;
      const where: Record<string, unknown> = {};
      if (driveId) where.driveId = driveId;

      const candidates = await prisma.placementDriveCandidate.findMany({
        where,
        include: {
          student: { select: { id: true, firstName: true, lastName: true, studentCode: true, track: true } },
          addedBy: { select: employeeSelect },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: candidates });
    } catch (err) { next(err); }
  },

  async addDriveCandidate(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { driveId, studentId, notes } = req.body;
      if (!driveId || !studentId) throw new AppError('driveId and studentId are required', 400);

      const candidate = await prisma.placementDriveCandidate.create({
        data: { driveId, studentId, notes, addedById: req.user?.employeeId || undefined },
        include: {
          student: { select: { id: true, firstName: true, lastName: true, studentCode: true, email: true } },
          drive: { include: { partner: { select: { name: true } } } },
        },
      });

      const student = candidate.student;
      if (hasRealEmail(student.email)) {
        emailService.send({
          to: student.email,
          subject: `You've been shortlisted — ${candidate.drive.partner.name}`,
          html: emailService.templates.placementShortlisted({
            studentName: `${student.firstName} ${student.lastName}`,
            companyName: candidate.drive.partner.name,
            role: candidate.drive.role,
            driveDate: candidate.drive.driveDate.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }),
          }),
          template: 'placement_shortlisted',
        }).catch((err) => console.error('Placement shortlist email failed:', err));
      }

      res.status(201).json({ success: true, data: candidate });
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === 'P2002') {
        return next(new AppError('This student is already shortlisted for this drive', 409));
      }
      next(err);
    }
  },

  async updateDriveCandidate(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status, notes } = req.body;
      const candidate = await prisma.placementDriveCandidate.update({
        where: { id: req.params.id },
        data: { status, notes },
      });
      res.json({ success: true, data: candidate });
    } catch (err) { next(err); }
  },

  // ── Interviews ────────────────────────────────────────────────────────────
  async listInterviews(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { studentId, driveId } = req.query;
      const where: Record<string, unknown> = {};
      if (studentId) where.studentId = studentId;
      if (driveId) where.driveId = driveId;

      const interviews = await prisma.placementInterview.findMany({
        where,
        include: {
          drive: { include: { partner: { select: { id: true, name: true } } } },
          feedbackGivenBy: { select: employeeSelect },
          student: { select: { id: true, firstName: true, lastName: true, studentCode: true } },
        },
        orderBy: { scheduledAt: 'desc' },
      });
      res.json({ success: true, data: interviews });
    } catch (err) { next(err); }
  },

  async createInterview(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const {
        studentId, driveId, companyName, interviewerName, scheduledAt, round,
        outcome, feedback, rating, notes, feedbackGivenById,
      } = req.body;
      if (!studentId || !scheduledAt) {
        throw new AppError('studentId and scheduledAt are required', 400);
      }
      const resolvedOutcome = outcome || 'SCHEDULED';
      const interview = await prisma.placementInterview.create({
        data: {
          studentId,
          driveId: driveId || null,
          companyName: companyName || null,
          interviewerName: interviewerName || null,
          scheduledAt: new Date(scheduledAt),
          round: round ? Number(round) : 1,
          outcome: resolvedOutcome,
          feedback: feedback || null,
          rating: rating ? Number(rating) : null,
          notes: notes || null,
          feedbackGivenById: feedbackGivenById || null,
        },
        include: {
          drive: { include: { partner: { select: { id: true, name: true } } } },
          feedbackGivenBy: { select: employeeSelect },
          student: { select: { id: true, firstName: true, lastName: true, studentCode: true, email: true } },
        },
      });

      // Only notify when it's actually still upcoming — a backfilled/past
      // interview logged with a final outcome shouldn't trigger a "you have
      // an interview coming up" email.
      if (resolvedOutcome === 'SCHEDULED' && hasRealEmail(interview.student.email)) {
        emailService.send({
          to: interview.student.email,
          subject: `Interview Scheduled — ${interview.companyName || interview.drive?.partner.name || 'Placement'}`,
          html: emailService.templates.placementInterviewScheduled({
            studentName: `${interview.student.firstName} ${interview.student.lastName}`,
            companyName: interview.companyName || interview.drive?.partner.name || '',
            round: interview.round,
            scheduledAt: interview.scheduledAt.toLocaleString('en-IN', { dateStyle: 'long', timeStyle: 'short' }),
            interviewerName: interview.interviewerName,
          }),
          template: 'placement_interview_scheduled',
        }).catch((err) => console.error('Placement interview-scheduled email failed:', err));
      }

      res.status(201).json({ success: true, data: interview });
    } catch (err) { next(err); }
  },

  async updateInterview(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const {
        companyName, interviewerName, scheduledAt, round,
        outcome, feedback, rating, notes, feedbackGivenById, driveId,
      } = req.body;
      const interview = await prisma.placementInterview.update({
        where: { id },
        data: {
          ...(companyName !== undefined && { companyName }),
          ...(interviewerName !== undefined && { interviewerName }),
          ...(scheduledAt && { scheduledAt: new Date(scheduledAt) }),
          ...(round !== undefined && { round: Number(round) }),
          ...(outcome && { outcome }),
          ...(feedback !== undefined && { feedback }),
          ...(rating !== undefined && { rating: rating !== null ? Number(rating) : null }),
          ...(notes !== undefined && { notes }),
          ...(feedbackGivenById !== undefined && { feedbackGivenById: feedbackGivenById || null }),
          ...(driveId !== undefined && { driveId: driveId || null }),
        },
        include: {
          drive: { include: { partner: { select: { id: true, name: true } } } },
          feedbackGivenBy: { select: employeeSelect },
          student: { select: { id: true, firstName: true, lastName: true, studentCode: true } },
        },
      });
      res.json({ success: true, data: interview });
    } catch (err) { next(err); }
  },

  // ── Full student profile for placement team (no student-portal gate) ────────
  async getStudentProfile(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;

      const student = await prisma.student.findUnique({
        where: { id },
        include: {
          portfolio: true,
          user: { select: { email: true, lastLoginAt: true } },
        },
      });
      if (!student) throw new AppError('Student not found', 404);

      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { studentId: id },
        include: { schedule: { include: { course: { select: { id: true, name: true } }, batch: { select: { code: true } } } } },
      });

      const [interviews, results, trainerFeedbacks] = await Promise.all([
        prisma.placementInterview.findMany({
          where: { studentId: id },
          include: {
            drive: { include: { partner: { select: { id: true, name: true } } } },
            feedbackGivenBy: { select: employeeSelect },
          },
          orderBy: { scheduledAt: 'desc' },
        }),
        prisma.placementResult.findMany({
          where: { studentId: id },
          include: { drive: { include: { partner: { select: { id: true, name: true } } } } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.trainerFeedback.findMany({
          where: { studentId: id },
          include: { trainer: { select: employeeSelect }, course: { select: { id: true, name: true } } },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      // Rank card per enrollment — mirrors studentPortal.controller rankCard logic
      const rankCards = await Promise.all(
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
          // Online (self-administered) test scores count toward marks/rank too —
          // previously only offline ModuleMark entries were counted here.
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

          const myIndex = ranked.findIndex((r) => r.id === id);
          const myTotals = totalsByStudent.get(id) ?? { obtained: 0, max: 0 };
          const classAverage = ranked.length ? ranked.reduce((s, r) => s + r.pct, 0) / ranked.length : 0;

          const projectSubmissions = await prisma.projectSubmission.findMany({
            where: { studentId: id, release: { scheduleId } },
            include: {
              release: { include: { project: { select: { title: true, isCapstone: true, module: { select: { title: true } } } } } },
            },
            orderBy: { submittedAt: 'desc' },
          });

          const moduleFeedback = await prisma.moduleFeedback.findMany({
            where: { studentId: id, scheduleId },
            include: {
              module: { select: { title: true, order: true } },
              trainer: { select: { firstName: true, lastName: true } },
            },
            orderBy: { updatedAt: 'desc' },
          });

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
            projects: projectSubmissions.map((s) => ({
              id: s.id,
              projectTitle: s.release.project.title,
              moduleTitle: s.release.project.module.title,
              isCapstone: s.release.project.isCapstone,
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
              order: f.module.order,
              rating: f.rating,
              comments: f.comments,
              trainerName: f.trainer ? `${f.trainer.firstName} ${f.trainer.lastName}` : null,
              updatedAt: f.updatedAt,
            })),
          };
        })
      );

      res.json({
        success: true,
        data: {
          student: { ...student, enrollments, trainerFeedbacks },
          interviews,
          results,
          rankCard: rankCards,
        },
      });
    } catch (err) { next(err); }
  },
};
