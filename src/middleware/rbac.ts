import { Response, NextFunction } from 'express';
import { Role, ModuleName, AccessLevel } from '@prisma/client';
import { AuthRequest } from '../types';
import { getEffectiveAccess } from '../utils/moduleAccess';

const ROLE_HIERARCHY: Record<Role, number> = {
  SUPER_ADMIN: 5,
  ADMIN: 4,
  HR: 3,
  MANAGER: 2,
  EMPLOYEE: 1,
};

export const requireRole = (...roles: Role[]) =>
  (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }
    if (!roles.includes(req.user.role)) {
      res.status(403).json({ success: false, message: 'Insufficient permissions' });
      return;
    }
    next();
  };

export const requireMinRole = (minRole: Role) =>
  (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }
    if (ROLE_HIERARCHY[req.user.role] < ROLE_HIERARCHY[minRole]) {
      res.status(403).json({ success: false, message: 'Insufficient permissions' });
      return;
    }
    next();
  };

/**
 * Master Control gate — grants access regardless of the caller's own
 * department/designation. SUPER_ADMIN always passes; everyone else must
 * have User.canManageAccess = true (set via Master Control itself).
 */
export const requireMasterControl = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  if (req.user.role === 'SUPER_ADMIN' || req.user.canManageAccess) {
    next();
    return;
  }
  res.status(403).json({ success: false, message: 'Master Control access required' });
};

/**
 * Student-portal gate — STUDENT role sits outside the employee role
 * hierarchy / module-access system entirely, so it gets its own simple check.
 */
export const requireStudent = (req: AuthRequest, res: Response, next: NextFunction): void => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  if (req.user.role !== 'STUDENT' || !req.user.studentId) {
    res.status(403).json({ success: false, message: 'Student access only' });
    return;
  }
  next();
};

const LEVEL_RANK: Record<AccessLevel, number> = { NONE: 0, VIEW: 1, EDIT: 2, ADMIN: 3 };

/**
 * Business-module gate — checks the caller's effective module access
 * (department default + per-user override) computed via getEffectiveAccess.
 * SUPER_ADMIN always passes. Use minLevel 'EDIT' for write endpoints.
 */
export const requireModule = (module: ModuleName, minLevel: AccessLevel = 'VIEW') =>
  async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
    if (!req.user) {
      res.status(401).json({ success: false, message: 'Unauthorized' });
      return;
    }
    if (req.user.role === 'SUPER_ADMIN') {
      next();
      return;
    }
    try {
      const access = await getEffectiveAccess(req.user.userId);
      const level = access[module];
      if (!level || LEVEL_RANK[level] < LEVEL_RANK[minLevel]) {
        res.status(403).json({ success: false, message: 'You do not have access to this module' });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
