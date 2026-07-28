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

router.get('/approvals', studentOnboardingController.listApprovals);
router.get('/approvals/:studentId', studentOnboardingController.approvalDetail);
router.post('/approvals/:studentId/approve', requireModule('STUDENT_ONBOARDING', 'EDIT'), studentOnboardingController.approveStudent);

router.get('/students/:studentId/fee-declarations', studentOnboardingController.listFeeDeclarations);
router.post('/students/:studentId/fee-declarations', requireModule('STUDENT_ONBOARDING', 'EDIT'), studentOnboardingController.createFeeDeclaration);
router.delete('/fee-declarations/:id', requireModule('STUDENT_ONBOARDING', 'EDIT'), studentOnboardingController.deleteFeeDeclaration);

export default router;
