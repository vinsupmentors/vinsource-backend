import { Response, NextFunction } from 'express';
import { AuthRequest as Request } from '../types';
// @ts-ignore – pdfkit has no bundled types; works fine at runtime
import PDFDocument from 'pdfkit';
import path from 'path';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { emailService } from '../services/email.service';
import { config } from '../config/env';

// ─── helpers ────────────────────────────────────────────────────────────────

function fmtDate(d: Date | string | null | undefined): string {
  if (!d) return '';
  const dt = typeof d === 'string' ? new Date(d) : d;
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' });
}

function fmtSalary(n: number): string {
  return `Rs. ${n.toLocaleString('en-IN')}/-`;
}

// ─── PDF generation ─────────────────────────────────────────────────────────

async function generateAppointmentLetterPDF(letterId: string): Promise<Buffer> {
  const letter = await prisma.appointmentLetter.findUnique({
    where: { id: letterId },
    include: {
      employee: {
        include: {
          department: true,
          designation: true,
          manager: true,
        },
      },
    },
  });

  if (!letter) throw new AppError('Letter not found', 404);

  const emp = letter.employee;
  const fullName = `${emp.firstName} ${emp.lastName}`;
  const firstName = emp.firstName;
  const empCode = emp.employeeCode || '';
  const joiningDate = fmtDate(emp.joiningDate);
  const department = emp.department?.name || '';
  const designation = emp.designation?.name || '';
  const manager = emp.manager ? `${emp.manager.firstName} ${emp.manager.lastName}` : 'Pooranam Annamalai';
  const letterDateStr = fmtDate(letter.letterDate);
  const salaryAmt = fmtSalary(letter.salary);
  const workLocation = letter.workLocation;
  const employmentType = letter.employmentType;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 72, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const marginL = 72;
    const contentW = pageW - marginL * 2;
    const black = '#000000';
    const fs = 10.5; // base font size

    // ── draw a filled circle bullet (avoids font-encoding issues with ● character) ──
    const drawDot = (x: number, y: number) => {
      doc.circle(x + 3, y + fs * 0.52, 2.5).fillColor(black).fill();
      doc.fillColor(black);
    };

    // helper: section heading
    const sectionHead = (text: string) => {
      if (doc.y > doc.page.height - 160) doc.addPage();
      doc.moveDown(0.65)
        .fontSize(fs)
        .font('Helvetica-Bold')
        .fillColor(black)
        .text(text, marginL, doc.y, { width: contentW });
      doc.moveDown(0.45);
    };

    // helper: indented paragraph
    const para = (text: string, indent = 20) => {
      doc.fontSize(fs).font('Helvetica').fillColor(black)
        .text(text, marginL + indent, doc.y, { width: contentW - indent, align: 'justify' });
      doc.moveDown(0.45);
    };

    // helper: bullet — dot + bold label + normal rest
    const bullet = (label: string, rest: string, indent = 20) => {
      const bx = marginL + indent;
      const bw = contentW - indent;
      const startY = doc.y;
      drawDot(bx, startY);
      if (label.length > 0) {
        doc.fontSize(fs).font('Helvetica-Bold').fillColor(black)
          .text(label, bx + 10, startY, { continued: rest.length > 0, width: bw - 10 });
        if (rest.length > 0) doc.font('Helvetica').text(rest, { width: bw - 10 });
      } else {
        doc.fontSize(fs).font('Helvetica').fillColor(black)
          .text(rest, bx + 10, startY, { width: bw - 10, align: 'justify' });
      }
      doc.moveDown(0.45);
    };

    // helper: lettered sub-item
    const subItem = (ltr: string, txt: string, indent = 50) => {
      doc.fontSize(fs).font('Helvetica').fillColor(black)
        .text(`${ltr})  ${txt}`, marginL + indent, doc.y, { width: contentW - indent });
      doc.moveDown(0.35);
    };

    // ── Logo (top-right) ──────────────────────────────────────────────────
    const logoPath = path.join(process.cwd(), 'assets', 'vinsup-logo.png');
    try {
      doc.image(logoPath, pageW - 155, 30, { width: 110 });
    } catch (_) {
      // fallback text if logo file missing
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#c00000')
        .text('VINSUP', pageW - 160, 40, { width: 110 });
      doc.fontSize(7).font('Helvetica-Bold').fillColor('#1e3a8a')
        .text('SKILL  ACADEMY', pageW - 160, doc.y, { width: 110 });
      doc.fontSize(6.5).font('Helvetica').fillColor('#c00000')
        .text('Building Future — Ready Professionals', pageW - 165, doc.y, { width: 115 });
    }

    // ── Title ─────────────────────────────────────────────────────────────
    doc.fontSize(13).font('Helvetica-Bold').fillColor(black)
      .text('Appointment Letter', marginL, 62, { align: 'center', width: contentW });

    doc.moveDown(1.4);

    // ── Date / Name / Employee ID ─────────────────────────────────────────
    doc.fontSize(fs).font('Helvetica-Bold').fillColor(black)
      .text(`Date: ${letterDateStr}`, marginL);
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').text(`Name: ${fullName}`, marginL);
    doc.moveDown(0.4);
    doc.font('Helvetica-Bold').text(`Employee ID: ${empCode}`, marginL);
    doc.moveDown(0.8);

    // ── Salutation ────────────────────────────────────────────────────────
    doc.font('Helvetica-Bold').text(`Dear ${firstName},`, marginL);
    doc.moveDown(0.6);

    // Opening paragraph
    doc.fontSize(fs).font('Helvetica').fillColor(black)
      .text(
        'With reference to your application and discussions you had with us, we are pleased to offer you an appointment in our company, on the following Terms and Conditions:',
        marginL, doc.y, { width: contentW, align: 'justify' },
      );
    doc.moveDown(0.7);

    // ── 1. Date of Joining & Work Location ───────────────────────────────
    sectionHead('1. Date of Joining & Work Location:');
    doc.fontSize(fs).font('Helvetica').fillColor(black)
      .text('Your appointment becomes effective from ', marginL + 20, doc.y, { continued: true, width: contentW - 20 });
    doc.font('Helvetica-Bold').text(joiningDate, { continued: true });
    doc.font('Helvetica').text(' and your work location would be ', { continued: true });
    doc.font('Helvetica-Bold').text(workLocation + '.', { continued: false });
    doc.moveDown(0.45);
    para('The company reserves the right to transfer you to any location, as the company may deem fit, from time to time.');

    // ── 2. Department, Designation & Reporting Manager ────────────────────
    sectionHead('2. Department, Designation & Reporting Manager:');
    const indent2 = 30;

    const detailRow = (label: string, value: string) => {
      // Print "Label: " in normal weight then value in bold on the same line
      doc.fontSize(fs).font('Helvetica').fillColor(black)
        .text(`${label}: `, marginL + indent2, doc.y, { continued: true, width: contentW - indent2 });
      doc.font('Helvetica-Bold').text(value, { width: contentW - indent2 });
      doc.moveDown(0.4);
    };

    detailRow('Department', department);
    detailRow('Designation', designation);
    detailRow('Reporting Manager', manager);
    detailRow('Employment Type', employmentType);

    // ── 3. Cost to the Company ────────────────────────────────────────────
    sectionHead('3. Cost to the Company:');
    {
      const startY = doc.y;
      drawDot(marginL + 20, startY);
      doc.fontSize(fs).font('Helvetica').fillColor(black)
        .text('Your monthly compensation including performance pay and benefits is ', marginL + 30, startY, { continued: true, width: contentW - 30 });
      doc.font('Helvetica-Bold').text(salaryAmt + '.', { continued: true });
      doc.font('Helvetica').text(' Your salary will be revised yearly based on your satisfactory performance in the company determined at the sole discretion of the company.');
      doc.moveDown(0.45);
    }

    para(
      'The company shall be determined to deduct the remuneration payable to you post the probation period, the following statutory and compulsory deductions:',
      0,
    );
    subItem('a', 'Provident Fund');
    subItem('b', 'Income tax deducted at source at the rates applicable');
    subItem('c', 'Professional Tax');

    // ── 4. Work Schedule ──────────────────────────────────────────────────
    sectionHead('4. Work Schedule:');
    bullet('Working Hours : ', '9:00 AM to 6:00 PM, Monday to Saturday');
    bullet('Weekly Off: ', 'Sunday');
    doc.moveDown(0.25);

    // Note
    doc.fontSize(fs).font('Helvetica-Bold').fillColor(black)
      .text('Note: ', marginL, doc.y, { continued: true, width: contentW });
    doc.font('Helvetica').text('The ', { continued: true });
    doc.font('Helvetica-Bold').text('weekly off', { continued: true });
    doc.font('Helvetica').text(' will be assigned on a ', { continued: true });
    doc.font('Helvetica-Bold').text('rotational basis', { continued: true });
    doc.font('Helvetica').text(' based on business requirements. The specific day may ', { continued: true });
    doc.font('Helvetica-Bold').text('vary by department', { continued: true });
    doc.font('Helvetica').text('. We appreciate your flexibility and cooperation.');
    doc.moveDown(0.45);

    // ── 5. Leave Policy ───────────────────────────────────────────────────
    sectionHead('5. Leave Policy:');
    bullet('Casual Leave: ', 'You are entitled to 1 day per month prior approval from the Reporting Manager. The unused leaves can be carried forward within the same financial year.');
    bullet('Public Holidays: ', 'The company observes 10 public holidays per year as per the company calendar.');

    // ── 6. Notice and Probation Period ────────────────────────────────────
    if (doc.y > doc.page.height - 180) doc.addPage();
    sectionHead('6. Notice and Probation Period:');
    {
      const startY = doc.y;
      drawDot(marginL + 20, startY);
      doc.fontSize(fs).font('Helvetica').fillColor(black)
        .text('You will be on a probation period of ', marginL + 30, startY, { continued: true, width: contentW - 30 });
      doc.font('Helvetica-Bold').text('3 months', { continued: true });
      doc.font('Helvetica').text(' from the date of joining. Based on satisfactory performance, you will be confirmed as a permanent employee. After confirmation, the notice period will be ', { continued: true });
      doc.font('Helvetica-Bold').text('60 days', { continued: true });
      doc.font('Helvetica').text(' from either side.');
      doc.moveDown(0.45);
    }
    bullet('', 'During the probation period, no leaves are entertained other than your weekly-off and company declared holidays.');

    // ── 7. Confidential Information ───────────────────────────────────────
    sectionHead('7. Confidential Information:');
    bullet('', "As an employee, you may come into possession of confidential information to the Company and agree to keep confidential, the Company's proprietary and confidential information obtained at any time during the period of your employment in the Company. Confidential information includes, and is not limited to; course material, videos, financial documents and other relevant documents. You shall not disclose such Confidential Information to any person. You shall not make any copies of the Confidential Information.");

    // ── 8. Code of Conduct ────────────────────────────────────────────────
    if (doc.y > doc.page.height - 200) doc.addPage();
    sectionHead('8. Code of Conduct:');
    bullet('', "You are expected to adhere to the company's Code of Conduct and uphold professional behavior at all times. Any breach of policy or misconduct may lead to disciplinary action, including termination.");

    // ── 9. Retirement ─────────────────────────────────────────────────────
    sectionHead('9. Retirement:');
    bullet('', 'The age of Superannuating of an employee from Company Service is 60 years. You shall however, during your employment be required to be medically fit for the work for which you have been employed. As to whether an employee is medically fit, is an issue that will be professionally determined by the Company and the employee shall be bound by such determination. You will accordingly undergo periodic medical examination as and when intimated to you by the Company. The Company shall have the right to terminate your services immediately, in the event you are found to be medically unfit to perform your duties and responsibilities.');

    // Custom clauses if any
    if (letter.customClauses) {
      doc.moveDown(0.4);
      doc.fontSize(fs).font('Helvetica').fillColor(black)
        .text(letter.customClauses, marginL, doc.y, { width: contentW });
    }

    // ── Closing ───────────────────────────────────────────────────────────
    if (doc.y > doc.page.height - 180) doc.addPage();
    doc.moveDown(0.8);
    doc.fontSize(fs).font('Helvetica').fillColor(black)
      .text(
        'We are excited to welcome you onboard and are confident that your association with the Company will offer you valuable challenges, professional satisfaction, and growth opportunities.',
        marginL, doc.y, { width: contentW, align: 'justify' },
      );

    // ── Signature ─────────────────────────────────────────────────────────
    doc.moveDown(1.5);
    doc.fontSize(fs).font('Helvetica-Bold').fillColor(black).text('Sincerely,', marginL);
    doc.moveDown(1.0);
    doc.font('Helvetica-Bold').text('Pooranam Annamalai', marginL);
    doc.moveDown(0.25);
    doc.font('Helvetica-Bold').text('Chief Business & Production Officer', marginL);
    doc.moveDown(0.25);
    doc.font('Helvetica-Bold').text('Vinsup Skill Academy', marginL);
    doc.moveDown(0.25);
    doc.font('Helvetica-Bold').text('148 A,B, Gopalaswamy Kovil Street, Ganapathy, Coimbatore - 641006.', marginL);
    doc.moveDown(0.25);
    doc.font('Helvetica-Bold').text('+91 88700 60607', marginL);

    doc.end();
  });
}

// ─── Controller ──────────────────────────────────────────────────────────────

export const appointmentLetterController = {
  // GET /api/appointment-letters  — list (HR/SUPER_ADMIN see all; others see their own)
  async list(req: Request, res: Response, next: NextFunction) {
    try {
      const user = req.user!;
      const isSuperAdmin = user.role === 'SUPER_ADMIN';
      const isHR = user.role === 'HR' || user.role === 'ADMIN';

      const letters = await prisma.appointmentLetter.findMany({
        where: isSuperAdmin || isHR ? {} : { createdById: user.userId },
        include: {
          employee: {
            include: { department: true, designation: true },
          },
          createdBy: { select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } },
          approvedBy: { select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } },
        },
        orderBy: { createdAt: 'desc' },
      });

      res.json({ success: true, data: letters });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/appointment-letters/:id
  async get(req: Request, res: Response, next: NextFunction) {
    try {
      const letter = await prisma.appointmentLetter.findUnique({
        where: { id: req.params.id },
        include: {
          employee: {
            include: { department: true, designation: true, manager: true },
          },
          createdBy: { select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } },
          approvedBy: { select: { id: true, email: true, employee: { select: { firstName: true, lastName: true } } } },
        },
      });
      if (!letter) throw new AppError('Letter not found', 404);
      res.json({ success: true, data: letter });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/appointment-letters  — HR creates a draft
  async create(req: Request, res: Response, next: NextFunction) {
    try {
      const { employeeId, letterDate, salary, employmentType, workLocation, customClauses } = req.body;

      if (!employeeId || !letterDate || !salary || !workLocation) {
        throw new AppError('employeeId, letterDate, salary, and workLocation are required', 400);
      }

      const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const letter = await prisma.appointmentLetter.create({
        data: {
          employeeId,
          letterDate: new Date(letterDate),
          salary: Number(salary),
          employmentType: employmentType || 'Full Time',
          workLocation,
          customClauses: customClauses || null,
          createdById: req.user!.userId,
          status: 'DRAFT',
        },
        include: {
          employee: { include: { department: true, designation: true } },
        },
      });

      res.status(201).json({ success: true, data: letter });
    } catch (err) {
      next(err);
    }
  },

  // PUT /api/appointment-letters/:id  — edit DRAFT
  async update(req: Request, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.appointmentLetter.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Letter not found', 404);
      if (existing.status !== 'DRAFT' && existing.status !== 'REJECTED') {
        throw new AppError('Only DRAFT or REJECTED letters can be edited', 400);
      }

      const { letterDate, salary, employmentType, workLocation, customClauses } = req.body;

      const updated = await prisma.appointmentLetter.update({
        where: { id: req.params.id },
        data: {
          ...(letterDate && { letterDate: new Date(letterDate) }),
          ...(salary !== undefined && { salary: Number(salary) }),
          ...(employmentType && { employmentType }),
          ...(workLocation && { workLocation }),
          ...(customClauses !== undefined && { customClauses }),
          status: 'DRAFT',
        },
        include: {
          employee: { include: { department: true, designation: true } },
        },
      });

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/appointment-letters/:id/submit  — HR submits for approval
  async submit(req: Request, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.appointmentLetter.findUnique({
        where: { id: req.params.id },
        include: {
          employee: { include: { department: true, designation: true } },
        },
      });
      if (!existing) throw new AppError('Letter not found', 404);
      if (existing.status !== 'DRAFT' && existing.status !== 'REJECTED') {
        throw new AppError('Only DRAFT or REJECTED letters can be submitted', 400);
      }

      const updated = await prisma.appointmentLetter.update({
        where: { id: req.params.id },
        data: { status: 'PENDING_APPROVAL' },
      });

      // Notify Pooranam
      try {
        const approver = await prisma.employee.findFirst({
          where: {
            OR: [{ firstName: 'Pooranam' }, { lastName: 'Annamalai' }],
          },
          include: { user: true },
        });

        const approverEmail = approver?.user?.email || config.EMAIL_FROM;
        const approverName = approver
          ? `${approver.firstName} ${approver.lastName}`
          : 'Pooranam Annamalai';
        const empName = `${existing.employee.firstName} ${existing.employee.lastName}`;
        const portalUrl = config.FRONTEND_URL || 'https://hrms.vinsupskillacademy.com';

        await emailService.send({
          to: approverEmail,
          subject: `Appointment Letter Approval Required — ${empName}`,
          html: emailService.templates.appointmentLetterApproval({
            approverName,
            employeeName: empName,
            letterId: existing.id,
            portalUrl: `${portalUrl}/appointment-letters`,
          }),
          template: 'appointmentLetterApproval',
        });
      } catch (_emailErr) {
        // Don't fail the submit if notification email fails
      }

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  },

  // POST /api/appointment-letters/:id/approve  — Pooranam/SUPER_ADMIN approves
  async approve(req: Request, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.appointmentLetter.findUnique({
        where: { id: req.params.id },
        include: {
          employee: {
            include: { department: true, designation: true, manager: true },
          },
        },
      });
      if (!existing) throw new AppError('Letter not found', 404);
      if (existing.status !== 'PENDING_APPROVAL') {
        throw new AppError('Letter is not pending approval', 400);
      }

      // Generate PDF
      const pdfBuffer = await generateAppointmentLetterPDF(req.params.id);

      const emp = existing.employee;
      const fullName = `${emp.firstName} ${emp.lastName}`;
      const personalEmail = emp.email;

      if (!personalEmail) throw new AppError('Employee has no personal email on record', 400);

      // Mark approved first
      const updated = await prisma.appointmentLetter.update({
        where: { id: req.params.id },
        data: {
          status: 'APPROVED',
          approvedById: req.user!.userId,
          approvedAt: new Date(),
        },
      });

      // Send PDF to employee's personal email
      try {
        await emailService.send({
          to: personalEmail,
          subject: `Your Appointment Letter — Vinsup Skill Academy`,
          html: emailService.templates.appointmentLetterToEmployee({
            employeeName: fullName,
            joiningDate: fmtDate(emp.joiningDate),
            designation: emp.designation?.name || '',
            department: emp.department?.name || '',
          }),
          attachments: [
            {
              filename: `Appointment_Letter_${fullName.replace(/\s+/g, '_')}.pdf`,
              content: pdfBuffer,
              contentType: 'application/pdf',
            },
          ],
          template: 'appointmentLetterToEmployee',
        });

        // Mark as SENT
        await prisma.appointmentLetter.update({
          where: { id: req.params.id },
          data: { status: 'SENT', sentAt: new Date() },
        });

        res.json({ success: true, data: { ...updated, status: 'SENT' }, message: 'Letter approved and emailed to employee.' });
      } catch (emailErr) {
        // Approved but email failed — keep APPROVED status, tell the caller
        res.json({
          success: true,
          data: updated,
          warning: 'Letter approved but email delivery failed. Download and send manually.',
        });
      }
    } catch (err) {
      next(err);
    }
  },

  // POST /api/appointment-letters/:id/reject  — Pooranam/SUPER_ADMIN rejects
  async reject(req: Request, res: Response, next: NextFunction) {
    try {
      const { rejectionNote } = req.body;
      const existing = await prisma.appointmentLetter.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Letter not found', 404);
      if (existing.status !== 'PENDING_APPROVAL') {
        throw new AppError('Letter is not pending approval', 400);
      }

      const updated = await prisma.appointmentLetter.update({
        where: { id: req.params.id },
        data: {
          status: 'REJECTED',
          rejectionNote: rejectionNote || null,
          approvedById: req.user!.userId,
        },
      });

      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  },

  // GET /api/appointment-letters/:id/pdf  — download PDF
  async downloadPdf(req: Request, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.appointmentLetter.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Letter not found', 404);

      const emp = await prisma.employee.findUnique({ where: { id: existing.employeeId } });
      const safeName = emp ? `${emp.firstName}_${emp.lastName}` : 'Employee';

      const pdfBuffer = await generateAppointmentLetterPDF(req.params.id);

      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="Appointment_Letter_${safeName}.pdf"`);
      res.send(pdfBuffer);
    } catch (err) {
      next(err);
    }
  },

  // DELETE /api/appointment-letters/:id  — delete DRAFT only
  async remove(req: Request, res: Response, next: NextFunction) {
    try {
      const existing = await prisma.appointmentLetter.findUnique({ where: { id: req.params.id } });
      if (!existing) throw new AppError('Letter not found', 404);
      if (existing.status !== 'DRAFT') {
        throw new AppError('Only DRAFT letters can be deleted', 400);
      }
      await prisma.appointmentLetter.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Deleted' });
    } catch (err) {
      next(err);
    }
  },
};
