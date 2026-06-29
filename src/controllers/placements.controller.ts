import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };

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
      const { driveId, studentId, studentName, result, package: pkg, designation, joiningDate } = req.body;
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
        },
      });

      // A SELECTED result with a studentId moves the student to PLACED.
      if (studentId && result === 'SELECTED') {
        await prisma.student.update({ where: { id: studentId }, data: { status: 'PLACED' } });
      }

      res.status(201).json({ success: true, data: placementResult });
    } catch (err) { next(err); }
  },

  async updateResult(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { result, package: pkg, designation, joiningDate } = req.body;
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
        },
      });

      if (existing.studentId && result === 'SELECTED') {
        await prisma.student.update({ where: { id: existing.studentId }, data: { status: 'PLACED' } });
      }

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
          select: { studentId: true, package: true, designation: true },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      const interviewCountMap = new Map(interviewCounts.map((r) => [r.studentId, r._count._all]));
      // deduplicate — keep only the first (most recent) entry per student
      const lastOutcomeMap = new Map<string, string>();
      for (const iv of recentInterviews) {
        if (!lastOutcomeMap.has(iv.studentId)) lastOutcomeMap.set(iv.studentId, iv.outcome);
      }
      // keep only the most-recent SELECTED result per student
      const placedMap = new Map<string, { package: number | null; designation: string | null }>();
      for (const r of selectedResults) {
        if (!r.studentId) continue;
        if (!placedMap.has(r.studentId)) placedMap.set(r.studentId, { package: r.package, designation: r.designation });
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

      let withReadiness = students.map((s) => {
        const scheduleIds = s.enrollments.map((e) => e.schedule.id);
        const { ready, missing } = computeReadiness(s, capstoneReleasesByScheduleId, scheduleIds);
        return {
          ...s,
          placementReadiness: { ready, missing },
          interviewSummary: {
            count: interviewCountMap.get(s.id) || 0,
            lastOutcome: lastOutcomeMap.get(s.id) || null,
          },
          isPlaced: placedMap.has(s.id),
          placedInfo: placedMap.get(s.id) || null,
        };
      });

      if (readiness === 'ready') withReadiness = withReadiness.filter((s) => s.placementReadiness.ready);
      if (readiness === 'not_ready') withReadiness = withReadiness.filter((s) => !s.placementReadiness.ready);
      if (readiness === 'placed') withReadiness = withReadiness.filter((s) => s.isPlaced);

      res.json({
        success: true,
        data: withReadiness,
        total: withReadiness.length,
        readyCount: students.filter((s) => {
          const scheduleIds = s.enrollments.map((e) => e.schedule.id);
          return computeReadiness(s, capstoneReleasesByScheduleId, scheduleIds).ready;
        }).length,
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
      const [courses, batches] = await Promise.all([
        prisma.academyCourse.findMany({
          select: { id: true, name: true },
          orderBy: { name: 'asc' },
        }),
        prisma.batch.findMany({
          select: { id: true, code: true },
          orderBy: { code: 'asc' },
        }),
      ]);
      res.json({ success: true, data: { courses, batches } });
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
          },
          drivesThisMonthByStatus,
          byBatch,
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
        orderBy: { sessionDate: 'desc' },
      });
      res.json({ success: true, data: sessions });
    } catch (err) { next(err); }
  },

  async createSoftskillSession(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { type, topic, sessionDate, trainerId, notes } = req.body;
      if (!type || !topic || !sessionDate) throw new AppError('type, topic, and sessionDate are required', 400);

      const session = await prisma.softskillSession.create({
        data: { type, topic, sessionDate: new Date(sessionDate), trainerId: trainerId || undefined, notes },
      });
      res.status(201).json({ success: true, data: session });
    } catch (err) { next(err); }
  },

  async getSoftskillAttendance(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const attendances = await prisma.softskillAttendance.findMany({
        where: { sessionId: req.params.id },
        include: { student: { select: { id: true, firstName: true, lastName: true, studentCode: true } } },
      });
      res.json({ success: true, data: attendances });
    } catch (err) { next(err); }
  },

  // Bulk upsert attendance for a session: body.entries = [{ studentId, present, score, remarks }]
  async markSoftskillAttendance(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { entries } = req.body as { entries: { studentId: string; present: boolean; score?: number; remarks?: string }[] };
      if (!Array.isArray(entries) || entries.length === 0) throw new AppError('entries array is required', 400);

      const sessionId = req.params.id;
      const results = await prisma.$transaction(
        entries.map((entry) =>
          prisma.softskillAttendance.upsert({
            where: { sessionId_studentId: { sessionId, studentId: entry.studentId } },
            create: {
              sessionId,
              studentId: entry.studentId,
              present: entry.present,
              score: entry.score !== undefined ? Number(entry.score) : undefined,
              remarks: entry.remarks,
            },
            update: {
              present: entry.present,
              score: entry.score !== undefined ? Number(entry.score) : undefined,
              remarks: entry.remarks,
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
        include: { student: { select: { id: true, firstName: true, lastName: true, studentCode: true } } },
      });
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
      const interview = await prisma.placementInterview.create({
        data: {
          studentId,
          driveId: driveId || null,
          companyName: companyName || null,
          interviewerName: interviewerName || null,
          scheduledAt: new Date(scheduledAt),
          round: round ? Number(round) : 1,
          outcome: outcome || 'SCHEDULED',
          feedback: feedback || null,
          rating: rating ? Number(rating) : null,
          notes: notes || null,
          feedbackGivenById: feedbackGivenById || null,
        },
        include: {
          drive: { include: { partner: { select: { id: true, name: true } } } },
          feedbackGivenBy: { select: employeeSelect },
          student: { select: { id: true, firstName: true, lastName: true, studentCode: true } },
        },
      });
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
        include: { schedule: { include: { course: { select: { id: true, name: true } } } } },
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
          orderBy: { createdAt: 'desc' },
        }),
        prisma.trainerFeedback.findMany({
          where: { studentId: id },
          include: { trainer: { select: employeeSelect } },
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

          const ranked = Array.from(totalsByStudent.entries())
            .map(([sid, t]) => ({ id: sid, pct: t.max ? (t.obtained / t.max) * 100 : 0 }))
            .sort((a, b) => b.pct - a.pct);

          const myIndex = ranked.findIndex((r) => r.id === id);
          const myTotals = totalsByStudent.get(id) ?? { obtained: 0, max: 0 };
          const classAverage = ranked.length ? ranked.reduce((s, r) => s + r.pct, 0) / ranked.length : 0;

          const projectSubmissions = await prisma.projectSubmission.findMany({
            where: { studentId: id, release: { scheduleId } },
            include: {
              release: { include: { project: { select: { title: true, module: { select: { title: true } } } } } },
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
            rank: myIndex === -1 ? null : myIndex + 1,
            totalStudents: ranked.length,
            marksObtained: myTotals.obtained,
            marksMax: myTotals.max,
            percentage: Math.round((myTotals.max ? (myTotals.obtained / myTotals.max) * 100 : 0) * 10) / 10,
            classAverage: Math.round(classAverage * 10) / 10,
            projects: projectSubmissions.map((s) => ({
              projectTitle: s.release.project.title,
              moduleTitle: s.release.project.module.title,
              status: s.status,
              submittedAt: s.submittedAt,
              grade: s.grade,
              maxGrade: s.maxGrade,
              reviewNote: s.reviewNote,
            })),
            moduleFeedback: moduleFeedback.map((f) => ({
              moduleTitle: f.module.title,
              order: f.module.order,
              rating: f.rating,
              comments: f.comments,
              trainerName: f.trainer ? `${f.trainer.firstName} ${f.trainer.lastName}` : null,
            })),
          };
        })
      );

      res.json({ success: true, data: { ...student, enrollments, interviews, results, trainerFeedbacks, rankCards } });
    } catch (err) { next(err); }
  },
};
