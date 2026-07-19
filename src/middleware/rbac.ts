import { Response, NextFunction } from 'express';
import { Role, ModuleName, AccessLevel } from '@prisma/client';
import { AuthRequest } from '../types';
import { getEffectiveAccess } from '../utils/moduleAccess';
import prisma from '../config/database';

const ROLE_HIERARCHY: Record<Role, number> = {
  SUPER_ADMIN: 5,
  ADMIN: 4,
  HR: 3,
  MANAGER: 2,
  EMPLOYEE: 1,
  STUDENT: 0,
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
 *
 * Falls back to a DB lookup when studentId is missing from the JWT (this
 * happens when the JWT was issued before the student profile was linked to the
 * user account — e.g. an existing session before admin created the student
 * record). The looked-up studentId is attached to req.user so downstream
 * handlers (getStudentId) don't need to change.
 */
export const requireStudent = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  if (!req.user) {
    res.status(401).json({ success: false, message: 'Unauthorized' });
    return;
  }
  if (req.user.role !== 'STUDENT') {
    res.status(403).json({ success: false, message: 'Student access only' });
    return;
  }
  // Happy path: studentId already in JWT
  if (req.user.studentId) {
    next();
    return;
  }
  // Stale token: look up the student record by userId and patch it in
  try {
    let student = await prisma.student.findUnique({
      where: { userId: req.user.userId },
      select: { id: true },
    });

    // If userId lookup failed (Student.userId is null — broken link), fall back
    // to matching by the user's email and auto-repair the link so future
    // requests don't need this expensive path.
    if (!student) {
      const userRecord = await prisma.user.findUnique({
        where: { id: req.user.userId },
        select: { email: true },
      });
      if (userRecord?.email) {
        student = await prisma.student.findFirst({
          where: { email: userRecord.email },
          select: { id: true },
        });
        if (student) {
          // Auto-repair: link the student record to this user account
          await prisma.student.update({
            where: { id: student.id },
            data: { userId: req.user.userId },
          });
        }
      }
    }

    if (!student) {
      res.status(403).json({ success: false, message: 'Student access only' });
      return;
    }
    req.user.studentId = student.id;
    next();
  } catch (err) {
    next(err);
  }
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
