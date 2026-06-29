import { Router } from 'express';
import { attendanceRegularizationController } from '../controllers/attendanceRegularization.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

router.post('/',            attendanceRegularizationController.apply);
router.get('/my',           attendanceRegularizationController.myRequests);
router.get('/pending',      requireMinRole('MANAGER'), attendanceRegularizationController.pending);
router.put('/:id/approve',  requireMinRole('MANAGER'), attendanceRegularizationController.approve);
router.put('/:id/reject',   requireMinRole('MANAGER'), attendanceRegularizationController.reject);

export default router;
