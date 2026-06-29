import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { getEffectiveAccess } from '../utils/moduleAccess';
import { ModuleName, AccessLevel } from '@prisma/client';

export const accessController = {
  /** Effective module access for the current user — drives the sidebar. */
  async myAccess(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const access = await getEffectiveAccess(req.user!.userId);
      res.json({
        success: true,
        data: {
          modules: access,
          canManageAccess: req.user!.role === 'SUPER_ADMIN' || !!req.user!.canManageAccess,
        },
      });
    } catch (err) { next(err); }
  },

  /** Effective access for any employee — Master Control only. */
  async employeeAccess(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employee = await prisma.employee.findUnique({
        where: { id: req.params.employeeId },
        select: { userId: true },
      });
      if (!employee) throw new AppError('Employee not found', 404);
      const access = await getEffectiveAccess(employee.userId);
      res.json({ success: true, data: access });
    } catch (err) { next(err); }
  },

  /** Directory of all employees with department, designation, and current access — Master Control only. */
  async directory(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employees = await prisma.employee.findMany({
        where: { status: { not: 'TERMINATED' } },
        select: {
          id: true,
          userId: true,
          employeeCode: true,
          firstName: true,
          lastName: true,
          status: true,
          department: { select: { id: true, name: true, code: true } },
          designation: { select: { id: true, name: true } },
          user: { select: { id: true, email: true, role: true, canManageAccess: true } },
        },
        orderBy: [{ department: { name: 'asc' } }, { firstName: 'asc' }],
      });

      const withAccess = await Promise.all(
        employees.map(async (e) => ({
          ...e,
          effectiveAccess: await getEffectiveAccess(e.userId),
        }))
      );

      res.json({ success: true, data: withAccess });
    } catch (err) { next(err); }
  },

  /** All department default module mappings — Master Control only. */
  async departmentDefaults(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const departments = await prisma.department.findMany({
        where: { isActive: true },
        select: {
          id: true,
          name: true,
          code: true,
          moduleAccessDefaults: { select: { id: true, module: true, accessLevel: true } },
        },
        orderBy: { name: 'asc' },
      });
      res.json({ success: true, data: departments });
    } catch (err) { next(err); }
  },

  /** Set/replace a department's default access for one module — Master Control only. */
  async setDepartmentDefault(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { departmentId } = req.params;
      const { module, accessLevel } = req.body as { module: ModuleName; accessLevel: AccessLevel };

      if (!Object.values(ModuleName).includes(module)) throw new AppError('Invalid module', 400);
      if (!Object.values(AccessLevel).includes(accessLevel)) throw new AppError('Invalid access level', 400);

      const department = await prisma.department.findUnique({ where: { id: departmentId } });
      if (!department) throw new AppError('Department not found', 404);

      if (accessLevel === 'NONE') {
        await prisma.departmentModuleAccess.deleteMany({ where: { departmentId, module } });
        res.json({ success: true, message: 'Default access removed' });
        return;
      }

      const row = await prisma.departmentModuleAccess.upsert({
        where: { departmentId_module: { departmentId, module } },
        update: { accessLevel },
        create: { departmentId, module, accessLevel },
      });

      res.json({ success: true, data: row });
    } catch (err) { next(err); }
  },

  /** Grant/override a specific module's access for one user — Master Control only. */
  async setUserOverride(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { userId } = req.params;
      const { module, accessLevel, note } = req.body as { module: ModuleName; accessLevel: AccessLevel; note?: string };

      if (!Object.values(ModuleName).includes(module)) throw new AppError('Invalid module', 400);
      if (!Object.values(AccessLevel).includes(accessLevel)) throw new AppError('Invalid access level', 400);

      const targetUser = await prisma.user.findUnique({ where: { id: userId } });
      if (!targetUser) throw new AppError('User not found', 404);

      const row = await prisma.userModuleAccess.upsert({
        where: { userId_module: { userId, module } },
        update: { accessLevel, note, grantedById: req.user!.userId },
        create: { userId, module, accessLevel, note, grantedById: req.user!.userId },
      });

      res.json({ success: true, data: row });
    } catch (err) { next(err); }
  },

  /** Remove a per-user override for one module (reverts to department default) — Master Control only. */
  async removeUserOverride(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { userId, module } = req.params;
      await prisma.userModuleAccess.deleteMany({ where: { userId, module: module as ModuleName } });
      res.json({ success: true, message: 'Override removed' });
    } catch (err) { next(err); }
  },

  /** Grant or revoke Master Control itself for a user — SUPER_ADMIN/current Master Control only. */
  async setMasterControl(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { userId } = req.params;
      const { canManageAccess } = req.body as { canManageAccess: boolean };
      if (typeof canManageAccess !== 'boolean') throw new AppError('canManageAccess (boolean) is required', 400);

      const targetUser = await prisma.user.findUnique({ where: { id: userId } });
      if (!targetUser) throw new AppError('User not found', 404);

      const updated = await prisma.user.update({
        where: { id: userId },
        data: { canManageAccess },
        select: { id: true, email: true, canManageAccess: true },
      });

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },
};
