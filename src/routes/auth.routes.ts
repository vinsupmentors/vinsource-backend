import { Router } from 'express';
import { authController } from '../controllers/auth.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

const router = Router();

router.post('/login', authController.login);
router.post('/refresh', authController.refresh);
router.post('/forgot-password', authController.forgotPassword);
router.post('/reset-password-token', authController.resetPasswordWithToken);
router.post('/logout', authenticate, authController.logout);
router.get('/me', authenticate, authController.me);
router.put('/change-password', authenticate, authController.changePassword);

// HR/Admin: reset any employee password + view password log
router.put('/reset-password', authenticate, requireMinRole('HR'), authController.resetPassword);
router.get('/password-log/:userId', authenticate, requireMinRole('HR'), authController.getPasswordLog);

export default router;
