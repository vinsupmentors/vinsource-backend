import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

/**
 * Placement Training — a standalone Project/Test content system for
 * Softskill & Aptitude sessions, deliberately NOT wired into
 * AcademyModule/AcademyCourse or BatchCourseSchedule (see schema.prisma
 * comment above PlacementProject). This file covers both halves:
 *  - PM authoring (Production menu, requireModule('PRODUCTION_TRAINING', ...)):
 *    create/update PlacementProject & PlacementTest, manage questions.
 *  - Release to a specific SoftskillSession (Placements menu,
 *    requireModule('PLACEMENTS', ...)): list available content, release a
 *    project, activate a test, close a release. The "roster" a release
 *    applies to is the set of SoftskillAttendance rows already on that
 *    session (there's no separate enrollment table for softskill sessions).
 *
 * correctIndex on PlacementTestQuestion is never exposed outside this
 * PM-authoring surface and the grading logic — student-facing endpoints
 * (studentPortal.controller.ts) must omit it, exactly like OnlineTestQuestion.
 */
export const placementTrainingController = {
  // ── PROJECTS (authoring) ─────────────────────────────────────────────────
  async listPlacementProjects(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const projects = await prisma.placementProject.findMany({
        include: {
          createdBy: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { releases: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: projects });
    } catch (err) { next(err); }
  },

  /** Multipart: resource (PDF or ZIP) + body { title, description } */
  async createPlacementProject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { title, description } = req.body;
      const file = req.file as Express.Multer.File | undefined;
      if (!title) throw new AppError('title is required', 400);
      if (!file) throw new AppError('A PDF or ZIP project brief is required', 400);

      const project = await prisma.placementProject.create({
        data: {
          title,
          description: description || undefined,
          resourceUrl: `/uploads/project-resources/${file.filename}`,
          createdById: req.user!.employeeId!,
        },
      });
      res.status(201).json({ success: true, data: project });
    } catch (err) { next(err); }
  },

  async updatePlacementProject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { title, description } = req.body;
      const file = req.file as Express.Multer.File | undefined;
      const project = await prisma.placementProject.update({
        where: { id },
        data: {
          title: title || undefined,
          description: description ?? undefined,
          resourceUrl: file ? `/uploads/project-resources/${file.filename}` : undefined,
        },
      });
      res.json({ success: true, data: project });
    } catch (err) { next(err); }
  },

  // ── TESTS (authoring) ────────────────────────────────────────────────────
  async listPlacementTests(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const tests = await prisma.placementTest.findMany({
        include: {
          createdBy: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { questions: true, releases: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: tests });
    } catch (err) { next(err); }
  },

  /** PM-only detail view — includes correctIndex for review. Never expose this route to students. */
  async getPlacementTest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const test = await prisma.placementTest.findUnique({
        where: { id },
        include: { questions: { orderBy: { order: 'asc' } } },
      });
      if (!test) throw new AppError('Placement test not found', 404);
      res.json({ success: true, data: test });
    } catch (err) { next(err); }
  },

  /** Body: { title, durationMinutes? } — questions are added separately. */
  async createPlacementTest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { title, durationMinutes } = req.body;
      if (!title) throw new AppError('title is required', 400);
      const test = await prisma.placementTest.create({
        data: {
          title,
          durationMinutes: durationMinutes ? Number(durationMinutes) : 45,
          createdById: req.user!.employeeId!,
        },
      });
      res.status(201).json({ success: true, data: test });
    } catch (err) { next(err); }
  },

  async updatePlacementTest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { title, durationMinutes } = req.body;
      const test = await prisma.placementTest.update({
        where: { id },
        data: { title: title || undefined, durationMinutes: durationMinutes ? Number(durationMinutes) : undefined },
      });
      res.json({ success: true, data: test });
    } catch (err) { next(err); }
  },

  /** Delete a placement test. Blocked if it has any ACTIVE releases. */
  async deletePlacementTest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const test = await prisma.placementTest.findUnique({
        where: { id },
        include: { releases: { where: { status: 'ACTIVE' } } },
      });
      if (!test) throw new AppError('Placement test not found', 404);
      if (test.releases.length > 0) throw new AppError('Cannot delete a test that has an active release — close the release first', 409);
      await prisma.placementTest.delete({ where: { id } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /** Single question add. Body: { order?, prompt, options: string[], correctIndex, marks? } */
  async addPlacementQuestion(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id: testId } = req.params;
      const { order, prompt, options, correctIndex, marks } = req.body;
      if (!prompt || !Array.isArray(options) || options.length < 2) {
        throw new AppError('prompt and at least 2 options are required', 400);
      }
      if (correctIndex === undefined || correctIndex === null || correctIndex < 0 || correctIndex >= options.length) {
        throw new AppError('correctIndex must point to one of the supplied options', 400);
      }
      const count = await prisma.placementTestQuestion.count({ where: { testId } });
      const question = await prisma.placementTestQuestion.create({
        data: { testId, order: order ?? count + 1, prompt, options, correctIndex, marks: marks ?? 1 },
      });
      res.status(201).json({ success: true, data: question });
    } catch (err) { next(err); }
  },

  async deletePlacementQuestion(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id: testId, questionId } = req.params;
      const question = await prisma.placementTestQuestion.findUnique({ where: { id: questionId } });
      if (!question || question.testId !== testId) throw new AppError('Question not found on this test', 404);
      await prisma.placementTestQuestion.delete({ where: { id: questionId } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /**
   * Bulk-upload MCQ questions — identical shape/semantics to
   * productionContentController.bulkUploadQuestions. Body:
   * { questions: [{ prompt, option1, option2, option3?, option4?, correctOption, marks? }] }
   * `correctOption` is 1-indexed (matches what's friendliest in a spreadsheet).
   */
  async bulkUploadPlacementQuestions(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id: testId } = req.params;
      const { questions } = req.body as { questions: Array<Record<string, unknown>> };
      if (!Array.isArray(questions) || !questions.length) {
        throw new AppError('A non-empty questions array is required', 400);
      }

      const test = await prisma.placementTest.findUnique({ where: { id: testId } });
      if (!test) throw new AppError('Placement test not found', 404);

      const existingCount = await prisma.placementTestQuestion.count({ where: { testId } });
      const results: Array<{ row: number; status: 'created' | 'error'; message?: string }> = [];
      let created = 0;

      for (let i = 0; i < questions.length; i++) {
        const row = questions[i];
        const rowNum = i + 1;
        try {
          const prompt = String(row.prompt || row.Prompt || row.question || row.Question || '').trim();
          if (!prompt) throw new Error('Missing prompt/question text');

          const options: string[] = [];
          const opt1 = row.option1 ?? row.Option1 ?? row.optionA ?? row.OptionA;
          const opt2 = row.option2 ?? row.Option2 ?? row.optionB ?? row.OptionB;
          const opt3 = row.option3 ?? row.Option3 ?? row.optionC ?? row.OptionC;
          const opt4 = row.option4 ?? row.Option4 ?? row.optionD ?? row.OptionD;
          for (const o of [opt1, opt2, opt3, opt4]) {
            if (o !== undefined && o !== null && String(o).trim() !== '') options.push(String(o).trim());
          }
          if (options.length < 2) throw new Error('Need at least 2 non-empty options');

          const rawCorrect = row.correctOption ?? row.CorrectOption ?? row.correctAnswer ?? row.CorrectAnswer ?? row.correct;
          const correctOneIndexed = Number(rawCorrect);
          if (!correctOneIndexed || correctOneIndexed < 1 || correctOneIndexed > options.length) {
            throw new Error(`correctOption must be a number between 1 and ${options.length}`);
          }

          const rawMarks = row.marks ?? row.Marks;
          const marks =
            rawMarks !== undefined && rawMarks !== null && String(rawMarks).trim() !== '' && !Number.isNaN(Number(rawMarks))
              ? Number(rawMarks)
              : 1;

          await prisma.placementTestQuestion.create({
            data: {
              testId,
              order: existingCount + created + 1,
              prompt,
              options,
              correctIndex: correctOneIndexed - 1,
              marks,
            },
          });
          created++;
          results.push({ row: rowNum, status: 'created' });
        } catch (rowErr) {
          results.push({ row: rowNum, status: 'error', message: rowErr instanceof Error ? rowErr.message : String(rowErr) });
        }
      }

      res.json({ success: true, data: { created, failed: results.length - created, results } });
    } catch (err) { next(err); }
  },

  // ── RELEASE TO A SOFTSKILL SESSION (Placements) ─────────────────────────

  /** Every PlacementProject/PlacementTest, with this session's release (if any) attached — the Placements-side "what can I release here" picker. */
  async releasableSessionContent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { sessionId } = req.params;
      const session = await prisma.softskillSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new AppError('Session not found', 404);

      const [projects, tests] = await Promise.all([
        prisma.placementProject.findMany({
          include: { releases: { where: { sessionId } } },
          orderBy: { createdAt: 'desc' },
        }),
        prisma.placementTest.findMany({
          include: { releases: { where: { sessionId } }, _count: { select: { questions: true } } },
          orderBy: { createdAt: 'desc' },
        }),
      ]);
      res.json({ success: true, data: { projects, tests } });
    } catch (err) { next(err); }
  },

  /** Release a PlacementProject to this session's roster (its SoftskillAttendance rows). Body: { projectId, deadline? } */
  async releasePlacementProject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { sessionId } = req.params;
      const { projectId, deadline } = req.body;
      if (!projectId) throw new AppError('projectId is required', 400);

      const session = await prisma.softskillSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new AppError('Session not found', 404);
      const project = await prisma.placementProject.findUnique({ where: { id: projectId } });
      if (!project) throw new AppError('Placement project not found', 404);

      const release = await prisma.placementProjectRelease.upsert({
        where: { projectId_sessionId: { projectId, sessionId } },
        update: { status: 'ACTIVE', releasedAt: new Date(), releasedById: req.user!.employeeId!, deadline: deadline ? new Date(deadline) : null },
        create: { projectId, sessionId, releasedById: req.user!.employeeId!, deadline: deadline ? new Date(deadline) : undefined },
      });
      res.status(201).json({ success: true, data: release });
    } catch (err) { next(err); }
  },

  /** Activate a PlacementTest for this session's roster. Body: { testId, deadline? } */
  async activatePlacementTest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { sessionId } = req.params;
      const { testId, deadline } = req.body;
      if (!testId) throw new AppError('testId is required', 400);

      const session = await prisma.softskillSession.findUnique({ where: { id: sessionId } });
      if (!session) throw new AppError('Session not found', 404);
      const test = await prisma.placementTest.findUnique({ where: { id: testId }, include: { _count: { select: { questions: true } } } });
      if (!test) throw new AppError('Placement test not found', 404);
      if (test._count.questions === 0) throw new AppError('This test has no questions yet', 400);

      const release = await prisma.placementTestRelease.upsert({
        where: { testId_sessionId: { testId, sessionId } },
        update: { status: 'ACTIVE', activatedAt: new Date(), activatedById: req.user!.employeeId!, deadline: deadline ? new Date(deadline) : null },
        create: { testId, sessionId, activatedById: req.user!.employeeId!, deadline: deadline ? new Date(deadline) : undefined },
      });
      res.status(201).json({ success: true, data: release });
    } catch (err) { next(err); }
  },

  /** Close a project or test release early. Body: { kind: 'project' | 'test', releaseId } */
  async closePlacementRelease(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { sessionId } = req.params;
      const { kind, releaseId } = req.body as { kind: 'project' | 'test'; releaseId: string };
      if (!kind || !releaseId) throw new AppError('kind and releaseId are required', 400);

      if (kind === 'project') {
        const release = await prisma.placementProjectRelease.findUnique({ where: { id: releaseId } });
        if (!release || release.sessionId !== sessionId) throw new AppError('Release not found for this session', 404);
        await prisma.placementProjectRelease.update({ where: { id: releaseId }, data: { status: 'CLOSED' } });
      } else if (kind === 'test') {
        const release = await prisma.placementTestRelease.findUnique({ where: { id: releaseId } });
        if (!release || release.sessionId !== sessionId) throw new AppError('Release not found for this session', 404);
        await prisma.placementTestRelease.update({ where: { id: releaseId }, data: { status: 'CLOSED' } });
      } else {
        throw new AppError('kind must be project or test', 400);
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};
