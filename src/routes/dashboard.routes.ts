import { Router } from 'express';
import { dashboardController } from '../controllers/dashboard.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

router.get('/stats', dashboardController.stats);
router.get('/my-stats', dashboardController.myStats);
router.get('/manager-stats', requireMinRole('MANAGER'), dashboardController.managerStats);

export default router;
