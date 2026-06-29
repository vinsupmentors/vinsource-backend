import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

/**
 * Production Manager "content authoring" surface — Projects, Feedback Forms,
 * and Online Tests. These are authored module-wise by the Production
 * Manager (gated by requireModule('PRODUCTION_TRAINING','EDIT') in the
 * routes file) and later released/activated per schedule by the assigned
 * Trainer via trainerPortal endpoints. correctIndex on OnlineTestQuestion is
 * never exposed outside this PM-authoring surface and the grading logic —
 * student-facing endpoints must omit it.
 */
export const productionContentController = {
  // ── PROJECTS ───────────────────────────────────────────────────────────────
  async listProjects(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { moduleId } = req.query;
      const projects = await prisma.project.findMany({
        where: moduleId ? { moduleId: String(moduleId) } : undefined,
        include: {
          module: { select: { id: true, title: true, order: true, courseId: true } },
          createdBy: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { releases: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: projects });
    } catch (err) { next(err); }
  },

  /** Create a Project for a module. Multipart: resource (PDF) + body { moduleId, title, description } */
  async createProject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { moduleId, title, description } = req.body;
      const file = req.file as Express.Multer.File | undefined;
      if (!moduleId || !title) throw new AppError('moduleId and title are required', 400);
      if (!file) throw new AppError('A PDF project brief is required', 400);

      const project = await prisma.project.create({
        data: {
          moduleId,
          title,
          description: description || undefined,
          resourceUrl: `/uploads/project-resources/${file.filename}`,
          createdById: req.user!.employeeId!,
        },
      });
      res.status(201).json({ success: true, data: project });
    } catch (err) { next(err); }
  },

  async updateProject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { title, description } = req.body;
      const file = req.file as Express.Multer.File | undefined;
      const project = await prisma.project.update({
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

  // ── FEEDBACK FORMS ─────────────────────────────────────────────────────────
  async listFeedbackForms(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { moduleId } = req.query;
      const forms = await prisma.feedbackForm.findMany({
        where: moduleId ? { moduleId: String(moduleId) } : undefined,
        include: {
          module: { select: { id: true, title: true, order: true, courseId: true } },
          questions: { orderBy: { order: 'asc' } },
          _count: { select: { releases: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: forms });
    } catch (err) { next(err); }
  },

  /**
   * Build / replace the feedback form template for a module — "full custom
   * builder, fix the template for the module" per product decision. One
   * FeedbackForm per module (moduleId is @unique), so this is an upsert that
   * fully replaces the question set each time it's saved.
   * Body: { moduleId, title, questions: [{ order, type, prompt, options?, required? }] }
   */
  async saveFeedbackForm(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { moduleId, title, questions } = req.body;
      if (!moduleId || !title) throw new AppError('moduleId and title are required', 400);
      if (!Array.isArray(questions) || !questions.length) {
        throw new AppError('At least one question is required', 400);
      }
      for (const q of questions) {
        if (!q.prompt || !q.type) throw new AppError('Every question needs a type and prompt', 400);
        if (q.type === 'MCQ' && (!Array.isArray(q.options) || q.options.length < 2)) {
          throw new AppError('MCQ questions need at least 2 options', 400);
        }
      }

      const existing = await prisma.feedbackForm.findUnique({ where: { moduleId } });

      const form = await prisma.$transaction(async (tx) => {
        const saved = existing
          ? await tx.feedbackForm.update({ where: { moduleId }, data: { title } })
          : await tx.feedbackForm.create({
              data: { moduleId, title, createdById: req.user!.employeeId! },
            });

        if (existing) {
          await tx.feedbackFormQuestion.deleteMany({ where: { formId: saved.id } });
        }
        await tx.feedbackFormQuestion.createMany({
          data: questions.map((q: { order: number; type: 'RATING' | 'TEXT' | 'MCQ'; prompt: string; options?: string[]; required?: boolean }, i: number) => ({
            formId: saved.id,
            order: q.order ?? i + 1,
            type: q.type,
            prompt: q.prompt,
            options: q.type === 'MCQ' ? q.options : undefined,
            required: q.required ?? true,
          })),
        });

        return tx.feedbackForm.findUnique({
          where: { id: saved.id },
          include: { questions: { orderBy: { order: 'asc' } } },
        });
      });

      res.status(existing ? 200 : 201).json({ success: true, data: form });
    } catch (err) { next(err); }
  },

  /**
   * All feedback form releases across sub-batches, with response counts —
   * the Production Manager's filterable index into feedback collection.
   * Once a Trainer releases a feedback form and students respond, ONLY the
   * Production Manager can read those responses (not the Trainer) — this
   * and feedbackResponses() below are the sole read surface for that data.
   * Query: ?batchId=&courseId=&scheduleId=&status=ACTIVE|CLOSED
   */
  async listFeedbackReleases(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { batchId, courseId, scheduleId, status } = req.query;
      const releases = await prisma.feedbackFormRelease.findMany({
        where: {
          scheduleId: scheduleId ? String(scheduleId) : undefined,
          status: status ? (String(status) as 'ACTIVE' | 'CLOSED') : undefined,
          schedule: {
            batchId: batchId ? String(batchId) : undefined,
            courseId: courseId ? String(courseId) : undefined,
          },
        },
        include: {
          form: { select: { id: true, title: true, module: { select: { id: true, title: true } } } },
          schedule: {
            select: {
              id: true,
              batch: { select: { id: true, code: true } },
              course: { select: { id: true, name: true } },
            },
          },
          releasedBy: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { responses: true } },
        },
        orderBy: { releasedAt: 'desc' },
      });
      res.json({ success: true, data: releases });
    } catch (err) { next(err); }
  },

  /** Full responses for one feedback release. Production-Manager-only — see note above. */
  async feedbackResponses(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { releaseId } = req.params;
      const release = await prisma.feedbackFormRelease.findUnique({
        where: { id: releaseId },
        include: {
          form: { include: { questions: { orderBy: { order: 'asc' } } } },
          schedule: { select: { id: true, batch: { select: { code: true } }, course: { select: { name: true } } } },
        },
      });
      if (!release) throw new AppError('Feedback release not found', 404);

      const responses = await prisma.feedbackFormResponse.findMany({
        where: { releaseId },
        include: {
          student: { select: { id: true, studentCode: true, firstName: true, lastName: true } },
          answers: true,
        },
        orderBy: { submittedAt: 'desc' },
      });
      res.json({ success: true, data: { release, responses } });
    } catch (err) { next(err); }
  },

  // ── ONLINE TESTS ───────────────────────────────────────────────────────────
  async listOnlineTests(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { moduleId } = req.query;
      const tests = await prisma.onlineTest.findMany({
        where: moduleId ? { moduleId: String(moduleId) } : undefined,
        include: {
          module: { select: { id: true, title: true, order: true, courseId: true } },
          createdBy: { select: { id: true, firstName: true, lastName: true } },
          _count: { select: { questions: true, releases: true } },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: tests });
    } catch (err) { next(err); }
  },

  /** PM-only detail view — includes correctIndex for review. Never expose this route to students. */
  async getOnlineTest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const test = await prisma.onlineTest.findUnique({
        where: { id },
        include: { questions: { orderBy: { order: 'asc' } }, module: { select: { id: true, title: true } } },
      });
      if (!test) throw new AppError('Online test not found', 404);
      res.json({ success: true, data: test });
    } catch (err) { next(err); }
  },

  /** Body: { moduleId, title, durationMinutes? } — questions are added separately via bulk upload. */
  async createOnlineTest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { moduleId, title, durationMinutes } = req.body;
      if (!moduleId || !title) throw new AppError('moduleId and title are required', 400);
      const test = await prisma.onlineTest.create({
        data: {
          moduleId,
          title,
          durationMinutes: durationMinutes ? Number(durationMinutes) : 45,
          createdById: req.user!.employeeId!,
        },
      });
      res.status(201).json({ success: true, data: test });
    } catch (err) { next(err); }
  },

  async updateOnlineTest(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { title, durationMinutes } = req.body;
      const test = await prisma.onlineTest.update({
        where: { id },
        data: { title: title || undefined, durationMinutes: durationMinutes ? Number(durationMinutes) : undefined },
      });
      res.json({ success: true, data: test });
    } catch (err) { next(err); }
  },

  /** Single question add. Body: { order?, prompt, options: string[], correctIndex, marks? } */
  async addQuestion(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id: testId } = req.params;
      const { order, prompt, options, correctIndex, marks } = req.body;
      if (!prompt || !Array.isArray(options) || options.length < 2) {
        throw new AppError('prompt and at least 2 options are required', 400);
      }
      if (correctIndex === undefined || correctIndex === null || correctIndex < 0 || correctIndex >= options.length) {
        throw new AppError('correctIndex must point to one of the supplied options', 400);
      }
      const count = await prisma.onlineTestQuestion.count({ where: { testId } });
      const question = await prisma.onlineTestQuestion.create({
        data: { testId, order: order ?? count + 1, prompt, options, correctIndex, marks: marks ?? 1 },
      });
      res.status(201).json({ success: true, data: question });
    } catch (err) { next(err); }
  },

  async deleteQuestion(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id: testId, questionId } = req.params;
      const question = await prisma.onlineTestQuestion.findUnique({ where: { id: questionId } });
      if (!question || question.testId !== testId) throw new AppError('Question not found on this test', 404);
      await prisma.onlineTestQuestion.delete({ where: { id: questionId } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  /**
   * Bulk-upload MCQ questions — mirrors productionController.bulkUploadStudents:
   * the frontend parses the operator's spreadsheet client-side with the `xlsx`
   * package and POSTs a plain JSON array here; we validate + create per row
   * and return a results array so partial failures are visible row-by-row.
   * Body: { questions: [{ prompt, option1, option2, option3?, option4?, correctOption, marks? }] }
   * `correctOption` is 1-indexed (matches what's friendliest in a spreadsheet).
   */
  async bulkUploadQuestions(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id: testId } = req.params;
      const { questions } = req.body as { questions: Array<Record<string, unknown>> };
      if (!Array.isArray(questions) || !questions.length) {
        throw new AppError('A non-empty questions array is required', 400);
      }

      const test = await prisma.onlineTest.findUnique({ where: { id: testId } });
      if (!test) throw new AppError('Online test not found', 404);

      const existingCount = await prisma.onlineTestQuestion.count({ where: { testId } });
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

          const marksRaw = row.marks ?? row.Marks;
          const marks = marksRaw !== undefined && marksRaw !== '' && !Number.isNaN(Number(marksRaw)) ? Number(marksRaw) : 1;

          await prisma.onlineTestQuestion.create({
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
};
