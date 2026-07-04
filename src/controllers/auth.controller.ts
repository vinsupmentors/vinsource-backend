import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import prisma from '../config/database';
import { hashPassword, comparePassword } from '../utils/helpers';
import { generateToken, generateRefreshToken, verifyRefreshToken } from '../utils/jwt';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest, AuthPayload } from '../types';
import { emailService } from '../services/email.service';
import { config } from '../config/env';

export const authController = {
  async login(req: Request, res: Response, next: NextFunction) {
    try {
      const { email, password } = req.body;

      const user = await prisma.user.findUnique({
        where: { email: email.toLowerCase() },
        include: {
          employee: { select: { id: true, companyId: true, firstName: true, lastName: true, profilePhoto: true } },
          student: { select: { id: true, studentCode: true, firstName: true, lastName: true, status: true, track: true, profileCompletedAt: true } },
        },
      });

      if (!user || !(await comparePassword(password, user.password))) {
        throw new AppError('Invalid email or password', 401);
      }
      if (!user.isActive) {
        throw new AppError('Account is deactivated', 403);
      }

      const payload = {
        userId: user.id,
        employeeId: user.employee?.id,
        studentId: user.student?.id,
        role: user.role,
        companyId: user.employee?.companyId,
        email: user.email,
        canManageAccess: user.canManageAccess,
      };

      const token = generateToken(payload);
      const refreshToken = generateRefreshToken(payload);

      await prisma.userSession.create({
        data: {
          userId: user.id,
          token,
          refreshToken,
          ipAddress: req.ip,
          device: req.headers['user-agent'],
          expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        },
      });

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date(), lastLoginIp: req.ip },
      });

      // Student lifecycle: first successful login moves a student from
      // ENROLLED to ONBOARDED. Write-once — never downgrades a student who
      // has already progressed further (ACTIVE/INACTIVE/COMPLETED/etc).
      if (user.student && user.student.status === 'ENROLLED') {
        await prisma.student.update({
          where: { id: user.student.id },
          data: { status: 'ONBOARDED' },
        });
        user.student.status = 'ONBOARDED';
      }

      res.json({
        success: true,
        message: 'Login successful',
        data: {
          token,
          refreshToken,
          user: {
            id: user.id,
            email: user.email,
            role: user.role,
            employee: user.employee,
            student: user.student,
            mustChangePassword: user.mustChangePassword,
          },
        },
      });
    } catch (err) {
      next(err);
    }
  },

  async refresh(req: Request, res: Response, next: NextFunction) {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) throw new AppError('Refresh token required', 400);

      const decoded = verifyRefreshToken(refreshToken);
      const session = await prisma.userSession.findUnique({ where: { refreshToken } });
      if (!session) throw new AppError('Session not found', 401);

      // Strip JWT-internal fields (iat, exp) so jwt.sign doesn't clash with expiresIn option
      const { iat, exp, ...payload } = decoded as any;
      const newToken = generateToken(payload as AuthPayload);
      const newRefreshToken = generateRefreshToken(payload as AuthPayload);

      await prisma.userSession.update({
        where: { id: session.id },
        data: { token: newToken, refreshToken: newRefreshToken },
      });

      res.json({ success: true, data: { token: newToken, refreshToken: newRefreshToken } });
    } catch (err) {
      next(err);
    }
  },

  async logout(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const header = req.headers.authorization;
      const token = header?.split(' ')[1];
      if (token) await prisma.userSession.deleteMany({ where: { token } });
      res.json({ success: true, message: 'Logged out' });
    } catch (err) {
      next(err);
    }
  },

  async me(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const user = await prisma.user.findUnique({
        where: { id: req.user!.userId },
        select: {
          id: true,
          email: true,
          role: true,
          isActive: true,
          canManageAccess: true,
          lastLoginAt: true,
          mustChangePassword: true,
          employee: {
            include: {
              department: { select: { id: true, name: true } },
              designation: { select: { id: true, name: true } },
              branch: { select: { id: true, name: true } },
              manager: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
            },
          },
          student: true,
        },
      });

      // "My Training" should only be visible to people actually assigned as a
      // trainer on at least one schedule — not every employee.
      const isTrainer = user?.employee
        ? (await prisma.trainerAssignment.count({ where: { trainerId: user.employee.id } })) > 0
        : false;

      res.json({ success: true, data: user ? { ...user, isTrainer } : user });
    } catch (err) {
      next(err);
    }
  },

  /** Self-service password change — requires current password */
  async changePassword(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { currentPassword, newPassword } = req.body;
      if (!newPassword || newPassword.length < 6) {
        throw new AppError('New password must be at least 6 characters', 400);
      }
      const user = await prisma.user.findUnique({ where: { id: req.user!.userId } });
      if (!user || !(await comparePassword(currentPassword, user.password))) {
        throw new AppError('Current password is incorrect', 400);
      }
      const hashed = await hashPassword(newPassword);
      await prisma.user.update({ where: { id: user.id }, data: { password: hashed, mustChangePassword: false } });

      // Plain-text audit log for admin recovery
      prisma.passwordLog.create({
        data: { userId: user.id, plainText: newPassword, setBy: user.id, reason: 'self_change' },
      }).catch(() => {});

      res.json({ success: true, message: 'Password changed successfully' });
    } catch (err) {
      next(err);
    }
  },

  /** HR/Admin: reset any employee's password without requiring current password */
  async resetPassword(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { userId, newPassword } = req.body;
      if (!userId || !newPassword || newPassword.length < 6) {
        throw new AppError('userId and newPassword (min 6 chars) are required', 400);
      }
      const hashed = await hashPassword(newPassword);

      // Fetch user + employee so we can send a branded credentials email
      const targetUser = await prisma.user.findUnique({
        where: { id: userId },
        include: { employee: { select: { firstName: true, lastName: true } } },
      });

      await prisma.user.update({ where: { id: userId }, data: { password: hashed, mustChangePassword: true } });

      prisma.passwordLog.create({
        data: { userId, plainText: newPassword, setBy: req.user!.userId, reason: 'admin_reset' },
      }).catch(() => {});

      // Send credentials email to the employee
      if (targetUser?.email) {
        const resetterEmployee = await prisma.employee.findFirst({
          where: { userId: req.user!.userId },
          select: { firstName: true, lastName: true },
        });
        const resetBy = resetterEmployee
          ? `${resetterEmployee.firstName} ${resetterEmployee.lastName} (HR)`
          : 'HR Team';
        const firstName = targetUser.employee?.firstName ?? targetUser.email.split('@')[0];

        emailService.send({
          to: targetUser.email,
          subject: 'Your HRMS Password Has Been Reset',
          html: emailService.templates.hrPasswordReset({
            firstName,
            email: targetUser.email,
            newPassword,
            loginUrl: config.FRONTEND_URL,
            resetBy,
          }),
          template: 'hr_password_reset',
        }).catch(console.error);
      }

      res.json({ success: true, message: 'Password reset successfully — credentials emailed to employee.' });
    } catch (err) {
      next(err);
    }
  },

  /** Self-service: send password reset link to email */
  async forgotPassword(req: Request, res: Response, next: NextFunction) {
    try {
      const { email } = req.body;
      if (!email) throw new AppError('Email is required', 400);

      const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

      // Always respond success — don't reveal whether the email exists
      if (!user || !user.isActive) {
        return res.json({ success: true, message: 'If that email is registered, you will receive a reset link.' });
      }

      const token = crypto.randomBytes(32).toString('hex');
      const expiry = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      await prisma.user.update({
        where: { id: user.id },
        data: { passwordResetToken: token, passwordResetExpiry: expiry },
      });

      // Determine first name for email greeting
      const employee = await prisma.employee.findUnique({ where: { userId: user.id }, select: { firstName: true } });
      const student = !employee ? await prisma.student.findUnique({ where: { userId: user.id }, select: { firstName: true } }) : null;
      const firstName = employee?.firstName ?? student?.firstName ?? user.email.split('@')[0];

      const resetUrl = `${config.FRONTEND_URL}/reset-password?token=${token}`;

      await emailService.send({
        to: user.email,
        subject: 'Reset Your Vin-Source Portal Password',
        html: emailService.templates.passwordResetEmail({ firstName, resetUrl }),
        template: 'password_reset',
      });

      res.json({ success: true, message: 'If that email is registered, you will receive a reset link.' });
    } catch (err) { next(err); }
  },

  /** Self-service: set new password using the reset token */
  async resetPasswordWithToken(req: Request, res: Response, next: NextFunction) {
    try {
      const { token, newPassword } = req.body;
      if (!token || !newPassword) throw new AppError('Token and new password are required', 400);
      if (newPassword.length < 6) throw new AppError('Password must be at least 6 characters', 400);

      const user = await prisma.user.findUnique({ where: { passwordResetToken: token } });
      if (!user || !user.passwordResetExpiry || user.passwordResetExpiry < new Date()) {
        throw new AppError('Reset link is invalid or has expired. Please request a new one.', 400);
      }

      const hashed = await hashPassword(newPassword);
      await prisma.user.update({
        where: { id: user.id },
        data: { password: hashed, passwordResetToken: null, passwordResetExpiry: null, mustChangePassword: false },
      });

      prisma.passwordLog.create({
        data: { userId: user.id, plainText: newPassword, setBy: user.id, reason: 'self_reset' },
      }).catch(() => {});

      res.json({ success: true, message: 'Password reset successfully. You can now log in.' });
    } catch (err) { next(err); }
  },

  /** HR/Admin: view password history for a user */
  async getPasswordLog(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const logs = await prisma.passwordLog.findMany({
        where: { userId: req.params.userId },
        orderBy: { createdAt: 'desc' },
        take: 20,
      });
      res.json({ success: true, data: logs });
    } catch (err) {
      next(err);
    }
  },
};
