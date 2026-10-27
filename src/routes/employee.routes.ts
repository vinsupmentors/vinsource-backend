import { Router } from 'express';
import { employeeController } from '../controllers/employee.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole, requireRole, requireRoleOrModule } from '../middleware/rbac';

// HR work = HR login role or above, OR HR module access (EDIT) given via department / Master Control.
const hrWork = requireRoleOrModule('HR', 'HR', 'EDIT');
const hrView = requireRoleOrModule('MANAGER', 'HR', 'VIEW');
import { uploadProfilePhoto } from '../middleware/upload';

const router = Router();

router.use(authenticate);

router.get('/me', employeeController.getMyProfile);
router.post('/me/photo', uploadProfilePhoto, employeeController.uploadMyPhoto);
router.get('/my-team', requireMinRole('MANAGER'), employeeController.getDirectReports);
router.get('/probation', hrWork, employeeController.probationList);
router.get('/report/departments', requireMinRole('MANAGER'), employeeController.departmentReport);
router.get('/mapping', requireRole('SUPER_ADMIN'), employeeController.mappingList);
router.get('/', hrView, employeeController.list);
router.get('/:id', hrView, employeeController.get);
router.post('/', hrWork, employeeController.create);
router.post('/bulk', hrWork, employeeController.bulkCreate);
router.post('/calc-salary', hrWork, employeeController.calcSalary);
router.put('/mapping', requireRole('SUPER_ADMIN'), employeeController.bulkUpdateMapping);
router.put('/:id', hrWork, employeeController.update);
router.post('/:id/photo', hrWork, uploadProfilePhoto, employeeController.uploadEmployeePhoto);
router.put('/:id/salary', hrWork, employeeController.updateSalary);
router.put('/:id/confirm', hrWork, employeeController.confirm);
router.patch('/:id/empcode', requireRole('SUPER_ADMIN'), employeeController.updateEmpCode);
router.delete('/:id', requireRole('SUPER_ADMIN'), employeeController.remove);

export default router;
