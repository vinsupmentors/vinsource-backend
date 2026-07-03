import { Router } from 'express';
import { certificateController } from '../controllers/certificate.controller';
import { authenticate } from '../middleware/auth';
import { requireModule, requireRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

// Access is granted per-user via Master Control (CERTIFICATES module).
router.get('/', requireModule('CERTIFICATES', 'VIEW'), certificateController.list);
router.post('/', requireModule('CERTIFICATES', 'EDIT'), certificateController.create);
router.delete('/:id', requireRole('SUPER_ADMIN'), certificateController.remove);

export default router;
