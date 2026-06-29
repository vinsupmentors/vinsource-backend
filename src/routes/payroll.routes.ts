import { Router } from 'express';
import { payrollController } from '../controllers/payroll.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole, requireRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

router.get('/my-payslips', payrollController.myPayslips);
router.get('/payslip/:id', payrollController.getPayslip);
router.get('/', requireMinRole('HR'), payrollController.list);
router.get('/:id/payslips', requireMinRole('HR'), payrollController.batchPayslips);
router.post('/process', requireMinRole('HR'), payrollController.process);
router.put('/:id/approve', requireRole('ADMIN', 'SUPER_ADMIN'), payrollController.approve);

export default router;
