import { Router } from 'express';
import { salesOnboardingController } from '../controllers/salesOnboarding.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';

const router = Router();
router.use(authenticate);
router.use(requireModule('EMI', 'VIEW'));

router.get('/plans', salesOnboardingController.emiPlans);

export default router;
