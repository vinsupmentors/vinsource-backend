import { Response, NextFunction } from 'express';
import path from 'path';
import fs from 'fs';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

// Document types required at onboarding — in display order
export const REQUIRED_DOC_TYPES = [
  { type: 'AADHAAR',      label: 'Aadhaar Card' },
  { type: 'PAN',          label: 'PAN Card' },
  { type: 'MARKSHEET_10', label: '10th Marksheet' },
  { type: 'MARKSHEET_12', label: '12th Marksheet' },
  { type: 'DEGREE',       label: 'UG Degree Certificate' },
  { type: 'DEGREE_PG',    label: 'PG Degree Certificate' },
  { type: 'RESUME',       label: 'Resume / CV' },
  { type: 'OTHER',        label: 'Other' },
] as const;

export const documentController = {
  // List all documents for an employee (HR/Manager sees any; employee sees own)
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { employeeId } = req.params;

      // Resolve who we are fetching for
      let targetEmployeeId = employeeId;
      if (!targetEmployeeId) {
        const emp = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
        if (!emp) return res.json({ success: true, data: [] });
        targetEmployeeId = emp.id;
      }

      const docs = await prisma.document.findMany({
        where: { employeeId: targetEmployeeId },
        orderBy: { uploadedAt: 'desc' },
      });

      res.json({ success: true, data: docs });
    } catch (err) { next(err); }
  },

  // Upload a document (employee uploads their own)
  async upload(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const file = req.file;
      if (!file) throw new AppError('No file uploaded', 400);

      const { type, name } = req.body;
      if (!type) throw new AppError('Document type is required', 400);

      const emp = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!emp) throw new AppError('Employee not found', 404);

      const fileUrl = `/uploads/documents/${file.filename}`;

      // Upsert: replace existing doc of same type
      const existing = await prisma.document.findFirst({
        where: { employeeId: emp.id, type: type as any },
      });

      let doc;
      if (existing) {
        // Delete old file
        const oldPath = path.join(process.cwd(), 'uploads', 'documents', path.basename(existing.fileKey));
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);

        doc = await prisma.document.update({
          where: { id: existing.id },
          data: {
            name: name || file.originalname,
            fileKey: file.filename,
            fileUrl,
            uploadedAt: new Date(),
          },
        });
      } else {
        doc = await prisma.document.create({
          data: {
            employeeId: emp.id,
            type: type as any,
            name: name || file.originalname,
            fileKey: file.filename,
            fileUrl,
          },
        });
      }

      res.status(201).json({ success: true, data: doc });
    } catch (err) { next(err); }
  },

  // HR: mark whether original physical document was received
  async markOriginal(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { isOriginalSubmitted } = req.body;

      const doc = await prisma.document.update({
        where: { id },
        data: {
          isOriginalSubmitted: Boolean(isOriginalSubmitted),
          submittedAt: isOriginalSubmitted ? new Date() : null,
        },
      });

      res.json({ success: true, data: doc });
    } catch (err) { next(err); }
  },

  // HR: verify a document
  async verify(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const doc = await prisma.document.update({
        where: { id: req.params.id },
        data: { isVerified: true },
      });
      res.json({ success: true, data: doc });
    } catch (err) { next(err); }
  },

  // HR: list documents for all employees in company (grouped summary)
  async listForHR(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId!;
      const { employeeId } = req.query;

      const where: Record<string, unknown> = {
        employee: { companyId },
      };
      if (employeeId) where.employeeId = employeeId as string;

      const docs = await prisma.document.findMany({
        where,
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        },
        orderBy: { uploadedAt: 'desc' },
      });

      res.json({ success: true, data: docs });
    } catch (err) { next(err); }
  },

  // HR: mark multiple doc types as original received at joining (creates placeholder records if needed)
  async collectOriginalsAtJoining(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { employeeId, types } = req.body as { employeeId: string; types: string[] };
      if (!employeeId || !Array.isArray(types)) throw new AppError('employeeId and types[] are required', 400);

      const results = await Promise.all(
        types.map(async (type) => {
          const existing = await prisma.document.findFirst({ where: { employeeId, type: type as any } });
          if (existing) {
            return prisma.document.update({
              where: { id: existing.id },
              data: { isOriginalSubmitted: true, submittedAt: new Date() },
            });
          }
          return prisma.document.create({
            data: {
              employeeId,
              type: type as any,
              name: `[Original collected at joining]`,
              fileKey: '',
              fileUrl: '',
              isOriginalSubmitted: true,
              submittedAt: new Date(),
            },
          });
        })
      );

      res.json({ success: true, data: results });
    } catch (err) { next(err); }
  },

  // HR: originals collection summary — all employees × all doc types
  async originalsSummary(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId!;

      const [employees, docs] = await Promise.all([
        prisma.employee.findMany({
          where: { companyId, status: { in: ['ACTIVE', 'ON_PROBATION'] } },
          select: { id: true, firstName: true, lastName: true, employeeCode: true, department: { select: { name: true } } },
          orderBy: { employeeCode: 'asc' },
        }),
        prisma.document.findMany({
          where: { employee: { companyId } },
          select: { employeeId: true, type: true, isOriginalSubmitted: true, isVerified: true, fileUrl: true, id: true },
        }),
      ]);

      // Build map: employeeId → { type → doc }
      const docMap: Record<string, Record<string, typeof docs[0]>> = {};
      docs.forEach((d) => {
        if (!docMap[d.employeeId]) docMap[d.employeeId] = {};
        docMap[d.employeeId][d.type] = d;
      });

      const result = employees.map((e) => ({
        ...e,
        docs: docMap[e.id] ?? {},
      }));

      res.json({ success: true, data: result });
    } catch (err) { next(err); }
  },

  async delete(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
      if (!doc) throw new AppError('Document not found', 404);

      const filePath = path.join(process.cwd(), 'uploads', 'documents', path.basename(doc.fileKey));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);

      await prisma.document.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Document deleted' });
    } catch (err) { next(err); }
  },
};
