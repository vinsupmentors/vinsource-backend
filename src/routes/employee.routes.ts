import { Router } from 'express';
import { employeeController } from '../controllers/employee.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

const router = Router();

router.use(authenticate);

router.get('/me', employeeController.getMyProfile);
router.get('/my-team', requireMinRole('MANAGER'), employeeController.getDirectReports);
router.get('/', requireMinRole('MANAGER'), employeeController.list);
router.get('/:id', requireMinRole('MANAGER'), employeeController.get);
router.post('/', requireMinRole('HR'), employeeController.create);
router.post('/bulk', requireMinRole('HR'), employeeController.bulkCreate);
router.post('/calc-salary', requireMinRole('HR'), employeeController.calcSalary);
router.put('/:id', requireMinRole('HR'), employeeController.update);
router.put('/:id/salary', requireMinRole('HR'), employeeController.updateSalary);

export default router;
