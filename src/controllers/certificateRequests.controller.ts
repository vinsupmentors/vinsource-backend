import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { computeRankCard } from '../utils/rankCard';
import { generateCertificatePdf } from '../utils/certificatePdf';

const employeeNameSelect = { firstName: true, lastName: true } as const;

const studentListSelect = {
  id: true, firstName: true, lastName: true, studentCode: true, photo: true, track: true, status: true,
} as const;

const studentProfileSelect = {
  id: true, firstName: true, lastName: true, studentCode: true, photo: true, track: true, status: true,
  email: true, phone: true, joiningDate: true, movedToPlacementAt: true,
  totalProgramFee: true, amountPaid: true, balanceAmount: true, paymentMode: true,
  portfolio: { select: { targetRole: true, summary: true, status: true, publicSlug: true } },
} as const;

async function nextCertNo(type: 'COURSE_COMPLETION' | 'INTERNSHIP'): Promise<string> {
  const year = new Date().getFullYear();
  const prefix = type === 'COURSE_COMPLETION' ? 'VSA/CC' : 'VSA/INT';
  const count = await prisma.studentCertificateRequest.count({ where: { type, certificateNo: { not: null } } });
  return `${prefix}/${year}/${String(count + 1).padStart(4, '0')}`;
}

/**
 * If both approvals are now in place and this request hasn't been marked
 * generated yet, stamp it with a certificate number + generatedAt. The
 * actual PDF bytes are produced on demand at download time (see
 * `download` below) rather than persisted to disk — the same on-demand
 * approach already used for Appointment Letters elsewhere in this codebase.
 */
async function maybeFinalize(id: string) {
  const req_ = await prisma.studentCertificateRequest.findUnique({ where: { id } });
  if (!req_) return;
  if (req_.feeApprovedAt && req_.ldmApprovedAt && !req_.generatedAt) {
    const certificateNo = await nextCertNo(req_.type);
    await prisma.studentCertificateRequest.update({
      where: { id },
      data: { certificateNo, generatedAt: new Date() },
    });
  }
}

export const certificateRequestsController = {
  /** Staff list — every certificate request, newest first. */
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { type } = req.query;
      const rows = await prisma.studentCertificateRequest.findMany({
        where: type ? { type: String(type) as 'COURSE_COMPLETION' | 'INTERNSHIP' } : undefined,
        include: {
          student: { select: studentListSelect },
          course: { select: { id: true, name: true } },
          feeApprovedBy: { select: employeeNameSelect },
          ldmApprovedBy: { select: employeeNameSelect },
        },
        orderBy: { createdAt: 'desc' },
      });
      res.json({ success: true, data: rows });
    } catch (err) { next(err); }
  },

  /** Full review detail — student profile + rank card, for the approval screen. */
  async get(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const request = await prisma.studentCertificateRequest.findUnique({
        where: { id: req.params.id },
        include: {
          student: { select: studentProfileSelect },
          course: { select: { id: true, name: true } },
          feeApprovedBy: { select: employeeNameSelect },
          ldmApprovedBy: { select: employeeNameSelect },
        },
      });
      if (!request) throw new AppError('Certificate request not found', 404);

      const rankCard = await computeRankCard(request.studentId);
      res.json({ success: true, data: { ...request, rankCard } });
    } catch (err) { next(err); }
  },

  /** Fee/Admin sign-off — confirms the student has cleared their fees. */
  async approveFee(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.studentCertificateRequest.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Certificate request not found', 404);
      if (existing.feeApprovedAt) throw new AppError('Fee approval already recorded', 400);

      await prisma.studentCertificateRequest.update({
        where: { id: existing.id },
        data: { feeApprovedById: req.user!.employeeId!, feeApprovedAt: new Date() },
      });
      await maybeFinalize(existing.id);

      const updated = await prisma.studentCertificateRequest.findUnique({
        where: { id: existing.id },
        include: { feeApprovedBy: { select: employeeNameSelect }, ldmApprovedBy: { select: employeeNameSelect } },
      });
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  /** LDM sign-off — second, independent approval. */
  async approveLdm(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.studentCertificateRequest.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Certificate request not found', 404);
      if (existing.ldmApprovedAt) throw new AppError('LDM approval already recorded', 400);

      await prisma.studentCertificateRequest.update({
        where: { id: existing.id },
        data: { ldmApprovedById: req.user!.employeeId!, ldmApprovedAt: new Date() },
      });
      await maybeFinalize(existing.id);

      const updated = await prisma.studentCertificateRequest.findUnique({
        where: { id: existing.id },
        include: { feeApprovedBy: { select: employeeNameSelect }, ldmApprovedBy: { select: employeeNameSelect } },
      });
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  /** Staff download — regenerates the PDF fresh from stored metadata every time. */
  async download(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const pdf = await buildPdfForRequest(req.params.id);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${pdf.filename}"`);
      res.send(pdf.buffer);
    } catch (err) { next(err); }
  },
};

/**
 * Shared PDF-building logic — used by both the staff download endpoint
 * above and the student portal's own download endpoint (studentPortal.controller.ts).
 * Throws AppError if the request isn't fully approved yet.
 */
export async function buildPdfForRequest(id: string): Promise<{ buffer: Buffer; filename: string }> {
  const request = await prisma.studentCertificateRequest.findUnique({
    where: { id },
    include: {
      student: { select: { firstName: true, lastName: true, studentCode: true } },
      course: { select: { name: true } },
      feeApprovedBy: { select: employeeNameSelect },
      ldmApprovedBy: { select: employeeNameSelect },
    },
  });
  if (!request) throw new AppError('Certificate request not found', 404);
  if (!request.feeApprovedAt || !request.ldmApprovedAt || !request.certificateNo) {
    throw new AppError('This certificate is still awaiting approval', 400);
  }

  const studentName = `${request.student.firstName} ${request.student.lastName}`;
  const buffer = await generateCertificatePdf({
    type: request.type,
    studentName,
    studentCode: request.student.studentCode,
    courseName: request.course?.name,
    certificateNo: request.certificateNo,
    issuedOn: request.generatedAt || new Date(),
    feeApproverName: request.feeApprovedBy ? `${request.feeApprovedBy.firstName} ${request.feeApprovedBy.lastName}` : '—',
    ldmApproverName: request.ldmApprovedBy ? `${request.ldmApprovedBy.firstName} ${request.ldmApprovedBy.lastName}` : '—',
  });

  const label = request.type === 'COURSE_COMPLETION' ? 'Course_Completion' : 'Internship';
  const filename = `${label}_Certificate_${studentName.replace(/\s+/g, '_')}.pdf`;
  return { buffer, filename };
}
