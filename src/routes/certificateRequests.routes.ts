import { Router } from 'express';
import { certificateRequestsController } from '../controllers/certificateRequests.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';

const router = Router();
router.use(authenticate);
router.use(requireModule('CERTIFICATES', 'VIEW'));

router.get('/', certificateRequestsController.list);
router.get('/:id', certificateRequestsController.get);
router.get('/:id/download', certificateRequestsController.download);

// Both approval buttons are open to anyone with CERTIFICATES EDIT access —
// no designation-specific (e.g. LDM-only) restriction on who may click which.
router.post('/:id/approve-fee', requireModule('CERTIFICATES', 'EDIT'), certificateRequestsController.approveFee);
router.post('/:id/approve-ldm', requireModule('CERTIFICATES', 'EDIT'), certificateRequestsController.approveLdm);

export default router;
