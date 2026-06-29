import { Router } from 'express';
import { compOffController } from '../controllers/compoff.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

const router = Router();

router.use(authenticate);

router.post('/',           compOffController.submit);
router.get('/my',          compOffController.myRequests);
router.get('/pending',     requireMinRole('MANAGER'), compOffController.pending);
router.put('/:id/approve', requireMinRole('MANAGER'), compOffController.approve);
router.put('/:id/reject',  requireMinRole('MANAGER'), compOffController.reject);

export default router;
