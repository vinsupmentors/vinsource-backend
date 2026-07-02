import { Router } from 'express';
import { onboardingController } from '../controllers/onboarding.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole, requireRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

// Employee — self-service onboarding wizard
router.get('/my',               onboardingController.getMyStatus);
router.put('/my/profile',       onboardingController.completeProfile);
router.post('/my/submit',       onboardingController.submitForReview);

// HR / Admin
router.post('/',                requireMinRole('HR'), onboardingController.create);
router.get('/',                 requireMinRole('HR'), onboardingController.list);
router.get('/:id',              onboardingController.getById);
router.put('/:id/approve',      requireMinRole('HR'), onboardingController.approve);
router.put('/:id/reject',       requireMinRole('HR'), onboardingController.reject);
router.put('/:id/final-approve', requireMinRole('HR'), onboardingController.hrFinalApprove);
router.put('/:id/final-reject',  requireMinRole('HR'), onboardingController.hrFinalReject);
router.put('/:id/reinitiate',    requireMinRole('HR'), onboardingController.reinitiate);
router.put('/:id',               requireMinRole('HR'), onboardingController.update);
router.delete('/:id',            requireRole('SUPER_ADMIN'), onboardingController.remove);

export default router;
