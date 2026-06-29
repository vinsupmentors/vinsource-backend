import { Router } from 'express';
import { accessController } from '../controllers/access.controller';
import { authenticate } from '../middleware/auth';
import { requireMasterControl } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

// Any authenticated user can read their own effective access (drives the sidebar).
router.get('/me', accessController.myAccess);

// Master Control only — view/manage access for anyone, regardless of own department.
router.get('/directory',                          requireMasterControl, accessController.directory);
router.get('/employees/:employeeId',               requireMasterControl, accessController.employeeAccess);
router.get('/department-defaults',                 requireMasterControl, accessController.departmentDefaults);
router.put('/department-defaults/:departmentId',   requireMasterControl, accessController.setDepartmentDefault);
router.put('/users/:userId/override',               requireMasterControl, accessController.setUserOverride);
router.delete('/users/:userId/override/:module',    requireMasterControl, accessController.removeUserOverride);
router.put('/users/:userId/master-control',         requireMasterControl, accessController.setMasterControl);

export default router;
