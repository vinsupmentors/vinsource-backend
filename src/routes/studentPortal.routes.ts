import { Router } from 'express';
import { studentPortalController } from '../controllers/studentPortal.controller';
import { authenticate } from '../middleware/auth';
import { requireStudent } from '../middleware/rbac';
import { uploadStudentPhoto, uploadAadharPhoto, uploadProjectSubmission, uploadOnboardingSignature, uploadViolationSnapshot } from '../middleware/upload';

const router = Router();
router.use(authenticate);
router.use(requireStudent);

router.get('/me', studentPortalController.me);
router.put('/me', studentPortalController.updateMe);
router.post('/photo', uploadStudentPhoto, studentPortalController.uploadPhoto);
router.post('/aadhar-photo', uploadAadharPhoto, studentPortalController.uploadAadharPhoto);
router.get('/onboarding-documents', studentPortalController.myOnboardingDocuments);
router.post('/onboarding-documents/:templateId/sign', uploadOnboardingSignature, studentPortalController.signOnboardingDocument);
router.post('/fee-declarations/:id/sign', uploadOnboardingSignature, studentPortalController.signFeeDeclaration);
router.get('/enrollments', studentPortalController.myEnrollments);
router.get('/attendance', studentPortalController.myAttendance);
router.get('/marks', studentPortalController.myMarks);
router.get('/certificates', studentPortalController.myCertificates);
router.get('/placements', studentPortalController.myPlacements);
router.get('/course-content', studentPortalController.courseContent);
router.get('/rank-card', studentPortalController.rankCard);
router.get('/gamification', studentPortalController.gamification);
router.get('/feedback', studentPortalController.listFeedback);
router.post('/feedback', studentPortalController.submitFeedback);
router.get('/referrals', studentPortalController.listReferrals);
router.post('/referrals', studentPortalController.createReferral);

// Projects / Feedback Forms / Online Tests
router.get('/projects', studentPortalController.myProjects);
router.post('/projects/:releaseId/submit', uploadProjectSubmission, studentPortalController.submitProject);
router.get('/feedback-forms', studentPortalController.myFeedbackForms);
router.post('/feedback-forms/:releaseId/submit', studentPortalController.submitFeedbackForm);
router.get('/online-tests', studentPortalController.myOnlineTests);
router.post('/online-tests/:releaseId/start', studentPortalController.startOnlineTestAttempt);
router.get('/online-tests/attempts/:attemptId', studentPortalController.getOnlineTestAttempt);
router.get('/online-tests/attempts/:attemptId/review', studentPortalController.getOnlineTestAttemptReview);
router.post('/online-tests/attempts/:attemptId/answer', studentPortalController.saveOnlineTestAnswer);
router.post('/online-tests/attempts/:attemptId/violation', uploadViolationSnapshot, studentPortalController.recordTestViolation);
router.post('/online-tests/attempts/:attemptId/submit', studentPortalController.submitOnlineTestAttempt);

// Placement Training — Projects/Tests released to Softskill/Aptitude sessions
router.get('/placement-projects', studentPortalController.myPlacementProjects);
router.post('/placement-projects/:releaseId/submit', uploadProjectSubmission, studentPortalController.submitPlacementProject);
router.get('/placement-tests', studentPortalController.myPlacementTests);
router.post('/placement-tests/:releaseId/start', studentPortalController.startPlacementTestAttempt);
router.get('/placement-tests/attempts/:attemptId', studentPortalController.getPlacementTestAttempt);
router.get('/placement-tests/attempts/:attemptId/review', studentPortalController.getPlacementTestAttemptReview);
router.post('/placement-tests/attempts/:attemptId/answer', studentPortalController.savePlacementTestAnswer);
router.post('/placement-tests/attempts/:attemptId/violation', uploadViolationSnapshot, studentPortalController.recordPlacementTestViolation);
router.post('/placement-tests/attempts/:attemptId/submit', studentPortalController.submitPlacementTestAttempt);

// Portfolio
router.get('/portfolio', studentPortalController.getPortfolio);
router.post('/portfolio', studentPortalController.submitPortfolio);

export default router;
