import { Router } from 'express';
import { studentOnboardingController } from '../controllers/studentOnboarding.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import { uploadOnboardingTemplate } from '../middleware/upload';

const router = Router();
router.use(authenticate);
router.use(requireModule('STUDENT_ONBOARDING', 'VIEW'));

router.get('/templates', studentOnboardingController.listTemplates);
router.post('/templates', requireModule('STUDENT_ONBOARDING', 'EDIT'), uploadOnboardingTemplate, studentOnboardingController.createTemplate);
router.put('/templates/:id', requireModule('STUDENT_ONBOARDING', 'EDIT'), studentOnboardingController.updateTemplate);
router.delete('/templates/:id', requireModule('STUDENT_ONBOARDING', 'ADMIN'), studentOnboardingController.deleteTemplate);

router.get('/batches', studentOnboardingController.batchSummary);
router.get('/batches/:id/students', studentOnboardingController.batchStudents);

export default router;
