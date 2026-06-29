import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { notificationService } from '../services/notification.service';
import { emailService } from '../services/email.service';
import { getDateRange, calcLOP, calcSalaryFromNet } from '../utils/helpers';

const MONTH_NAMES = ['January','February','March','April','May','June','July','August','September','October','November','December'];

export const payrollController = {
  async process(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { month, year, companyId } = req.body;
      const cId = companyId || req.user!.companyId!;

      // Create or fetch payroll record
      let payroll = await prisma.payroll.findUnique({
        where: { companyId_month_year: { companyId: cId, month, year } },
      });

      if (payroll && payroll.status !== 'DRAFT') {
        throw new AppError('Payroll already processed for this month', 400);
      }

      if (!payroll) {
        payroll = await prisma.payroll.create({
          data: { companyId: cId, month, year, status: 'DRAFT' },
        });
      }

      const { start, end } = getDateRange(month, year);
      const employees = await prisma.employee.findMany({
        where: { companyId: cId, status: 'ACTIVE' },
        include: {
          bankDetails: { where: { isPrimary: true }, take: 1 },
          salaryStructure: true,
        },
      });

      const workingDaysInMonth = 26; // configurable

      const payslips = await Promise.all(
        employees.map(async (emp) => {
          // Fetch attendance
          const attendance = await prisma.attendance.findMany({
            where: {
              employeeId: emp.id,
              date: { gte: start, lte: end },
              status: { in: ['PRESENT', 'HALF_DAY'] },
            },
          });

          const presentDays = attendance.reduce(
            (acc, a) => acc + (a.status === 'HALF_DAY' ? 0.5 : 1), 0
          );
          const totalOvertimeHours = attendance.reduce((acc, a) => acc + (a.overtimeHours || 0), 0);

          // Approved leaves
          const approvedLeaves = await prisma.leaveRequest.findMany({
            where: {
              employeeId: emp.id,
              status: 'APPROVED',
              leaveType: { isPaid: true },
              startDate: { lte: end },
              endDate: { gte: start },
            },
          });

          const paidLeaveDays = approvedLeaves.reduce((acc, l) => acc + l.days, 0);
          const lopDays = calcLOP(workingDaysInMonth, presentDays, paidLeaveDays);

          // Use saved salary structure; fall back to ₹30,000 net (no PF) if none set
          const salStruct = (emp as any).salaryStructure;
          const sal = salStruct ?? calcSalaryFromNet(30000, false);
          const hasPf: boolean = salStruct?.hasPf ?? false;

          const basic            = sal.basic;
          const hra              = sal.hra;
          const conveyance       = sal.conveyance;
          const medicalAllowance = sal.medicalAllowance;
          const specialAllowance = sal.specialAllowance;
          const bonus            = 0;
          const incentives       = Math.round(totalOvertimeHours * 100);
          const grossSalary      = sal.grossSalary + incentives;

          const lopDeduction    = Math.round((grossSalary / workingDaysInMonth) * lopDays);
          // PF only deducted if employee is enrolled
          const pf              = hasPf ? sal.pf : 0;
          const esi             = sal.esi;
          const professionalTax = sal.professionalTax;
          const tds             = sal.tds;
          const loanRecovery    = 0;

          const totalDeductions = pf + esi + professionalTax + tds + loanRecovery + lopDeduction;
          const netSalary       = grossSalary - totalDeductions;

          return prisma.payslip.upsert({
            where: { payrollId_employeeId: { payrollId: payroll!.id, employeeId: emp.id } },
            create: {
              payrollId: payroll!.id,
              employeeId: emp.id,
              month,
              year,
              basic, hra, conveyance, medicalAllowance, specialAllowance, bonus, incentives,
              grossSalary, pf, esi, professionalTax, tds, loanRecovery,
              lopDeduction, totalDeductions, netSalary,
              lopDays, workingDays: workingDaysInMonth,
              presentDays, overtimeHours: totalOvertimeHours,
            },
            update: {
              basic, hra, conveyance, medicalAllowance, specialAllowance, bonus, incentives,
              grossSalary, pf, esi, professionalTax, tds, loanRecovery,
              lopDeduction, totalDeductions, netSalary,
              lopDays, workingDays: workingDaysInMonth,
              presentDays, overtimeHours: totalOvertimeHours,
            },
          });
        })
      );

      await prisma.payroll.update({
        where: { id: payroll.id },
        data: { status: 'PENDING_REVIEW', processedBy: req.user!.userId },
      });

      res.json({ success: true, data: { payroll, payslipsCount: payslips.length } });
    } catch (err) { next(err); }
  },

  async approve(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const payroll = await prisma.payroll.findUnique({
        where: { id: req.params.id },
        include: {
          payslips: {
            include: { employee: { include: { user: true } } },
          },
        },
      });
      if (!payroll) throw new AppError('Payroll not found', 404);
      if (payroll.status !== 'PENDING_REVIEW') throw new AppError('Payroll not in review state', 400);

      await prisma.payroll.update({
        where: { id: payroll.id },
        data: { status: 'APPROVED', approvedBy: req.user!.userId },
      });

      // Notify employees
      await Promise.all(
        payroll.payslips.map((slip) =>
          notificationService.create({
            userId: slip.employee.userId,
            type: 'PAYROLL_GENERATED',
            title: 'Payslip Ready',
            message: `Your payslip for ${MONTH_NAMES[payroll.month - 1]} ${payroll.year} is ready`,
          }).catch(console.error)
        )
      );

      res.json({ success: true, message: 'Payroll approved' });
    } catch (err) { next(err); }
  },

  async myPayslips(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!employee) return res.json({ success: true, data: [] });

      const payslips = await prisma.payslip.findMany({
        where: { employeeId: employee.id },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        take: 24,
      });

      res.json({ success: true, data: payslips });
    } catch (err) { next(err); }
  },

  async getPayslip(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const payslip = await prisma.payslip.findUnique({
        where: { id: req.params.id },
        include: {
          employee: {
            include: {
              department: true,
              designation: true,
              bankDetails: { where: { isPrimary: true }, take: 1 },
            },
          },
        },
      });
      if (!payslip) throw new AppError('Payslip not found', 404);

      // Access check
      if (
        req.user!.role === 'EMPLOYEE' &&
        payslip.employee.userId !== req.user!.userId
      ) {
        throw new AppError('Access denied', 403);
      }

      res.json({ success: true, data: payslip });
    } catch (err) { next(err); }
  },

  async batchPayslips(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { id } = req.params;
      const slips = await prisma.payslip.findMany({
        where: { payrollId: id },
        include: {
          employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
        },
        orderBy: { employee: { employeeCode: 'asc' } },
      });
      res.json({ success: true, data: slips });
    } catch (err) { next(err); }
  },

  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { companyId } = req.query;
      const cId = String(companyId || req.user!.companyId);

      const payrolls = await prisma.payroll.findMany({
        where: { companyId: cId },
        orderBy: [{ year: 'desc' }, { month: 'desc' }],
        include: { _count: { select: { payslips: true } } },
      });

      res.json({ success: true, data: payrolls });
    } catch (err) { next(err); }
  },
};
