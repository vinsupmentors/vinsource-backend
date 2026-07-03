import { Router } from 'express';
import { assetController } from '../controllers/asset.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

// Employee: see own assigned assets
router.get('/my', assetController.myAssets);

// Managers (e.g. Ops/AGM) can view, create, edit, assign, and return assets
router.get('/', requireMinRole('MANAGER'), assetController.listAll);
router.post('/', requireMinRole('MANAGER'), assetController.create);
router.put('/:id', requireMinRole('MANAGER'), assetController.update);
router.post('/:id/assign', requireMinRole('MANAGER'), assetController.assign);
router.post('/assignments/:assignmentId/return', requireMinRole('MANAGER'), assetController.return);
router.get('/employee/:employeeId', requireMinRole('MANAGER'), assetController.employeeAssets);

export default router;
