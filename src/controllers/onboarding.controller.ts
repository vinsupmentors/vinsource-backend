import { Response, NextFunction } from 'express';
import bcrypt from 'bcryptjs';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { notificationService } from '../services/notification.service';
import { emailService } from '../services/email.service';
import { config } from '../config/env';

const REQUIRED_DOCS = ['AADHAAR', 'PAN', 'RESUME', 'MARKSHEET_10', 'MARKSHEET_12'];
const GRACE_DAYS = 7;

function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: 10 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

export const onboardingController = {

  // ─── HR: create onboarding request ──────────────────────────────────────────
  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { firstName, lastName, email, phone, gender, joiningDate, departmentId, designationId, branchId, managerId } = req.body;
      if (!firstName || !lastName || !email || !joiningDate) throw new AppError('firstName, lastName, email, joiningDate required', 400);

      const existing = await prisma.onboardingRequest.findFirst({ where: { email } });
      if (existing) throw new AppError('An onboarding request already exists for this email', 409);

      const request = await prisma.onboardingRequest.create({
        data: {
          companyId: req.user!.companyId!,
          firstName, lastName, email, phone, gender, managerId,
          joiningDate: new Date(joiningDate),
          departmentId, designationId, branchId,
          createdById: req.user!.userId,
        },
      });

      // Bell notify other HR members
      const hrUsers = await prisma.user.findMany({
        where: { role: { in: ['HR', 'ADMIN', 'SUPER_ADMIN'] }, employee: { companyId: req.user!.companyId! } },
      });
      for (const hr of hrUsers) {
        if (hr.id !== req.user!.userId) {
          await notificationService.create({
            userId: hr.id, type: 'ONBOARDING_SUBMITTED',
            title: 'New Onboarding Request',
            message: `New onboarding submitted for ${firstName} ${lastName} (${email})`,
            data: { onboardingId: request.id },
          });
        }
      }

      res.status(201).json({ success: true, data: request, message: 'Onboarding request created' });
    } catch (err) { next(err); }
  },

  // ─── HR: list all onboarding requests ───────────────────────────────────────
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { status, page = 1, limit = 20 } = req.query;
      const p = Number(page), l = Number(limit);
      const where: Record<string, unknown> = { companyId: req.user!.companyId! };
      if (status) where.status = status;

      const [requests, total] = await Promise.all([
        prisma.onboardingRequest.findMany({
          where, include: { documents: true },
          orderBy: { createdAt: 'desc' },
          skip: (p - 1) * l, take: l,
        }),
        prisma.onboardingRequest.count({ where }),
      ]);

      res.json({ success: true, data: requests, meta: { total, page: p, limit: l } });
    } catch (err) { next(err); }
  },

  // ─── HR/Employee: get single request ────────────────────────────────────────
  async getById(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const request = await prisma.onboardingRequest.findUnique({
        where: { id: req.params.id },
        include: {
          documents: { orderBy: { createdAt: 'asc' } },
          employee: {
            include: {
              user: { select: { email: true } },
              department: true, designation: true,
              address: true, bankDetails: true,
              education: true, experience: true,
              emergencyContacts: true,
              documents: { orderBy: { uploadedAt: 'desc' } },
            },
          },
        },
      });
      if (!request) throw new AppError('Onboarding request not found', 404);
      if (request.companyId !== req.user!.companyId) throw new AppError('Forbidden', 403);
      res.json({ success: true, data: request });
    } catch (err) { next(err); }
  },

  // ─── Employee: get MY onboarding status ─────────────────────────────────────
  async getMyStatus(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) return res.json({ success: true, data: null });

      const onboarding = await prisma.onboardingRequest.findUnique({
        where: { employeeId: employee.id },
        include: { documents: true },
      });
      if (!onboarding) return res.json({ success: true, data: null });

      // On first login: record it and set document deadline
      if (!onboarding.firstLoginAt) {
        const deadline = new Date();
        deadline.setDate(deadline.getDate() + GRACE_DAYS);
        await prisma.onboardingRequest.update({
          where: { id: onboarding.id },
          data: { firstLoginAt: new Date(), documentDeadline: deadline },
        });
        onboarding.firstLoginAt = new Date();
        onboarding.documentDeadline = deadline;
      }

      // Check uploaded documents
      const uploadedDocs = await prisma.document.findMany({
        where: { employeeId: employee.id },
        select: { type: true },
      });
      const uploadedTypes = uploadedDocs.map(d => d.type);
      const requiredDone = REQUIRED_DOCS.every(t => uploadedTypes.includes(t as any));

      res.json({
        success: true,
        data: {
          ...onboarding,
          requiredDocumentsUploaded: requiredDone,
          uploadedDocTypes: uploadedTypes,
          gracePeriodExpired: onboarding.documentDeadline ? new Date() > onboarding.documentDeadline : false,
          graceDaysLeft: onboarding.documentDeadline
            ? Math.max(0, Math.ceil((onboarding.documentDeadline.getTime() - Date.now()) / 86400000))
            : GRACE_DAYS,
        },
      });
    } catch (err) { next(err); }
  },

  // ─── HR: approve (creates account) ──────────────────────────────────────────
  async approve(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { remarks } = req.body;
      const onb = await prisma.onboardingRequest.findUnique({ where: { id: req.params.id } });
      if (!onb) throw new AppError('Onboarding request not found', 404);
      if (onb.companyId !== req.user!.companyId) throw new AppError('Forbidden', 403);
      if (onb.status !== 'PENDING') throw new AppError('Request is not in PENDING state', 400);

      // Clean up an orphaned User row from a previously-failed approve attempt
      // (e.g. user was created but employee creation failed afterwards, due to
      // a stale branch/department/designation/manager reference).
      const existingUser = await prisma.user.findUnique({
        where: { email: onb.email },
        include: { employee: true },
      });
      if (existingUser) {
        if (existingUser.employee) {
          throw new AppError('An employee account already exists for this email', 409);
        }
        await prisma.user.delete({ where: { id: existingUser.id } });
      }

      // Validate branch/department/designation/manager references — org data may have
      // been restructured since this request was created, leaving stale ids that would
      // otherwise fail the employee insert with a foreign-key error.
      const [branchOk, deptOk, desigOk, managerOk] = await Promise.all([
        onb.branchId ? prisma.branch.findUnique({ where: { id: onb.branchId } }) : null,
        onb.departmentId ? prisma.department.findUnique({ where: { id: onb.departmentId } }) : null,
        onb.designationId ? prisma.designation.findUnique({ where: { id: onb.designationId } }) : null,
        onb.managerId ? prisma.employee.findUnique({ where: { id: onb.managerId } }) : null,
      ]);
      const staleFields: string[] = [];
      if (onb.branchId && !branchOk) staleFields.push('branch');
      if (onb.departmentId && !deptOk) staleFields.push('department');
      if (onb.designationId && !desigOk) staleFields.push('designation');
      if (onb.managerId && !managerOk) staleFields.push('manager');
      if (staleFields.length) {
        console.warn(`Onboarding approve: stale ${staleFields.join(', ')} reference(s) on request ${onb.id} — clearing before account creation.`);
      }

      const tempPassword = generateTempPassword();
      const hashedPassword = await bcrypt.hash(tempPassword, 10);

      const count = await prisma.employee.count({ where: { companyId: onb.companyId } });
      const employeeCode = `EMP${String(count + 1).padStart(4, '0')}`;

      const { newUser, newEmployee } = await prisma.$transaction(async (tx) => {
        const newUser = await tx.user.create({
          data: { email: onb.email, password: hashedPassword, role: 'EMPLOYEE' },
        });

        const newEmployee = await tx.employee.create({
          data: {
            userId: newUser.id,
            companyId: onb.companyId,
            branchId: branchOk ? onb.branchId : undefined,
            departmentId: deptOk ? onb.departmentId : undefined,
            designationId: desigOk ? onb.designationId : undefined,
            managerId: managerOk ? onb.managerId : undefined,
            employeeCode,
            firstName: onb.firstName,
            lastName: onb.lastName,
            email: onb.email,
            phone: onb.phone ?? undefined,
            gender: onb.gender ?? undefined,
            joiningDate: onb.joiningDate,
            status: 'ON_PROBATION',
          },
        });

        await tx.passwordLog.create({
          data: { userId: newUser.id, plainText: tempPassword, setBy: req.user!.userId, reason: 'onboarding' },
        });

        return { newUser, newEmployee };
      });

      const updated = await prisma.onboardingRequest.update({
        where: { id: onb.id },
        data: {
          status: 'ACCOUNT_CREATED',
          hrApprovedById: req.user!.userId,
          hrApprovedAt: new Date(),
          hrRemarks: remarks,
          employeeId: newEmployee.id,
          tempPassword,
        },
      });

      // Welcome email with login credentials + portal link
      await emailService.send({
        to: onb.email,
        subject: '🎉 Welcome to Vin-Source Portal — Your Login Credentials',
        html: emailService.templates.welcomeEmployee({
          firstName: onb.firstName,
          email: onb.email,
          password: tempPassword,
          loginUrl: config.FRONTEND_URL + '/login',
        }),
        template: 'welcomeEmployee',
      }).catch(console.error);

      await notificationService.create({
        userId: newUser.id, type: 'ONBOARDING_DOCUMENT_READY',
        title: 'Welcome! Please complete your profile',
        message: 'Log in and complete your profile and document upload to finish onboarding.',
        data: { onboardingId: onb.id },
      });

      res.json({ success: true, data: updated, message: 'Approved. Employee account created and welcome email sent.' });
    } catch (err) { next(err); }
  },

  // ─── HR: reject ─────────────────────────────────────────────────────────────
  async reject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { reason } = req.body;
      if (!reason) throw new AppError('Rejection reason is required', 400);

      const onb = await prisma.onboardingRequest.findUnique({ where: { id: req.params.id } });
      if (!onb) throw new AppError('Onboarding request not found', 404);
      if (onb.companyId !== req.user!.companyId) throw new AppError('Forbidden', 403);
      if (onb.status !== 'PENDING') throw new AppError('Not in PENDING state', 400);

      const updated = await prisma.onboardingRequest.update({
        where: { id: onb.id },
        data: { status: 'REJECTED', hrApprovedById: req.user!.userId, hrApprovedAt: new Date(), rejectionReason: reason },
      });
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  // ─── Employee: Step 1 — save profile info ───────────────────────────────────
  async completeProfile(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const onb = await prisma.onboardingRequest.findUnique({ where: { employeeId: employee.id } });
      if (!onb) throw new AppError('No onboarding record found', 404);
      if (!['ACCOUNT_CREATED', 'PROFILE_COMPLETE'].includes(onb.status)) {
        throw new AppError('Profile already submitted', 400);
      }

      const {
        // Personal
        firstName, lastName, middleName, dateOfBirth, gender, bloodGroup, maritalStatus,
        phone, personalEmail,
        // Address
        currentAddress, permanentAddress, city, state, country, pincode,
        // Emergency contact
        emergencyName, emergencyRelationship, emergencyPhone, emergencyEmail,
        // Bank
        bankName, accountNumber, ifscCode, accountType,
        // Education (array)
        education,
        // Experience (array)
        experience,
      } = req.body;

      // Update Employee core fields
      await prisma.employee.update({
        where: { id: employee.id },
        data: {
          firstName: firstName || employee.firstName,
          lastName: lastName || employee.lastName,
          middleName, phone, dateOfBirth: dateOfBirth ? new Date(dateOfBirth) : undefined,
          gender, bloodGroup, maritalStatus,
        },
      });

      // Upsert address
      await prisma.employeeAddress.upsert({
        where: { employeeId: employee.id },
        create: { employeeId: employee.id, current: currentAddress, permanent: permanentAddress, city, state, country, pincode },
        update: { current: currentAddress, permanent: permanentAddress, city, state, country, pincode },
      });

      // Emergency contact (delete old + insert new)
      await prisma.emergencyContact.deleteMany({ where: { employeeId: employee.id } });
      if (emergencyName) {
        await prisma.emergencyContact.create({
          data: { employeeId: employee.id, name: emergencyName, relationship: emergencyRelationship || 'Other', phone: emergencyPhone, email: emergencyEmail },
        });
      }

      // Bank detail (delete old + insert new)
      await prisma.bankDetail.deleteMany({ where: { employeeId: employee.id } });
      if (bankName && accountNumber) {
        await prisma.bankDetail.create({
          data: { employeeId: employee.id, bankName, accountNumber, ifscCode: ifscCode || '', accountType, isPrimary: true },
        });
      }

      // Education (delete old + insert new)
      await prisma.education.deleteMany({ where: { employeeId: employee.id } });
      if (Array.isArray(education) && education.length > 0) {
        await prisma.education.createMany({
          data: education.map((e: any) => ({
            employeeId: employee.id,
            degree: e.degree, institution: e.institution,
            fieldOfStudy: e.fieldOfStudy, startYear: e.startYear ? Number(e.startYear) : undefined,
            endYear: e.endYear ? Number(e.endYear) : undefined, grade: e.grade,
          })),
        });
      }

      // Work experience (delete old + insert new)
      await prisma.workExperience.deleteMany({ where: { employeeId: employee.id } });
      if (Array.isArray(experience) && experience.length > 0) {
        await prisma.workExperience.createMany({
          data: experience.map((e: any) => ({
            employeeId: employee.id,
            company: e.company, designation: e.designation,
            startDate: new Date(e.startDate),
            endDate: e.endDate ? new Date(e.endDate) : undefined,
            isCurrent: e.isCurrent || false, description: e.description,
          })),
        });
      }

      // Set document deadline on first profile completion
      const deadline = new Date();
      deadline.setDate(deadline.getDate() + GRACE_DAYS);

      await prisma.onboardingRequest.update({
        where: { id: onb.id },
        data: {
          status: 'PROFILE_COMPLETE',
          profileCompletedAt: new Date(),
          documentDeadline: onb.documentDeadline || deadline,
        },
      });

      res.json({ success: true, message: 'Profile saved. Please upload your documents next.' });
    } catch (err) { next(err); }
  },

  // ─── Employee: Step 2 — submit for HR review (after document uploads) ───────
  async submitForReview(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { policyAgreed, documentsSigned, originalDocsConfirmed, signatureName } = req.body;

      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const onb = await prisma.onboardingRequest.findUnique({ where: { employeeId: employee.id } });
      if (!onb) throw new AppError('No onboarding record found', 404);
      if (onb.status === 'AWAITING_APPROVAL') throw new AppError('Already submitted for review', 400);
      if (onb.status === 'COMPLETED') throw new AppError('Onboarding already completed', 400);

      // Check required documents
      const uploadedDocs = await prisma.document.findMany({ where: { employeeId: employee.id }, select: { type: true } });
      const uploadedTypes = uploadedDocs.map(d => d.type);
      const missing = REQUIRED_DOCS.filter(t => !uploadedTypes.includes(t as any));
      if (missing.length > 0) {
        throw new AppError(`Missing required documents: ${missing.join(', ')}`, 400);
      }

      // Mandatory acknowledgements before HR review can begin
      if (!policyAgreed) throw new AppError('You must agree to the company policy before submitting', 400);
      if (!documentsSigned) throw new AppError('You must sign the onboarding documents before submitting', 400);
      if (!originalDocsConfirmed) throw new AppError('You must confirm submission of original documents before submitting', 400);
      if (!signatureName || !String(signatureName).trim()) throw new AppError('E-signature (full name) is required', 400);

      const now = new Date();
      await prisma.onboardingRequest.update({
        where: { id: onb.id },
        data: {
          status: 'AWAITING_APPROVAL',
          documentsSubmittedAt: now,
          policyAgreedAt: now,
          documentsSignedAt: now,
          originalDocsConfirmedAt: now,
          signatureName: String(signatureName).trim(),
        },
      });

      // Notify HR
      const hrUsers = await prisma.user.findMany({
        where: { role: { in: ['HR', 'ADMIN'] }, employee: { companyId: employee.companyId } },
      });
      for (const hr of hrUsers) {
        await notificationService.create({
          userId: hr.id, type: 'ONBOARDING_SUBMITTED',
          title: 'Onboarding Ready for Review',
          message: `${employee.firstName} ${employee.lastName} has completed their profile and uploaded documents`,
          data: { onboardingId: onb.id, employeeId: employee.id },
        });
      }

      res.json({ success: true, message: 'Submitted for HR review. You will be notified once approved.' });
    } catch (err) { next(err); }
  },

  // ─── HR: final approval after reviewing profile + documents ─────────────────
  async hrFinalApprove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { remarks } = req.body;
      const onb = await prisma.onboardingRequest.findUnique({
        where: { id: req.params.id },
        include: { employee: { include: { user: true } } },
      });
      if (!onb) throw new AppError('Onboarding request not found', 404);
      if (onb.companyId !== req.user!.companyId) throw new AppError('Forbidden', 403);
      if (onb.status !== 'AWAITING_APPROVAL') throw new AppError('Not ready for final approval', 400);

      await prisma.onboardingRequest.update({
        where: { id: onb.id },
        data: {
          status: 'COMPLETED',
          hrFinalApprovedById: req.user!.userId,
          hrFinalApprovedAt: new Date(),
          hrFinalRemarks: remarks,
        },
      });

      if (onb.employeeId) {
        await prisma.employee.update({ where: { id: onb.employeeId }, data: { status: 'ACTIVE' } });
      }

      if (onb.employee?.userId) {
        await notificationService.create({
          userId: onb.employee.userId, type: 'ONBOARDING_APPROVED',
          title: 'Onboarding Approved! Welcome aboard',
          message: 'Your profile and documents have been verified. Your account is now fully active.',
          data: { onboardingId: onb.id },
        });
        await emailService.send({
          to: onb.email,
          subject: 'Onboarding Complete — Welcome to the team!',
          html: `<div style="font-family:sans-serif;max-width:600px;margin:auto;"><div style="background:#16a34a;padding:24px;border-radius:8px 8px 0 0;"><h1 style="color:#fff;margin:0;">Onboarding Complete ✓</h1></div><div style="padding:24px;border:1px solid #e5e7eb;border-radius:0 0 8px 8px;"><p>Dear ${onb.firstName} ${onb.lastName},</p><p>Your profile and documents have been reviewed and approved by HR. Your account is now <strong>fully active</strong>.</p><p>${remarks ? `<em>HR remarks: ${remarks}</em>` : ''}</p></div></div>`,
          template: 'onboarding_final_approved',
        }).catch(console.error);
      }

      res.json({ success: true, message: 'Onboarding approved. Employee is now ACTIVE.' });
    } catch (err) { next(err); }
  },

  // ─── HR: final rejection ────────────────────────────────────────────────────
  async hrFinalReject(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { reason } = req.body;
      if (!reason) throw new AppError('Rejection reason is required', 400);

      const onb = await prisma.onboardingRequest.findUnique({
        where: { id: req.params.id },
        include: { employee: { include: { user: true } } },
      });
      if (!onb) throw new AppError('Onboarding request not found', 404);
      if (onb.companyId !== req.user!.companyId) throw new AppError('Forbidden', 403);

      await prisma.onboardingRequest.update({
        where: { id: onb.id },
        data: {
          status: 'PROFILE_COMPLETE',   // send back for re-submission
          hrFinalRemarks: reason,
          documentsSubmittedAt: null,
        },
      });

      if (onb.employee?.userId) {
        await notificationService.create({
          userId: onb.employee.userId, type: 'ONBOARDING_SUBMITTED',
          title: 'Action Required: Re-submit Documents',
          message: `HR has requested corrections. Reason: ${reason}. Please review and re-submit.`,
          data: { onboardingId: onb.id },
        });
      }

      res.json({ success: true, message: 'Sent back for corrections' });
    } catch (err) { next(err); }
  },
};
