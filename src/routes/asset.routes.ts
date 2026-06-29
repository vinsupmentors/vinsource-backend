import { Router } from 'express';
import { assetController } from '../controllers/asset.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

// Employee: see own assigned assets
router.get('/my', assetController.myAssets);

// Managers can view, assign, and return; HR can also create and edit asset records
router.get('/', requireMinRole('MANAGER'), assetController.listAll);
router.post('/', requireMinRole('HR'), assetController.create);
router.put('/:id', requireMinRole('HR'), assetController.update);
router.post('/:id/assign', requireMinRole('MANAGER'), assetController.assign);
router.post('/assignments/:assignmentId/return', requireMinRole('MANAGER'), assetController.return);
router.get('/employee/:employeeId', requireMinRole('MANAGER'), assetController.employeeAssets);

export default router;
