import { Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };

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
      const { title, order } = req.body;
      if (!title) throw new AppError('Title is required', 400);

      const fileKey = `/uploads/onboarding-templates/${file.filename}`;
      const template = await prisma.onboardingDocumentTemplate.create({
        data: {
          title,
          fileKey,
          fileUrl: fileKey,
          order: order ? Number(order) : 0,
          createdById: req.user?.employeeId,
        },
      });
      res.status(201).json({ success: true, data: template });
    } catch (err) { next(err); }
  },

  async updateTemplate(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { title, order, isActive } = req.body;
      const template = await prisma.onboardingDocumentTemplate.update({
        where: { id: req.params.id },
        data: {
          title: title !== undefined ? title : undefined,
          order: order !== undefined ? Number(order) : undefined,
          isActive: isActive !== undefined ? Boolean(isActive) : undefined,
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
};
