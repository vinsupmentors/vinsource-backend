import { Router } from 'express';
import { onboardingController } from '../controllers/onboarding.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole, requireRoleOrModule, requireRole } from '../middleware/rbac';

const hrWork = requireRoleOrModule('HR', 'HR', 'EDIT');

const router = Router();
router.use(authenticate);

// Employee — self-service onboarding wizard
router.get('/my',               onboardingController.getMyStatus);
router.put('/my/profile',       onboardingController.completeProfile);
router.post('/my/submit',       onboardingController.submitForReview);

// HR / Admin
router.post('/',                hrWork, onboardingController.create);
router.get('/',                 hrWork, onboardingController.list);
router.get('/:id',              onboardingController.getById);
router.put('/:id/approve',      hrWork, onboardingController.approve);
router.put('/:id/reject',       hrWork, onboardingController.reject);
router.put('/:id/final-approve', hrWork, onboardingController.hrFinalApprove);
router.put('/:id/final-reject',  hrWork, onboardingController.hrFinalReject);
router.put('/:id/reinitiate',    hrWork, onboardingController.reinitiate);
router.put('/:id',               hrWork, onboardingController.update);
router.delete('/:id',            requireRole('SUPER_ADMIN'), onboardingController.remove);

export default router;
