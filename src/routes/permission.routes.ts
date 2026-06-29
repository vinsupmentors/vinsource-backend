import { Router } from 'express';
import { permissionController } from '../controllers/permission.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole, requireRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

router.get('/all',          requireRole('SUPER_ADMIN'), permissionController.all);
router.post('/',            permissionController.apply);
router.get('/my',           permissionController.myPermissions);
router.get('/pending',      requireMinRole('MANAGER'), permissionController.pending);
router.put('/:id/approve',  requireMinRole('MANAGER'), permissionController.approve);
router.put('/:id/reject',   requireMinRole('MANAGER'), permissionController.reject);

export default router;
