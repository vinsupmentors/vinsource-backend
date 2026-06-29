import { Router } from 'express';
import { notificationController } from '../controllers/notification.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

router.get('/', notificationController.list);
router.get('/unread-count', notificationController.unreadCount);
router.put('/:id/read', notificationController.markRead);
router.put('/read-all', notificationController.markAllRead);

// HR/Admin — manually trigger today's birthday check (for testing; runs automatically via cron otherwise)
router.post('/trigger-birthday-check', requireMinRole('HR'), notificationController.triggerBirthdayCheck);

export default router;
