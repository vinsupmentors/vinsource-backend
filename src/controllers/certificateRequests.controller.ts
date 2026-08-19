import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { computeRankCard } from '../utils/rankCard';
import { lookupBatchCode } from '../utils/certificateRequests';

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

// Our two request types map onto the Certificate Generator's existing
// GeneratedCertType values — INTERNSHIP here is INTERNSHIP_COMPLETION there.
// Sharing that type + its VSA/<prefix>/<year>/<seq> numbering + count means
// certificates issued through this approval workflow land in the exact same
// numbering sequence and "History" list as ones made by hand in the
// Certificate Generator, instead of running a separate counter.
const GENERATED_CERT_TYPE: Record<'COURSE_COMPLETION' | 'INTERNSHIP', 'COURSE_COMPLETION' | 'INTERNSHIP_COMPLETION'> = {
  COURSE_COMPLETION: 'COURSE_COMPLETION',
  INTERNSHIP: 'INTERNSHIP_COMPLETION',
};
const CERT_PREFIX: Record<'COURSE_COMPLETION' | 'INTERNSHIP_COMPLETION', string> = {
  COURSE_COMPLETION: 'CCT',
  INTERNSHIP_COMPLETION: 'ICP',
};

async function nextCertNo(type: 'COURSE_COMPLETION' | 'INTERNSHIP'): Promise<string> {
  const genType = GENERATED_CERT_TYPE[type];
  const prefix = CERT_PREFIX[genType];
  const year = new Date().getFullYear();
  const count = await prisma.generatedCertificate.count({ where: { type: genType } });
  return `VSA/${prefix}/${year}/${String(count + 1).padStart(4, '0')}`;
}

/**
 * If both approvals are now in place and this request hasn't been
 * finalized yet: assign a certificate number (from the shared Certificate
 * Generator numbering sequence) and log a GeneratedCertificate row so it
 * shows up in that unified History alongside hand-made certificates. The
 * actual PDF is never rendered or stored server-side — it's produced on
 * demand in the browser from the exact same React templates the manual
 * Certificate Generator uses (see renderData below), so the output is
 * pixel-identical to what's already been issued.
 */
async function maybeFinalize(id: string, approvedById: string) {
  const req_ = await prisma.studentCertificateRequest.findUnique({
    where: { id },
    include: { student: { select: { firstName: true, lastName: true, studentCode: true } }, course: { select: { name: true } } },
  });
  if (!req_ || !req_.feeApprovedAt || !req_.ldmApprovedAt || req_.certificateNo) return;

  const [certificateNo, batch] = await Promise.all([
    nextCertNo(req_.type),
    lookupBatchCode(req_.studentId),
  ]);
  const generatedAt = new Date();

  await prisma.$transaction([
    prisma.studentCertificateRequest.update({
      where: { id },
      data: { certificateNo, generatedAt },
    }),
    prisma.generatedCertificate.create({
      data: {
        type: GENERATED_CERT_TYPE[req_.type],
        studentName: `${req_.student.firstName} ${req_.student.lastName}`,
        certNo: certificateNo,
        data: {
          studentId: req_.student.studentCode,
          course: req_.course?.name || '',
          batch: batch || '',
          issueDate: generatedAt.toISOString().slice(0, 10),
        },
        issuedById: approvedById,
      },
    }),
  ]);
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
      await maybeFinalize(existing.id, req.user!.employeeId!);

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
      await maybeFinalize(existing.id, req.user!.employeeId!);

      const updated = await prisma.studentCertificateRequest.findUnique({
        where: { id: existing.id },
        include: { feeApprovedBy: { select: employeeNameSelect }, ldmApprovedBy: { select: employeeNameSelect } },
      });
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  /** Staff-side render data — feeds the real CourseCompletionTemplate / InternshipCompletionTemplate on the frontend. */
  async renderData(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const data = await buildRenderData(req.params.id);
      res.json({ success: true, data });
    } catch (err) { next(err); }
  },
};

/**
 * Shared render-data builder — used by both the staff endpoint above and
 * the student portal's own endpoint (studentPortal.controller.ts). Returns
 * exactly the fields the existing CourseCompletionTemplate /
 * InternshipCompletionTemplate React components need; the frontend renders
 * them off-screen and captures a PDF client-side, so the output is
 * identical to a hand-made certificate — nothing new is designed here.
 * Throws AppError if the request isn't fully approved yet.
 */
export async function buildRenderData(id: string) {
  const request = await prisma.studentCertificateRequest.findUnique({
    where: { id },
    include: {
      student: { select: { firstName: true, lastName: true, studentCode: true, photo: true } },
      course: { select: { name: true } },
    },
  });
  if (!request) throw new AppError('Certificate request not found', 404);
  if (!request.feeApprovedAt || !request.ldmApprovedAt || !request.certificateNo) {
    throw new AppError('This certificate is still awaiting approval', 400);
  }

  const batch = await lookupBatchCode(request.studentId);

  return {
    type: request.type,
    studentName: `${request.student.firstName} ${request.student.lastName}`,
    studentId: request.student.studentCode,
    course: request.course?.name || null,
    batch,
    issueDate: request.generatedAt,
    photoUrl: request.student.photo,
    certificateNo: request.certificateNo,
  };
}
