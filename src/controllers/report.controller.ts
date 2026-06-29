import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AuthRequest } from '../types';

// ── helpers ──────────────────────────────────────────────────────────────────

function dateRange(from?: string, to?: string, month?: string, year?: string) {
  if (from && to) {
    return { gte: new Date(from), lte: new Date(to + 'T23:59:59.999Z') };
  }
  const y = Number(year) || new Date().getFullYear();
  const m = month !== undefined ? Number(month) : new Date().getMonth(); // 0-based
  const start = new Date(Date.UTC(y, m, 1));
  const end   = new Date(Date.UTC(y, m + 1, 0, 23, 59, 59, 999));
  return { gte: start, lte: end };
}

// ── controllers ───────────────────────────────────────────────────────────────

export const reportController = {

  // ── 1. Attendance Report ─────────────────────────────────────────────────
  async attendance(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId!;
      const { from, to, month, year, employeeId, departmentId, teamManagerId } = req.query as Record<string, string>;

      const range = dateRange(from, to, month, year);

      // Build employee filter
      const empWhere: any = { companyId };
      if (employeeId) empWhere.id = employeeId;
      if (departmentId) empWhere.departmentId = departmentId;
      if (teamManagerId) empWhere.managerId = teamManagerId;

      const employees = await prisma.employee.findMany({
        where: empWhere,
        select: {
          id: true, firstName: true, lastName: true, employeeCode: true,
          department: { select: { name: true } },
          designation: { select: { name: true } },
          manager: { select: { firstName: true, lastName: true } },
          attendances: {
            where: { date: range },
            select: {
              date: true, status: true, checkIn: true, checkOut: true,
              workHours: true, overtimeHours: true, locationType: true, isRegularized: true,
            },
            orderBy: { date: 'asc' },
          },
        },
        orderBy: [{ department: { name: 'asc' } }, { firstName: 'asc' }],
      });

      // Compute summary per employee
      const rows = employees.map(e => {
        const att = e.attendances;
        const present   = att.filter(a => a.status === 'PRESENT').length;
        const halfDay   = att.filter(a => a.status === 'HALF_DAY').length;
        const absent    = att.filter(a => a.status === 'ABSENT').length;
        const late      = 0; // LATE is not a valid AttendanceStatus
        const wfh       = att.filter(a => a.locationType === 'WFH').length;
        const totalHours = att.reduce((s, a) => s + (a.workHours || 0), 0);
        const otHours   = att.reduce((s, a) => s + (a.overtimeHours || 0), 0);

        return {
          employeeCode: e.employeeCode,
          name: `${e.firstName} ${e.lastName}`,
          department: e.department?.name ?? '',
          designation: e.designation?.name ?? '',
          manager: e.manager ? `${e.manager.firstName} ${e.manager.lastName}` : '',
          present,
          halfDay,
          absent,
          late,
          wfh,
          totalWorkingDays: present + halfDay * 0.5 + late,
          totalHours: Math.round(totalHours * 100) / 100,
          otHours: Math.round(otHours * 100) / 100,
          dailyRecords: att.map(a => ({
            date: a.date,
            status: a.status,
            checkIn: a.checkIn,
            checkOut: a.checkOut,
            workHours: a.workHours,
            locationType: a.locationType,
          })),
        };
      });

      res.json({ success: true, data: rows });
    } catch (err) { next(err); }
  },

  // ── 2. Pay Scale / Salary Report ─────────────────────────────────────────
  async payScale(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId!;
      const { month, year, employeeId, departmentId, teamManagerId } = req.query as Record<string, string>;

      const y = Number(year) || new Date().getFullYear();
      const m = month !== undefined ? Number(month) : new Date().getMonth() + 1; // 1-based for Payslip

      const empWhere: any = { companyId };
      if (employeeId) empWhere.id = employeeId;
      if (departmentId) empWhere.departmentId = departmentId;
      if (teamManagerId) empWhere.managerId = teamManagerId;

      const employees = await prisma.employee.findMany({
        where: empWhere,
        select: {
          id: true, firstName: true, lastName: true, employeeCode: true,
          department: { select: { name: true } },
          designation: { select: { name: true } },
          manager: { select: { firstName: true, lastName: true } },
          salaryStructure: true,
          payslips: {
            where: { month: m, year: y },
            select: {
              basic: true, hra: true, conveyance: true, medicalAllowance: true,
              specialAllowance: true, bonus: true, incentives: true, grossSalary: true,
              pf: true, esi: true, professionalTax: true, tds: true, loanRecovery: true,
              lopDeduction: true, totalDeductions: true, netSalary: true,
              lopDays: true, workingDays: true, presentDays: true,
            },
          },
        },
        orderBy: [{ department: { name: 'asc' } }, { firstName: 'asc' }],
      });

      const rows = employees.map(e => {
        const ps = e.payslips[0];
        const ss = e.salaryStructure;

        return {
          employeeCode: e.employeeCode,
          name: `${e.firstName} ${e.lastName}`,
          department: e.department?.name ?? '',
          designation: e.designation?.name ?? '',
          manager: e.manager ? `${e.manager.firstName} ${e.manager.lastName}` : '',
          // Salary structure (agreed)
          structureGross: ss?.grossSalary ?? 0,
          structureNet:   ss?.netSalary ?? 0,
          structureBasic: ss?.basic ?? 0,
          structureHRA:   ss?.hra ?? 0,
          structurePF:    ss?.pf ?? 0,
          // Actual payslip for selected month
          payslipFound: !!ps,
          workingDays:    ps?.workingDays ?? 0,
          presentDays:    ps?.presentDays ?? 0,
          lopDays:        ps?.lopDays ?? 0,
          basic:          ps?.basic ?? 0,
          hra:            ps?.hra ?? 0,
          conveyance:     ps?.conveyance ?? 0,
          medicalAllowance: ps?.medicalAllowance ?? 0,
          specialAllowance: ps?.specialAllowance ?? 0,
          bonus:          ps?.bonus ?? 0,
          incentives:     ps?.incentives ?? 0,
          grossSalary:    ps?.grossSalary ?? 0,
          pf:             ps?.pf ?? 0,
          esi:            ps?.esi ?? 0,
          professionalTax: ps?.professionalTax ?? 0,
          tds:            ps?.tds ?? 0,
          loanRecovery:   ps?.loanRecovery ?? 0,
          lopDeduction:   ps?.lopDeduction ?? 0,
          totalDeductions: ps?.totalDeductions ?? 0,
          netSalary:      ps?.netSalary ?? 0,
        };
      });

      res.json({ success: true, data: rows });
    } catch (err) { next(err); }
  },

  // ── 3. Leave Report ────────────────────────────────────────────────────────
  async leave(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId!;
      const { from, to, month, year, employeeId, departmentId, teamManagerId, status } = req.query as Record<string, string>;

      const range = dateRange(from, to, month, year);

      const empWhere: any = { companyId };
      if (employeeId) empWhere.id = employeeId;
      if (departmentId) empWhere.departmentId = departmentId;
      if (teamManagerId) empWhere.managerId = teamManagerId;

      const employees = await prisma.employee.findMany({
        where: empWhere,
        select: {
          id: true, firstName: true, lastName: true, employeeCode: true,
          department: { select: { name: true } },
          designation: { select: { name: true } },
          manager: { select: { firstName: true, lastName: true } },
          leaveRequests: {
            where: {
              startDate: range,
              ...(status ? { status: status as any } : {}),
            },
            select: {
              id: true, startDate: true, endDate: true, days: true,
              status: true, reason: true, isHalfDay: true,
              leaveType: { select: { name: true, type: true } },
              createdAt: true,
            },
            orderBy: { startDate: 'asc' },
          },
          leaveBalances: {
            where: { year: Number(year) || new Date().getFullYear() },
            select: {
              totalDays: true, usedDays: true, pendingDays: true,
              leaveType: { select: { name: true } },
            },
          },
        },
        orderBy: [{ department: { name: 'asc' } }, { firstName: 'asc' }],
      });

      const rows = employees.map(e => ({
        employeeCode: e.employeeCode,
        name: `${e.firstName} ${e.lastName}`,
        department: e.department?.name ?? '',
        designation: e.designation?.name ?? '',
        manager: e.manager ? `${e.manager.firstName} ${e.manager.lastName}` : '',
        leaveRequests: e.leaveRequests,
        totalLeavesTaken: e.leaveRequests.filter(l => l.status === 'APPROVED').reduce((s, l) => s + l.days, 0),
        balances: e.leaveBalances,
      }));

      res.json({ success: true, data: rows });
    } catch (err) { next(err); }
  },

  // ── 4. Employee Directory Report ──────────────────────────────────────────
  async employees(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId!;
      const { departmentId, teamManagerId, status } = req.query as Record<string, string>;

      const where: any = { companyId };
      if (departmentId) where.departmentId = departmentId;
      if (teamManagerId) where.managerId = teamManagerId;
      if (status) where.status = status;

      const employees = await prisma.employee.findMany({
        where,
        select: {
          employeeCode: true, firstName: true, lastName: true, email: true, phone: true,
          gender: true, dateOfBirth: true, joiningDate: true, confirmationDate: true, status: true,
          department: { select: { name: true } },
          designation: { select: { name: true } },
          manager: { select: { firstName: true, lastName: true } },
          salaryStructure: { select: { netSalary: true, grossSalary: true } },
          user: { select: { role: true } },
        },
        orderBy: [{ department: { name: 'asc' } }, { firstName: 'asc' }],
      });

      const rows = employees.map(e => ({
        employeeCode: e.employeeCode,
        name: `${e.firstName} ${e.lastName}`,
        email: e.email,
        phone: e.phone ?? '',
        gender: e.gender ?? '',
        dateOfBirth: e.dateOfBirth,
        joiningDate: e.joiningDate,
        confirmationDate: e.confirmationDate,
        status: e.status,
        department: e.department?.name ?? '',
        designation: e.designation?.name ?? '',
        manager: e.manager ? `${e.manager.firstName} ${e.manager.lastName}` : '',
        role: e.user?.role ?? '',
        netSalary: e.salaryStructure?.netSalary ?? 0,
        grossSalary: e.salaryStructure?.grossSalary ?? 0,
      }));

      res.json({ success: true, data: rows });
    } catch (err) { next(err); }
  },

  // ── 5. Filters meta (departments + managers for dropdowns) ───────────────
  async filters(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId!;

      const [departments, managers] = await Promise.all([
        prisma.department.findMany({ where: { companyId, isActive: true }, select: { id: true, name: true }, orderBy: { name: 'asc' } }),
        prisma.employee.findMany({
          where: { companyId, subordinates: { some: {} } },
          select: { id: true, firstName: true, lastName: true, designation: { select: { name: true } } },
          orderBy: { firstName: 'asc' },
        }),
      ]);

      res.json({ success: true, data: { departments, managers } });
    } catch (err) { next(err); }
  },
};
