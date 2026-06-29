import { Router } from 'express';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';
import { reportController } from '../controllers/report.controller';

const router = Router();
router.use(authenticate, requireMinRole('HR'));

router.get('/filters',    reportController.filters);
router.get('/attendance', reportController.attendance);
router.get('/pay-scale',  reportController.payScale);
router.get('/leave',      reportController.leave);
router.get('/employees',  reportController.employees);

export default router;
