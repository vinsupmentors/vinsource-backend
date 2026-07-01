import { Router } from 'express';
import { leaveController } from '../controllers/leave.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole, requireRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

router.get('/all', requireRole('SUPER_ADMIN'), leaveController.all);
router.get('/types', leaveController.types);
router.get('/types/all', requireMinRole('HR'), leaveController.allTypes);
router.post('/types', requireRole('SUPER_ADMIN'), leaveController.createType);
router.delete('/types/:id', requireRole('SUPER_ADMIN'), leaveController.deleteType);
router.post('/accrue-monthly', requireMinRole('HR'), leaveController.accrueMonthly);
router.post('/apply', leaveController.apply);
router.get('/my-requests', leaveController.myRequests);
router.get('/my-balances', leaveController.myBalances);
router.get('/calendar', leaveController.calendar);
router.get('/pending', requireMinRole('MANAGER'), leaveController.pendingForManager);
router.put('/:id/approve', requireMinRole('MANAGER'), leaveController.approve);
router.put('/:id/reject', requireMinRole('MANAGER'), leaveController.reject);

export default router;
