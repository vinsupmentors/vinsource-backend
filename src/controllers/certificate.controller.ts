import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

const VALID_TYPES = [
  'OD_INTERNSHIP_JOINING',
  'BONAFIDE',
  'INTERNSHIP_COMPLETION_SHORT',
  'COURSE_COMPLETION',
  'INTERNSHIP_COMPLETION',
] as const;

const CERT_PREFIX: Record<string, string> = {
  OD_INTERNSHIP_JOINING: 'ODJ',
  BONAFIDE: 'BNF',
  INTERNSHIP_COMPLETION_SHORT: 'ICS',
  COURSE_COMPLETION: 'CCT',
  INTERNSHIP_COMPLETION: 'ICP',
};

async function nextCertNo(type: string): Promise<string> {
  const prefix = CERT_PREFIX[type] || 'CRT';
  const year = new Date().getFullYear();
  const count = await prisma.generatedCertificate.count({ where: { type: type as any } });
  return `VSA/${prefix}/${year}/${String(count + 1).padStart(4, '0')}`;
}

export const certificateController = {
  // List generated certificates (history) — newest first, searchable
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { search, type, page = 1, limit = 20 } = req.query;
      const p = Number(page), l = Number(limit);

      const where: Record<string, unknown> = {};
      if (type && VALID_TYPES.includes(type as any)) where.type = type;
      if (search) where.studentName = { contains: String(search) };

      const [rows, total] = await Promise.all([
        prisma.generatedCertificate.findMany({
          where,
          include: { issuedBy: { select: { firstName: true, lastName: true, employeeCode: true } } },
          orderBy: { createdAt: 'desc' },
          skip: (p - 1) * l,
          take: l,
        }),
        prisma.generatedCertificate.count({ where }),
      ]);

      res.json({ success: true, data: rows, meta: { total, page: p, limit: l } });
    } catch (err) { next(err); }
  },

  // Record a generated certificate — returns the record incl. its certNo
  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { type, studentName, data } = req.body;
      if (!type || !VALID_TYPES.includes(type)) throw new AppError('Valid certificate type is required', 400);
      if (!studentName?.trim()) throw new AppError('Student name is required', 400);

      const certNo = await nextCertNo(type);

      const cert = await prisma.generatedCertificate.create({
        data: {
          type,
          studentName: String(studentName).trim(),
          certNo,
          data: data ?? {},
          issuedById: req.user!.employeeId || null,
        },
        include: { issuedBy: { select: { firstName: true, lastName: true, employeeCode: true } } },
      });

      res.status(201).json({ success: true, data: cert });
    } catch (err) { next(err); }
  },

  // Delete a record (SUPER_ADMIN only — wired in routes)
  async remove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.generatedCertificate.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Certificate record deleted' });
    } catch (err) { next(err); }
  },
};
