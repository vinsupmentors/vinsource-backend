import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

export const dashboardController = {
  async stats(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId;
      const role = req.user!.role;
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const thisMonth = { gte: new Date(today.getFullYear(), today.getMonth(), 1) };

      if (role === 'SUPER_ADMIN') {
        const [companies, employees, users] = await Promise.all([
          prisma.company.count(),
          prisma.employee.count(),
          prisma.user.count(),
        ]);
        return res.json({ success: true, data: { companies, totalEmployees: employees, users } });
      }

      // Only plain MANAGER is scoped to their team; HR and above see company-wide
      const isManagerRole = role === 'MANAGER';
      let teamEmpIds: string[] | null = null;

      if (isManagerRole) {
        const self = await prisma.employee.findUnique({ where: { userId: req.user!.userId }, select: { id: true } });
        if (self) {
          const reports = await prisma.employee.findMany({ where: { managerId: self.id }, select: { id: true } });
          teamEmpIds = reports.map(r => r.id);
        }
      }

      // Build where filters — managers see only their team
      const empWhere = isManagerRole && teamEmpIds !== null
        ? { id: { in: teamEmpIds } }
        : { companyId };
      const activeEmpWhere = isManagerRole && teamEmpIds !== null
        ? { id: { in: teamEmpIds }, status: 'ACTIVE' as const }
        : { companyId, status: 'ACTIVE' as const };

      const [
        totalEmployees,
        activeEmployees,
        presentToday,
        onLeaveToday,
        pendingLeaves,
        newJoineeThisMonth,
      ] = await Promise.all([
        prisma.employee.count({ where: empWhere }),
        prisma.employee.count({ where: activeEmpWhere }),
        prisma.attendance.count({
          where: {
            ...(isManagerRole && teamEmpIds ? { employeeId: { in: teamEmpIds } } : { employee: { companyId } }),
            date: today,
            status: 'PRESENT',
          },
        }),
        prisma.leaveRequest.count({
          where: {
            ...(isManagerRole && teamEmpIds ? { employeeId: { in: teamEmpIds } } : { employee: { companyId } }),
            status: 'APPROVED',
            startDate: { lte: today },
            endDate: { gte: today },
          },
        }),
        prisma.leaveRequest.count({
          where: {
            ...(isManagerRole && teamEmpIds ? { employeeId: { in: teamEmpIds } } : { employee: { companyId } }),
            status: 'PENDING',
          },
        }),
        prisma.employee.count({
          where: { ...empWhere, joiningDate: thisMonth },
        }),
      ]);

      // Upcoming birthdays (next 7 days)
      const employees = await prisma.employee.findMany({
        where: { ...activeEmpWhere },
        select: { firstName: true, lastName: true, dateOfBirth: true },
      });

      const upcomingBirthdays = employees
        .filter((e) => {
          if (!e.dateOfBirth) return false;
          const bday = new Date(e.dateOfBirth);
          const thisYear = new Date(today.getFullYear(), bday.getMonth(), bday.getDate());
          const diff = (thisYear.getTime() - today.getTime()) / (1000 * 60 * 60 * 24);
          return diff >= 0 && diff <= 7;
        })
        .map((e) => ({
          name: `${e.firstName} ${e.lastName}`,
          date: e.dateOfBirth!.toISOString(),
        }));

      // Attendance trend (last 7 days)
      const last7 = Array.from({ length: 7 }, (_, i) => {
        const d = new Date(today);
        d.setDate(d.getDate() - i);
        return d;
      }).reverse();

      const attendanceTrend = await Promise.all(
        last7.map(async (d) => {
          const count = await prisma.attendance.count({
            where: {
              ...(isManagerRole && teamEmpIds ? { employeeId: { in: teamEmpIds } } : { employee: { companyId } }),
              date: d,
              status: 'PRESENT',
            },
          });
          return { date: d.toISOString().slice(0, 10), count };
        })
      );

      res.json({
        success: true,
        data: {
          totalEmployees,
          activeEmployees,
          presentToday,
          onLeaveToday,
          pendingLeaves,
          newJoineeThisMonth,
          upcomingBirthdays,
          attendanceTrend,
          absentToday: activeEmployees - presentToday - onLeaveToday,
        },
      });
    } catch (err) { next(err); }
  },

  async myStats(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      // No Employee record linked to this login (e.g. a pure admin/system account) —
      // return a fully-shaped, zeroed-out object rather than `{}` so the frontend
      // never has to guess which fields are missing.
      if (!employee) {
        return res.json({
          success: true,
          data: {
            presentDays: 0,
            halfDays: 0,
            totalWorkHours: 0,
            pendingLeaves: 0,
            approvedThisMonth: [],
            balances: [],
            isProbation: false,
            probationEnds: null,
            monthName: new Date().toLocaleString('en-IN', { month: 'long' }),
          },
        });
      }

      const today = new Date();
      const monthStart = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1));
      const monthEnd = new Date(Date.UTC(today.getFullYear(), today.getMonth() + 1, 0, 23, 59, 59, 999));

      const [
        presentDays,
        halfDays,
        pendingLeaves,
        approvedThisMonth,
        balances,
        workHoursRecords,
      ] = await Promise.all([
        prisma.attendance.count({
          where: { employeeId: employee.id, date: { gte: monthStart, lte: monthEnd }, status: 'PRESENT' },
        }),
        prisma.attendance.count({
          where: { employeeId: employee.id, date: { gte: monthStart, lte: monthEnd }, status: 'HALF_DAY' },
        }),
        prisma.leaveRequest.count({
          where: { employeeId: employee.id, status: 'PENDING' },
        }),
        prisma.leaveRequest.findMany({
          where: {
            employeeId: employee.id,
            status: 'APPROVED',
            startDate: { gte: monthStart, lte: monthEnd },
          },
          include: { leaveType: true },
          orderBy: { startDate: 'asc' },
        }),
        prisma.leaveBalance.findMany({
          where: { employeeId: employee.id, year: today.getFullYear() },
          include: { leaveType: true },
        }),
        prisma.attendance.findMany({
          where: { employeeId: employee.id, date: { gte: monthStart, lte: monthEnd } },
          select: { workHours: true },
        }),
      ]);

      const totalWorkHours = Math.round(
        workHoursRecords.reduce((s, r) => s + (r.workHours || 0), 0) * 10
      ) / 10;

      // Probation check: ON_PROBATION or joining date < 90 days ago
      const isProbation = employee.status === 'ON_PROBATION';
      const probationEnds = new Date(employee.joiningDate);
      probationEnds.setMonth(probationEnds.getMonth() + 3);

      return res.json({
        success: true,
        data: {
          presentDays,
          halfDays,
          totalWorkHours,
          pendingLeaves,
          approvedThisMonth,
          balances,
          isProbation,
          probationEnds: isProbation ? probationEnds.toISOString() : null,
          monthName: today.toLocaleString('en-IN', { month: 'long' }),
        },
      });
    } catch (err) { next(err); }
  },

  async managerStats(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const manager = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!manager) throw new AppError('Employee not found', 404);

      const today = new Date();
      today.setHours(0, 0, 0, 0);

      const teamIds = await prisma.employee.findMany({
        where: { managerId: manager.id },
        select: { id: true },
      });

      const empIds = teamIds.map((e) => e.id);

      const [teamSize, presentToday, pendingLeaves] = await Promise.all([
        prisma.employee.count({ where: { managerId: manager.id } }),
        prisma.attendance.count({ where: { employeeId: { in: empIds }, date: today, status: 'PRESENT' } }),
        prisma.leaveRequest.count({ where: { employeeId: { in: empIds }, status: 'PENDING', managerId: manager.id } }),
      ]);

      res.json({
        success: true,
        data: { teamSize, presentToday, pendingLeaves, absentToday: teamSize - presentToday },
      });
    } catch (err) { next(err); }
  },
};
