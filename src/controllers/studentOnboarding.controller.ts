import { Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { getOnboardingStatus } from '../utils/onboardingStatus';

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };

const VALID_TRACKS = ['JRP', 'IOP', 'PAP'];

/** Accepts either an array (JSON body) or a comma-separated string (multipart
 * form field) and normalises to a clean array of valid StudentTrack values.
 * Empty/invalid input becomes `[]`, which means "applies to every track". */
function parseTracks(input: unknown): string[] {
  if (Array.isArray(input)) {
    return input.map((t) => String(t).trim().toUpperCase()).filter((t) => VALID_TRACKS.includes(t));
  }
  if (typeof input === 'string' && input.trim()) {
    return input.split(',').map((t) => t.trim().toUpperCase()).filter((t) => VALID_TRACKS.includes(t));
  }
  return [];
}

export const studentOnboardingController = {
  // ── Document templates (admin-managed, reusable across every student) ──────
  async listTemplates(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const templates = await prisma.onboardingDocumentTemplate.findMany({
        include: {
          createdBy: { select: employeeSelect },
          _count: { select: { signatures: true } },
        },
        orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
      });
      res.json({ success: true, data: templates });
    } catch (err) { next(err); }
  },

  async createTemplate(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const file = req.file;
      if (!file) throw new AppError('A PDF file is required', 400);
      const { title, order, applicableTracks } = req.body;
      if (!title) throw new AppError('Title is required', 400);

      const fileKey = `/uploads/onboarding-templates/${file.filename}`;
      const template = await prisma.onboardingDocumentTemplate.create({
        data: {
          title,
          fileKey,
          fileUrl: fileKey,
          order: order ? Number(order) : 0,
          applicableTracks: parseTracks(applicableTracks),
          createdById: req.user?.employeeId,
        },
      });
      res.status(201).json({ success: true, data: template });
    } catch (err) { next(err); }
  },

  async updateTemplate(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { title, order, isActive, applicableTracks } = req.body;
      const template = await prisma.onboardingDocumentTemplate.update({
        where: { id: req.params.id },
        data: {
          title: title !== undefined ? title : undefined,
          order: order !== undefined ? Number(order) : undefined,
          isActive: isActive !== undefined ? Boolean(isActive) : undefined,
          applicableTracks: applicableTracks !== undefined ? parseTracks(applicableTracks) : undefined,
        },
      });
      res.json({ success: true, data: template });
    } catch (err) { next(err); }
  },

  async deleteTemplate(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const template = await prisma.onboardingDocumentTemplate.findUnique({
        where: { id: req.params.id },
        include: { _count: { select: { signatures: true } } },
      });
      if (!template) throw new AppError('Template not found', 404);
      // Once anyone has signed against this template, deleting it would wipe
      // their signature record too (onDelete: Cascade) — retire it instead so
      // the audit trail for students who already signed stays intact.
      if (template._count.signatures > 0) {
        throw new AppError('This document already has signatures on file — deactivate it instead of deleting so existing signatures stay intact.', 400);
      }
      const filePath = path.join(process.cwd(), 'uploads', 'onboarding-templates', path.basename(template.fileKey));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      await prisma.onboardingDocumentTemplate.delete({ where: { id: req.params.id } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  // ── Reports: batch-wise cards ────────────────────────────────────────────────
  /** One card per batch — total students currently enrolled in it, and how
   * many have finished onboarding (profile filled + every active document
   * signed), so a manager can see at a glance which batches still have
   * incomplete students. */
  async batchSummary(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const [batches, activeTemplateCount] = await Promise.all([
        prisma.batch.findMany({
          include: {
            schedules: {
              include: {
                course: { select: { id: true, name: true } },
                enrollments: {
                  include: {
                    student: { select: { id: true, profileCompletedAt: true, documentsCompletedAt: true } },
                  },
                },
              },
            },
          },
          orderBy: { startDate: 'desc' },
        }),
        prisma.onboardingDocumentTemplate.count({ where: { isActive: true } }),
      ]);

      const data = batches.map((batch) => {
        const studentMap = new Map<string, { profileCompletedAt: Date | null; documentsCompletedAt: Date | null }>();
        for (const schedule of batch.schedules) {
          for (const enrollment of schedule.enrollments) {
            studentMap.set(enrollment.student.id, enrollment.student);
          }
        }
        const students = Array.from(studentMap.values());
        const profileDone = students.filter((s) => s.profileCompletedAt).length;
        const docsDone = students.filter((s) => s.documentsCompletedAt).length;
        return {
          id: batch.id,
          code: batch.code,
          status: batch.status,
          startDate: batch.startDate,
          endDate: batch.endDate,
          totalStudents: students.length,
          profileCompleted: profileDone,
          documentsCompleted: docsDone,
        };
      });

      res.json({ success: true, data: { batches: data, activeTemplateCount } });
    } catch (err) { next(err); }
  },

  /** Drill-down for one batch card: every enrolled student's profile info +
   * per-document signed/pending status. */
  async batchStudents(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const batchId = req.params.id;
      const batch = await prisma.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw new AppError('Batch not found', 404);

      const [templates, enrollments] = await Promise.all([
        prisma.onboardingDocumentTemplate.findMany({
          where: { isActive: true },
          orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
        }),
        prisma.studentBatchEnrollment.findMany({
          where: { schedule: { batchId } },
          include: {
            schedule: { include: { course: { select: { id: true, name: true } } } },
            student: {
              include: { documentSignatures: { include: { template: true } } },
            },
          },
        }),
      ]);

      // A student enrolled in two courses within the same batch should only
      // appear once — keep the first sighting, list every course they're in.
      const byStudent = new Map<string, { student: (typeof enrollments)[number]['student']; courses: string[] }>();
      for (const e of enrollments) {
        const existing = byStudent.get(e.student.id);
        if (existing) existing.courses.push(e.schedule.course.name);
        else byStudent.set(e.student.id, { student: e.student, courses: [e.schedule.course.name] });
      }

      const students = Array.from(byStudent.values()).map(({ student, courses }) => {
        const signedByTemplate = new Map(student.documentSignatures.map((sig) => [sig.templateId, sig]));
        const documents = templates.map((t) => {
          const sig = signedByTemplate.get(t.id);
          return {
            templateId: t.id,
            title: t.title,
            signed: !!sig,
            signedAt: sig?.signedAt ?? null,
            location: sig?.location ?? null,
          };
        });
        return {
          id: student.id,
          studentCode: student.studentCode,
          firstName: student.firstName,
          lastName: student.lastName,
          email: student.email,
          phone: student.phone,
          photo: student.photo,
          courses,
          profileCompletedAt: student.profileCompletedAt,
          documentsCompletedAt: student.documentsCompletedAt,
          dateOfBirth: student.dateOfBirth,
          gender: student.gender,
          address: student.address,
          city: student.city,
          state: student.state,
          pincode: student.pincode,
          education: student.education,
          fatherName: student.fatherName,
          fatherPhone: student.fatherPhone,
          motherName: student.motherName,
          motherPhone: student.motherPhone,
          emergencyContactName: student.emergencyContactName,
          emergencyContactPhone: student.emergencyContactPhone,
          documents,
        };
      });

      res.json({ success: true, data: { batch: { id: batch.id, code: batch.code, status: batch.status }, students } });
    } catch (err) { next(err); }
  },

  // ── Approvals: the final gate before a student's dashboard unlocks ─────────
  /** Students whose profile is complete and every currently-required
   * document is signed, but who haven't yet been given final admin sign-off. */
  async listApprovals(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const search = String(req.query.search || '').trim();
      const candidates = await prisma.student.findMany({
        where: {
          profileCompletedAt: { not: null },
          onboardingApprovedAt: null,
          ...(search
            ? {
                OR: [
                  { firstName: { contains: search } },
                  { lastName: { contains: search } },
                  { phone: { contains: search } },
                  { studentCode: { contains: search } },
                ],
              }
            : {}),
        },
        orderBy: { profileCompletedAt: 'asc' },
      });

      const results = [];
      for (const student of candidates) {
        const status = await getOnboardingStatus(student.id);
        if (status.allSigned) {
          results.push({
            id: student.id,
            studentCode: student.studentCode,
            firstName: student.firstName,
            lastName: student.lastName,
            phone: student.phone,
            email: student.email,
            photo: student.photo,
            track: student.track,
            profileCompletedAt: student.profileCompletedAt,
            documentsCompletedAt: student.documentsCompletedAt,
            requiredCount: status.requiredCount,
          });
        }
      }
      res.json({ success: true, data: results });
    } catch (err) { next(err); }
  },

  /** Full profile + every required document's signed/pending status, for the review screen. */
  async approvalDetail(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const student = await prisma.student.findUnique({ where: { id: req.params.studentId } });
      if (!student) throw new AppError('Student not found', 404);
      const status = await getOnboardingStatus(student.id);
      res.json({ success: true, data: { student, items: status.items, allSigned: status.allSigned } });
    } catch (err) { next(err); }
  },

  /** Final sign-off — re-validated server-side so a stale frontend can never
   * approve a student who still has an unsigned document. */
  async approveStudent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = req.params.studentId;
      const student = await prisma.student.findUnique({ where: { id: studentId } });
      if (!student) throw new AppError('Student not found', 404);
      if (!student.profileCompletedAt) throw new AppError('This student has not completed their profile yet', 400);

      const status = await getOnboardingStatus(studentId);
      if (!status.allSigned) throw new AppError('This student still has unsigned documents', 400);

      const updated = await prisma.student.update({
        where: { id: studentId },
        data: { onboardingApprovedAt: new Date(), onboardingApprovedById: req.user?.employeeId },
      });
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  /** Sends the student back to fix their profile — reopens Step 2 *and*
   * Step 3 (documents). Signed-off documents are deleted rather than just
   * unmarked: since the correction may change the very identity/info they
   * were signed against (name, Aadhar, photo...), a stale signature can't be
   * trusted as-is, so the student re-signs everything fresh once they
   * resubmit. Fee declaration entries an admin already filled in are kept
   * (guardianName/courseName/rows), just marked unsigned again. Clears
   * itself the next time the student resubmits their profile. */
  async rejectStudent(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = req.params.studentId;
      const { reason } = req.body;
      const student = await prisma.student.findUnique({ where: { id: studentId } });
      if (!student) throw new AppError('Student not found', 404);
      if (!student.profileCompletedAt) throw new AppError('This student has not submitted a profile yet', 400);

      const [oldSignatures, oldDeclarations] = await Promise.all([
        prisma.studentDocumentSignature.findMany({ where: { studentId } }),
        prisma.studentFeeDeclaration.findMany({ where: { studentId, signedAt: { not: null } } }),
      ]);

      // Best-effort cleanup of the now-invalid signed files — never let a
      // filesystem hiccup block the actual reset below.
      try {
        for (const row of [...oldSignatures, ...oldDeclarations]) {
          for (const url of [row.signatureUrl, row.photoUrl, row.signedPdfUrl]) {
            if (!url) continue;
            const filePath = path.join(process.cwd(), url.replace(/^\//, ''));
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
          }
        }
      } catch { /* non-fatal — DB reset below is what actually matters */ }

      await prisma.$transaction([
        prisma.studentDocumentSignature.deleteMany({ where: { studentId } }),
        prisma.studentFeeDeclaration.updateMany({
          where: { studentId },
          data: { signatureUrl: null, photoUrl: null, ipAddress: null, location: null, signedAt: null, signedPdfUrl: null },
        }),
        prisma.student.update({
          where: { id: studentId },
          data: {
            profileCompletedAt: null,
            documentsCompletedAt: null,
            rejectionReason: (reason && String(reason).trim()) || 'Please review and resubmit your details.',
            onboardingRejectedAt: new Date(),
            onboardingRejectedById: req.user?.employeeId,
          },
        }),
      ]);

      const updated = await prisma.student.findUnique({ where: { id: studentId } });
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  // ── Fee declarations: admin fills in per-student, student reads + signs ────
  async listFeeDeclarations(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const declarations = await prisma.studentFeeDeclaration.findMany({
        where: { studentId: req.params.studentId },
        include: { createdBy: { select: employeeSelect } },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: declarations });
    } catch (err) { next(err); }
  },

  /** Creating one re-locks the student's onboarding: a new required document
   * just appeared, so they must sign it (and, if already approved, wait on a
   * fresh admin approval) before their dashboard opens again. */
  async createFeeDeclaration(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const studentId = req.params.studentId;
      const { guardianName, courseName, dueDate, rows } = req.body;
      const student = await prisma.student.findUnique({ where: { id: studentId } });
      if (!student) throw new AppError('Student not found', 404);
      if (!Array.isArray(rows) || rows.length === 0) throw new AppError('At least one fee row is required', 400);

      const declaration = await prisma.studentFeeDeclaration.create({
        data: {
          studentId,
          guardianName: guardianName || undefined,
          courseName: courseName || undefined,
          dueDate: dueDate ? new Date(dueDate) : undefined,
          rows,
          createdById: req.user?.employeeId,
        },
      });

      await prisma.student.update({
        where: { id: studentId },
        data: { documentsCompletedAt: null, onboardingApprovedAt: null, onboardingApprovedById: null },
      });

      res.status(201).json({ success: true, data: declaration });
    } catch (err) { next(err); }
  },

  /** Only removable before the student has signed it — once signed it's part of the audit trail. */
  async deleteFeeDeclaration(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const declaration = await prisma.studentFeeDeclaration.findUnique({ where: { id: req.params.id } });
      if (!declaration) throw new AppError('Fee declaration not found', 404);
      if (declaration.signedAt) throw new AppError('This has already been signed by the student and cannot be deleted', 400);
      await prisma.studentFeeDeclaration.delete({ where: { id: req.params.id } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};
