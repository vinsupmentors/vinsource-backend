import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

export const orgController = {
  // ─── DEPARTMENTS ─────────────────────────────────────────────────────────────

  async departments(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId;
      const where = companyId ? { companyId, isActive: true } : { isActive: true };
      const depts = await prisma.department.findMany({
        where,
        orderBy: { name: 'asc' },
        include: { _count: { select: { employees: true } } },
      });
      res.json({ success: true, data: depts });
    } catch (err) { next(err); }
  },

  async createDepartment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId!;
      const { name, code, description } = req.body;
      if (!name || !code) throw new AppError('Name and code are required', 400);

      const dept = await prisma.department.create({
        data: { companyId, name, code: code.toUpperCase(), description },
      });
      res.status(201).json({ success: true, data: dept });
    } catch (err) { next(err); }
  },

  async updateDepartment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, code, description, headId } = req.body;
      const dept = await prisma.department.update({
        where: { id: req.params.id },
        data: {
          ...(name && { name }),
          ...(code && { code: code.toUpperCase() }),
          ...(description !== undefined && { description }),
          ...(headId !== undefined && { headId }),
        },
      });
      res.json({ success: true, data: dept });
    } catch (err) { next(err); }
  },

  async deleteDepartment(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const empCount = await prisma.employee.count({ where: { departmentId: req.params.id } });
      if (empCount > 0) throw new AppError(`Cannot delete — ${empCount} employee(s) are in this department`, 400);

      await prisma.department.update({ where: { id: req.params.id }, data: { isActive: false } });
      res.json({ success: true, message: 'Department deactivated' });
    } catch (err) { next(err); }
  },

  // ─── DESIGNATIONS ─────────────────────────────────────────────────────────────

  async designations(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const desigs = await prisma.designation.findMany({
        where: { isActive: true },
        orderBy: [{ level: 'desc' }, { name: 'asc' }],
        include: { _count: { select: { employees: true } } },
      });
      res.json({ success: true, data: desigs });
    } catch (err) { next(err); }
  },

  async createDesignation(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, code, level, description } = req.body;
      if (!name || !code) throw new AppError('Name and code are required', 400);

      const desig = await prisma.designation.create({
        data: { name, code: code.toUpperCase(), level: Number(level) || 1, description },
      });
      res.status(201).json({ success: true, data: desig });
    } catch (err) { next(err); }
  },

  async updateDesignation(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, code, level, description } = req.body;
      const desig = await prisma.designation.update({
        where: { id: req.params.id },
        data: {
          ...(name && { name }),
          ...(code && { code: code.toUpperCase() }),
          ...(level !== undefined && { level: Number(level) }),
          ...(description !== undefined && { description }),
        },
      });
      res.json({ success: true, data: desig });
    } catch (err) { next(err); }
  },

  async deleteDesignation(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const empCount = await prisma.employee.count({ where: { designationId: req.params.id } });
      if (empCount > 0) throw new AppError(`Cannot delete — ${empCount} employee(s) hold this designation`, 400);

      await prisma.designation.update({ where: { id: req.params.id }, data: { isActive: false } });
      res.json({ success: true, message: 'Designation deactivated' });
    } catch (err) { next(err); }
  },

  // ─── BRANCHES ─────────────────────────────────────────────────────────────────

  async branches(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId;
      const where = companyId ? { companyId, isActive: true } : { isActive: true };
      const branches = await prisma.branch.findMany({ where, orderBy: { name: 'asc' } });
      res.json({ success: true, data: branches });
    } catch (err) { next(err); }
  },

  // ─── ORG CHART ────────────────────────────────────────────────────────────────
  // Returns all active employees with dept + designation so the frontend
  // can populate the named leadership tree automatically.

  async chart(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId;
      const employees = await prisma.employee.findMany({
        where: {
          ...(companyId ? { companyId } : {}),
          status: 'ACTIVE',
        },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          employeeCode: true,
          profilePhoto: true,
          joiningDate: true,
          department: { select: { id: true, name: true, code: true } },
          designation: { select: { id: true, name: true } },
          managerId: true,
        },
        orderBy: { firstName: 'asc' },
      });
      res.json({ success: true, data: employees });
    } catch (err) { next(err); }
  },

  // ─── MANAGERS LIST (for dropdowns) ────────────────────────────────────────────

  async managers(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const companyId = req.user!.companyId;
      const managers = await prisma.employee.findMany({
        where: {
          ...(companyId ? { companyId } : {}),
          user: { role: { in: ['MANAGER', 'HR', 'ADMIN', 'SUPER_ADMIN'] } },
        },
        select: {
          id: true, firstName: true, lastName: true, employeeCode: true,
          designation: { select: { name: true } },
          department: { select: { name: true } },
        },
        orderBy: { firstName: 'asc' },
      });
      res.json({ success: true, data: managers });
    } catch (err) { next(err); }
  },
};
