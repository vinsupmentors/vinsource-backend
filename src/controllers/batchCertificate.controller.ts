import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { emailService } from '../services/email.service';

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true } as const;

// Always CC'd on every certificate email, regardless of which student it's
// going to — Gaurav + the ops mailbox, per the requested delivery flow.
const CERTIFICATE_EMAIL_CC = ['v7032vinsup@gmail.com', 'v7030vinsup@gmail.com'];

async function nextCertNo(): Promise<string> {
  const year = new Date().getFullYear();
  const count = await prisma.batchCertificate.count();
  return `VSA/CCT/${year}/${String(count + 1).padStart(4, '0')}`;
}

export const batchCertificateController = {
  // Batches to pick from — newest first.
  async listBatches(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const batches = await prisma.batch.findMany({
        select: { id: true, code: true, status: true, startDate: true, endDate: true },
        orderBy: { startDate: 'desc' },
      });
      res.json({ success: true, data: batches });
    } catch (err) { next(err); }
  },

  // Every certificate generated so far for a batch — the review grid's data source.
  async listForBatch(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { batchId } = req.query;
      if (!batchId) throw new AppError('batchId is required', 400);
      const certs = await prisma.batchCertificate.findMany({
        where: { batchId: String(batchId) },
        include: { generatedBy: { select: employeeSelect } },
        orderBy: { studentName: 'asc' },
      });
      res.json({ success: true, data: certs });
    } catch (err) { next(err); }
  },

  async get(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const cert = await prisma.batchCertificate.findUnique({
        where: { id: req.params.id },
        include: { generatedBy: { select: employeeSelect } },
      });
      if (!cert) throw new AppError('Certificate not found', 404);
      res.json({ success: true, data: cert });
    } catch (err) { next(err); }
  },

  /** Bulk-generate — one row per student currently enrolled in the batch,
   * pre-filled from their Student record. Idempotent: re-running this for a
   * batch that already has some certificates only fills in the gaps — a
   * student who already has one (and may have been individually edited) is
   * left completely untouched, so this is safe to click again after new
   * students get added to the batch later. */
  async generateForBatch(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { batchId } = req.body;
      if (!batchId) throw new AppError('batchId is required', 400);
      const batch = await prisma.batch.findUnique({ where: { id: batchId } });
      if (!batch) throw new AppError('Batch not found', 404);

      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { schedule: { batchId } },
        include: {
          schedule: { include: { course: { select: { name: true } } } },
          student: { select: { id: true, firstName: true, lastName: true, studentCode: true, photo: true } },
        },
      });

      // A student enrolled in more than one schedule within the same batch
      // (e.g. a combo course spanning two sub-batches) should still only get
      // ONE certificate for the whole batch, not one per sub-batch — de-dupe
      // by student, keeping whichever enrollment we saw first as the default
      // course shown (editable afterward if it's the wrong one).
      const byStudent = new Map<string, (typeof enrollments)[number]>();
      for (const e of enrollments) if (!byStudent.has(e.studentId)) byStudent.set(e.studentId, e);

      const existing = await prisma.batchCertificate.findMany({
        where: { batchId, studentId: { in: Array.from(byStudent.keys()) } },
        select: { studentId: true },
      });
      const existingIds = new Set(existing.map((e) => e.studentId));

      const toCreate = Array.from(byStudent.values()).filter((e) => !existingIds.has(e.studentId));
      let created = 0;
      for (const e of toCreate) {
        const certNo = await nextCertNo();
        await prisma.batchCertificate.create({
          data: {
            studentId: e.studentId,
            batchId,
            certNo,
            studentName: `${e.student.firstName} ${e.student.lastName}`,
            studentCode: e.student.studentCode,
            course: e.schedule.course.name,
            batchLabel: batch.code,
            photoUrl: e.student.photo || null,
            generatedById: req.user!.employeeId || null,
          },
        });
        created++;
      }

      res.json({
        success: true,
        message: `${created} certificate${created === 1 ? '' : 's'} generated${existingIds.size ? `, ${existingIds.size} already existed` : ''}.`,
        data: { created, alreadyExisted: existingIds.size, total: byStudent.size },
      });
    } catch (err) { next(err); }
  },

  /** Text-field edits — name/course/batch label/student code/issue date.
   * Photo is handled separately by uploadPhoto below. */
  async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { studentName, course, batchLabel, studentCode, issuedOn } = req.body;
      const cert = await prisma.batchCertificate.update({
        where: { id: req.params.id },
        data: {
          studentName: studentName?.trim() || undefined,
          course: course?.trim() || undefined,
          batchLabel: batchLabel?.trim() || undefined,
          studentCode: studentCode?.trim() || undefined,
          issuedOn: issuedOn ? new Date(issuedOn) : undefined,
        },
        include: { generatedBy: { select: employeeSelect } },
      });
      res.json({ success: true, data: cert });
    } catch (err) { next(err); }
  },

  /** Replaces this certificate's photo only — the student's actual profile
   * photo (Student.photo) is never touched, so this is purely a per-
   * certificate override (e.g. a better-cropped/positioned version). */
  async uploadPhoto(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const file = req.file as Express.Multer.File | undefined;
      if (!file) throw new AppError('No photo uploaded', 400);
      const photoUrl = `/uploads/certificate-photos/${file.filename}`;
      const cert = await prisma.batchCertificate.update({
        where: { id: req.params.id },
        data: { photoUrl },
      });
      res.json({ success: true, data: cert });
    } catch (err) { next(err); }
  },

  async remove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.batchCertificate.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Certificate deleted' });
    } catch (err) { next(err); }
  },

  /** Emails the certificate directly to the student, CC'ing the fixed ops
   * addresses above. The PDF itself is rendered client-side (it's the live
   * React template, not something this backend can re-render) and arrives
   * here as a plain upload — never written to disk, just forwarded straight
   * into the email attachment and discarded. */
  async emailCertificate(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const file = req.file as Express.Multer.File | undefined;
      if (!file) throw new AppError('No PDF was uploaded to send', 400);

      const cert = await prisma.batchCertificate.findUnique({
        where: { id: req.params.id },
        include: { student: { select: { email: true } } },
      });
      if (!cert) throw new AppError('Certificate not found', 404);

      const studentEmail = (cert.student.email || '').trim();
      if (!studentEmail || studentEmail.endsWith('.local')) {
        throw new AppError('This student has no real email on file to send the certificate to', 400);
      }

      const filename = `${cert.studentName.replace(/[^a-z0-9]+/gi, '_')}_${cert.certNo.replace(/[^a-z0-9]+/gi, '_')}.pdf`;
      const html = `
        <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
          <div style="background:#1e3a8a;padding:24px;text-align:center;">
            <h1 style="color:#fff;margin:0;font-size:22px;">🎓 Course Completion Certificate</h1>
            <p style="color:#93c5fd;margin:6px 0 0;font-size:13px;">Vinsup Skill Academy</p>
          </div>
          <div style="padding:24px;">
            <p>Dear ${cert.studentName},</p>
            <p>Congratulations on successfully completing <strong>${cert.course}</strong>! Your Course Completion Certificate is attached to this email.</p>
            <table style="width:100%;border-collapse:collapse;margin:16px 0;">
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Certificate No.</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${cert.certNo}</td></tr>
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Course</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${cert.course}</td></tr>
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Batch</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${cert.batchLabel}</td></tr>
            </table>
            <p>Congratulations once again, and best wishes for your future endeavors!</p>
            <p style="color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:14px;margin-top:20px;">Vinsup Skill Academy</p>
          </div>
        </div>`;

      await emailService.send({
        to: studentEmail,
        cc: CERTIFICATE_EMAIL_CC,
        subject: `Your Course Completion Certificate — ${cert.course}`,
        html,
        template: 'batch_certificate_delivery',
        attachments: [{ filename, content: file.buffer, contentType: 'application/pdf' }],
      });

      const updated = await prisma.batchCertificate.update({
        where: { id: cert.id },
        data: { emailedAt: new Date(), emailedTo: studentEmail },
        include: { generatedBy: { select: employeeSelect } },
      });

      res.json({ success: true, data: updated, message: `Certificate emailed to ${studentEmail}` });
    } catch (err) { next(err); }
  },
};
