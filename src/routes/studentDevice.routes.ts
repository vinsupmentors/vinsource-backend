import { Router } from 'express';
import { studentDeviceController } from '../controllers/studentDevice.controller';
import { authenticate } from '../middleware/auth';
import { requireRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);
// Same audience as approving student deletions (Production → Deletion Requests).
router.use(requireRole('ADMIN', 'SUPER_ADMIN', 'MANAGER'));

router.get('/', studentDeviceController.list);
router.post('/:id/approve', studentDeviceController.approve);
router.post('/:id/reject', studentDeviceController.reject);
router.post('/students/:studentId/reset', studentDeviceController.reset);

export default router;
