import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { hashPassword, paginate, formatPagination, generateEmployeeCode, calcSalaryFromNet } from '../utils/helpers';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { emailService } from '../services/email.service';
import { config } from '../config/env';

export const employeeController = {
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 20, search, departmentId, status, branchId } = req.query;
      const p = Number(page), l = Number(limit);

      const where: Record<string, unknown> = { companyId: req.user!.companyId };
      if (departmentId) where.departmentId = departmentId;
      if (branchId) where.branchId = branchId;
      if (status) where.status = status;
      if (search) {
        where.OR = [
          { firstName: { contains: String(search), mode: 'insensitive' } },
          { lastName: { contains: String(search), mode: 'insensitive' } },
          { employeeCode: { contains: String(search), mode: 'insensitive' } },
          { email: { contains: String(search), mode: 'insensitive' } },
        ];
      }

      const [employees, total] = await Promise.all([
        prisma.employee.findMany({
          where,
          include: {
            department: { select: { name: true } },
            designation: { select: { name: true } },
            branch: { select: { name: true } },
            user: { select: { email: true, role: true, isActive: true } },
          },
          orderBy: { createdAt: 'desc' },
          ...paginate(p, l),
        }),
        prisma.employee.count({ where }),
      ]);

      res.json({ success: true, data: employees, meta: formatPagination(total, p, l) });
    } catch (err) { next(err); }
  },

  async get(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({
        where: { id: req.params.id },
        include: {
          user: { select: { email: true, role: true, isActive: true, lastLoginAt: true } },
          department: true,
          designation: true,
          branch: true,
          manager: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
          address: true,
          bankDetails: true,
          emergencyContacts: true,
          education: true,
          experience: true,
          certifications: true,
          skills: { include: { skill: true } },
          documents: true,
          assets: { include: { asset: true } },
          salaryStructure: true,
        },
      });
      if (!employee) throw new AppError('Employee not found', 404);
      res.json({ success: true, data: employee });
    } catch (err) { next(err); }
  },

  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const body = req.body;
      const tempPassword = `Hrms@${Math.random().toString(36).slice(-6)}`;
      const hashedPwd = await hashPassword(tempPassword);

      const count = await prisma.employee.count({ where: { companyId: body.companyId } });
      const employeeCode = generateEmployeeCode('EMP', count);

      const employee = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: body.email.toLowerCase(),
            password: hashedPwd,
            role: body.role || 'EMPLOYEE',
          },
        });

        const emp = await tx.employee.create({
          data: {
            userId: user.id,
            companyId: body.companyId || req.user!.companyId!,
            branchId: body.branchId,
            departmentId: body.departmentId,
            designationId: body.designationId,
            managerId: body.managerId,
            employeeCode,
            firstName: body.firstName,
            lastName: body.lastName,
            middleName: body.middleName,
            email: body.email.toLowerCase(),
            phone: body.phone,
            dateOfBirth: body.dateOfBirth ? new Date(body.dateOfBirth) : undefined,
            gender: body.gender,
            joiningDate: new Date(body.joiningDate),
            probationEndDate: body.probationEndDate ? new Date(body.probationEndDate) : undefined,
            status: body.isProbation === false ? 'ACTIVE' : 'ON_PROBATION',
          },
        });

        // Save salary structure if HR provided a net take-home
        if (body.netSalary && Number(body.netSalary) > 0) {
          const hasPf = Boolean(body.hasPf);
          const components = calcSalaryFromNet(Number(body.netSalary), hasPf);
          await tx.salaryStructure.create({
            data: {
              employeeId: emp.id,
              netSalary: components.netSalary,
              grossSalary: components.grossSalary,
              basic: components.basic,
              hra: components.hra,
              conveyance: components.conveyance,
              medicalAllowance: components.medicalAllowance,
              specialAllowance: components.specialAllowance,
              hasPf,
              pf: components.pf,
              esi: components.esi,
              professionalTax: components.professionalTax,
              tds: components.tds,
            },
          });
        }

        // Seed CL balance for existing (non-probation) employees
        const clBalance = Number(body.currentCLBalance) || 0;
        if (body.isProbation === false && clBalance > 0) {
          const clType = await tx.companyLeaveType.findFirst({
            where: { companyId: body.companyId || req.user!.companyId!, type: 'CASUAL', isActive: true },
          });
          if (clType) {
            await tx.leaveBalance.create({
              data: {
                employeeId: emp.id,
                leaveTypeId: clType.id,
                year: new Date().getFullYear(),
                totalDays: clBalance,
                usedDays: 0,
                pendingDays: 0,
              },
            });
          }
        }

        return emp;
      });

      // Store plain-text password for admin recovery (onboarding)
      prisma.passwordLog.create({
        data: {
          userId: employee.userId,
          plainText: tempPassword,
          setBy: req.user!.userId,
          reason: 'onboarding',
        },
      }).catch(() => {});

      // Send welcome email
      await emailService.send({
        to: body.email,
        subject: 'Welcome to HRMS',
        html: emailService.templates.welcomeEmployee({
          firstName: body.firstName,
          email: body.email,
          password: tempPassword,
          loginUrl: config.FRONTEND_URL,
        }),
        template: 'welcome_employee',
      }).catch(console.error);

      res.status(201).json({
        success: true,
        message: 'Employee created',
        data: { ...employee, tempPassword }, // return temp password in response for HR to note
      });
    } catch (err) { next(err); }
  },

  async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const body = req.body;
      const employee = await prisma.employee.update({
        where: { id: req.params.id },
        data: {
          firstName: body.firstName,
          lastName: body.lastName,
          phone: body.phone,
          gender: body.gender,
          maritalStatus: body.maritalStatus,
          bloodGroup: body.bloodGroup,
          departmentId: body.departmentId,
          designationId: body.designationId,
          branchId: body.branchId,
          managerId: body.managerId,
          status: body.status,
          confirmationDate: body.confirmationDate ? new Date(body.confirmationDate) : undefined,
        },
      });
      res.json({ success: true, data: employee });
    } catch (err) { next(err); }
  },

  async getMyProfile(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({
        where: { userId: req.user!.userId },
        include: {
          department: true,
          designation: true,
          branch: true,
          manager: { select: { firstName: true, lastName: true } },
          address: true,
          bankDetails: true,
          emergencyContacts: true,
          education: true,
          experience: true,
          certifications: true,
          skills: { include: { skill: true } },
          leaveBalances: { include: { leaveType: true } },
        },
      });
      res.json({ success: true, data: employee });
    } catch (err) { next(err); }
  },

  // HR: update/create salary structure for an employee
  async updateSalary(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const { netSalary, hasPf } = req.body;
      if (!netSalary || Number(netSalary) <= 0) throw new AppError('Valid net salary required', 400);

      const components = calcSalaryFromNet(Number(netSalary), Boolean(hasPf));

      const data = {
        netSalary: components.netSalary,
        grossSalary: components.grossSalary,
        basic: components.basic,
        hra: components.hra,
        conveyance: components.conveyance,
        medicalAllowance: components.medicalAllowance,
        specialAllowance: components.specialAllowance,
        hasPf: Boolean(hasPf),
        pf: components.pf,
        esi: components.esi,
        professionalTax: components.professionalTax,
        tds: components.tds,
      };

      const sal = await prisma.salaryStructure.upsert({
        where: { employeeId: id },
        create: { employeeId: id, ...data },
        update: data,
      });

      res.json({ success: true, data: sal });
    } catch (err) { next(err); }
  },

  // HR: preview salary breakdown without saving
  async calcSalary(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { net, hasPf } = req.body;
      if (!net || Number(net) <= 0) throw new AppError('Valid net salary required', 400);
      const components = calcSalaryFromNet(Number(net), Boolean(hasPf));
      res.json({ success: true, data: components });
    } catch (err) { next(err); }
  },

  async getDirectReports(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const reports = await prisma.employee.findMany({
        where: { managerId: employee.id },
        include: {
          department: { select: { name: true } },
          designation: { select: { name: true } },
        },
      });
      res.json({ success: true, data: reports });
    } catch (err) { next(err); }
  },
};
