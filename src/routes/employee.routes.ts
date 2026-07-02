import { Router } from 'express';
import { employeeController } from '../controllers/employee.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole, requireRole } from '../middleware/rbac';

const router = Router();

router.use(authenticate);

router.get('/me', employeeController.getMyProfile);
router.get('/my-team', requireMinRole('MANAGER'), employeeController.getDirectReports);
router.get('/probation', requireMinRole('HR'), employeeController.probationList);
router.get('/report/departments', requireMinRole('MANAGER'), employeeController.departmentReport);
router.get('/mapping', requireRole('SUPER_ADMIN'), employeeController.mappingList);
router.get('/', requireMinRole('MANAGER'), employeeController.list);
router.get('/:id', requireMinRole('MANAGER'), employeeController.get);
router.post('/', requireMinRole('HR'), employeeController.create);
router.post('/bulk', requireMinRole('HR'), employeeController.bulkCreate);
router.post('/calc-salary', requireMinRole('HR'), employeeController.calcSalary);
router.put('/mapping', requireRole('SUPER_ADMIN'), employeeController.bulkUpdateMapping);
router.put('/:id', requireMinRole('HR'), employeeController.update);
router.put('/:id/salary', requireMinRole('HR'), employeeController.updateSalary);
router.put('/:id/confirm', requireMinRole('HR'), employeeController.confirm);
router.patch('/:id/empcode', requireRole('SUPER_ADMIN'), employeeController.updateEmpCode);
router.delete('/:id', requireRole('SUPER_ADMIN'), employeeController.remove);

export default router;
