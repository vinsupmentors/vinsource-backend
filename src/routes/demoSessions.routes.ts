import { Router } from 'express';
import { demoSessionsController } from '../controllers/demoSessions.controller';
import { authenticate } from '../middleware/auth';

// Identity-scoped like trainerPortal.routes.ts — each handler checks who the
// caller is (requester / production manager / assigned trainer) itself.
const router = Router();
router.use(authenticate);

router.get('/options', demoSessionsController.options);
router.get('/', demoSessionsController.list);
router.post('/', demoSessionsController.create);
router.post('/:id/approve', demoSessionsController.approve);
router.post('/:id/reject', demoSessionsController.reject);
router.post('/:id/cancel', demoSessionsController.cancel);

export default router;
