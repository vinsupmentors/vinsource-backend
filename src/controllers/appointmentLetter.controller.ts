import { Response, NextFunction } from 'express';
import { AuthRequest as Request } from '../types';
// @ts-ignore – pdfkit has no bundled types; works fine at runtime
import PDFDocument from 'pdfkit';
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
  return `₹${n.toLocaleString('en-IN')} per month`;
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
  const empCode = emp.employeeCode || '';
  const joiningDate = fmtDate(emp.joiningDate);
  const department = emp.department?.name || '';
  const designation = emp.designation?.name || '';
  const manager = emp.manager ? `${emp.manager.firstName} ${emp.manager.lastName}` : 'N/A';
  const letterDateStr = fmtDate(letter.letterDate);
  const salaryStr = fmtSalary(letter.salary);
  const workLocation = letter.workLocation;
  const employmentType = letter.employmentType;

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 60, size: 'A4' });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const pageW = doc.page.width;
    const marginL = 60;
    const contentW = pageW - marginL * 2;
    const blue = '#1e3a8a';
    const black = '#000000';
    const gray = '#555555';

    // ── Header ────────────────────────────────────────────────────────────
    doc
      .fontSize(16)
      .font('Helvetica-Bold')
      .fillColor(blue)
      .text('VINSUP SKILL ACADEMY', marginL, 60, { align: 'center', width: contentW });

    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(gray)
      .text(
        '148 A,B, Gopalaswamy Kovil Street, Ganapathy, Coimbatore - 641006 | +91 88700 60607',
        marginL,
        doc.y + 2,
        { align: 'center', width: contentW },
      );

    // Divider
    doc
      .moveDown(0.4)
      .moveTo(marginL, doc.y)
      .lineTo(pageW - marginL, doc.y)
      .lineWidth(1)
      .strokeColor(blue)
      .stroke();

    // Title
    doc
      .moveDown(0.6)
      .fontSize(13)
      .font('Helvetica-Bold')
      .fillColor(blue)
      .text('APPOINTMENT LETTER', marginL, doc.y, { align: 'center', width: contentW });

    doc.moveDown(0.8);

    // Date + Ref
    doc
      .fontSize(10)
      .font('Helvetica')
      .fillColor(black)
      .text(`Date: ${letterDateStr}`, marginL);

    doc.moveDown(0.5);

    // Greeting
    doc
      .font('Helvetica-Bold')
      .text(`Dear ${fullName},`, marginL)
      .moveDown(0.4)
      .font('Helvetica')
      .text(
        'We are pleased to offer you the position in our organisation on the following terms and conditions:',
        marginL,
        doc.y,
        { width: contentW },
      );

    doc.moveDown(0.8);

    // ── Details table ────────────────────────────────────────────────────
    const rows: [string, string][] = [
      ['Employee Name', fullName],
      ['Employee ID', empCode],
      ['Date of Joining', joiningDate],
      ['Work Location', workLocation],
      ['Department', department],
      ['Designation', designation],
      ['Reporting Manager', manager],
      ['Employment Type', employmentType],
      ['Monthly Salary (CTC)', salaryStr],
    ];

    const col1W = 160;
    const col2W = contentW - col1W;
    let rowY = doc.y;

    rows.forEach(([label, value], idx) => {
      const bg = idx % 2 === 0 ? '#f0f4ff' : '#ffffff';

      // Row bg
      doc.rect(marginL, rowY, contentW, 18).fillColor(bg).fill();

      // Col divider
      doc
        .moveTo(marginL + col1W, rowY)
        .lineTo(marginL + col1W, rowY + 18)
        .lineWidth(0.5)
        .strokeColor('#cccccc')
        .stroke();

      // Text
      doc
        .fontSize(9)
        .font('Helvetica-Bold')
        .fillColor('#1e3a8a')
        .text(label, marginL + 4, rowY + 4, { width: col1W - 8 });

      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor(black)
        .text(value, marginL + col1W + 6, rowY + 4, { width: col2W - 10 });

      rowY += 18;
    });

    // Table border
    doc
      .rect(marginL, doc.y - rows.length * 18, contentW, rows.length * 18)
      .lineWidth(0.8)
      .strokeColor('#aaaaaa')
      .stroke();

    doc.y = rowY + 8;
    doc.moveDown(0.6);

    // ── Clauses ──────────────────────────────────────────────────────────
    const clauses: { title: string; body: string }[] = [
      {
        title: '1. Leave Policy',
        body: 'You will be entitled to leaves as per the company leave policy. The leave policy details will be shared during onboarding.',
      },
      {
        title: '2. Probation Period',
        body: 'You will be on probation for a period of 3 (three) months from the date of joining. During probation, either party may terminate employment with 7 days\' notice.',
      },
      {
        title: '3. Confidentiality',
        body: 'You shall keep confidential all proprietary information, business plans, client data, and trade secrets of the company, both during and after your employment.',
      },
      {
        title: '4. Intellectual Property',
        body: 'All work, inventions, discoveries, and improvements made during your employment shall be the exclusive property of Vinsup Skill Academy.',
      },
      {
        title: '5. Code of Conduct',
        body: 'You are expected to conduct yourself in a professional and ethical manner consistent with company policies and values.',
      },
      {
        title: '6. Notice Period',
        body: 'After confirmation, either party may terminate this employment by giving 30 (thirty) days\' written notice or payment of salary in lieu thereof.',
      },
      {
        title: '7. Non-Compete & Non-Solicitation',
        body: 'During your employment and for a period of 12 months thereafter, you shall not directly or indirectly solicit or engage with any client or employee of the company for competing purposes.',
      },
      {
        title: '8. Company Policies',
        body: 'This offer is subject to the terms of employment as per the company\'s HR policies. By accepting this letter, you agree to abide by all company policies as updated from time to time.',
      },
      {
        title: '9. Governing Law',
        body: 'This appointment letter shall be governed by the laws of India, and any disputes shall be subject to the exclusive jurisdiction of courts in Coimbatore.',
      },
    ];

    // Check if we need a new page
    const clauseEstHeight = clauses.length * 42;
    if (doc.y + clauseEstHeight > doc.page.height - 140) {
      doc.addPage();
    }

    doc
      .fontSize(10)
      .font('Helvetica-Bold')
      .fillColor(blue)
      .text('Terms and Conditions', marginL);
    doc.moveDown(0.3);

    clauses.forEach((clause) => {
      // Check for page break per clause
      if (doc.y > doc.page.height - 120) doc.addPage();

      doc
        .fontSize(9)
        .font('Helvetica-Bold')
        .fillColor(black)
        .text(clause.title, marginL, doc.y, { width: contentW });

      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor(gray)
        .text(clause.body, marginL + 10, doc.y + 2, { width: contentW - 10 });

      doc.moveDown(0.5);
    });

    // Custom clauses if any
    if (letter.customClauses) {
      doc
        .fontSize(9)
        .font('Helvetica')
        .fillColor(gray)
        .text(letter.customClauses, marginL, doc.y, { width: contentW });
      doc.moveDown(0.4);
    }

    // ── Acceptance ───────────────────────────────────────────────────────
    if (doc.y > doc.page.height - 140) doc.addPage();

    doc.moveDown(0.4);
    doc
      .fontSize(9)
      .font('Helvetica')
      .fillColor(black)
      .text(
        'Please sign and return a copy of this letter as a token of your acceptance of the terms and conditions mentioned herein.',
        marginL,
        doc.y,
        { width: contentW },
      );

    doc.moveDown(1.2);

    // Signature block
    const sigY = doc.y;
    const colW = contentW / 2;

    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor(black)
      .text('For Vinsup Skill Academy', marginL, sigY);
    doc.moveDown(1.8);
    doc
      .moveTo(marginL, doc.y)
      .lineTo(marginL + 140, doc.y)
      .lineWidth(0.8)
      .strokeColor(black)
      .stroke();
    doc.moveDown(0.2);
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor(black)
      .text('Pooranam Annamalai', marginL);
    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor(gray)
      .text('Chief Business and People Officer (CBPO)', marginL);

    // Employee acceptance
    const empSigX = marginL + colW;
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor(black)
      .text('Employee Acceptance', empSigX, sigY);
    doc.y = sigY;
    doc.moveDown(1.8);
    doc
      .moveTo(empSigX, doc.y)
      .lineTo(empSigX + 140, doc.y)
      .lineWidth(0.8)
      .strokeColor(black)
      .stroke();
    doc.moveDown(0.2);
    doc
      .fontSize(9)
      .font('Helvetica-Bold')
      .fillColor(black)
      .text(fullName, empSigX);
    doc
      .fontSize(8)
      .font('Helvetica')
      .fillColor(gray)
      .text(`Employee ID: ${empCode}`, empSigX);

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
          status: 'DRAFT', // reset to DRAFT if it was REJECTED
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

      // Notify Pooranam — find her user account by name match via employee record
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
