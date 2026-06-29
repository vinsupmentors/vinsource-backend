import { Router } from 'express';
import { studentPortalController } from '../controllers/studentPortal.controller';
import { authenticate } from '../middleware/auth';
import { requireStudent } from '../middleware/rbac';
import { uploadStudentPhoto, uploadAadharPhoto, uploadProjectSubmission } from '../middleware/upload';

const router = Router();
router.use(authenticate);
router.use(requireStudent);

router.get('/me', studentPortalController.me);
router.put('/me', studentPortalController.updateMe);
router.post('/photo', uploadStudentPhoto, studentPortalController.uploadPhoto);
router.post('/aadhar-photo', uploadAadharPhoto, studentPortalController.uploadAadharPhoto);
router.get('/enrollments', studentPortalController.myEnrollments);
router.get('/attendance', studentPortalController.myAttendance);
router.get('/marks', studentPortalController.myMarks);
router.get('/certificates', studentPortalController.myCertificates);
router.get('/placements', studentPortalController.myPlacements);
router.get('/course-content', studentPortalController.courseContent);
router.get('/rank-card', studentPortalController.rankCard);
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
router.post('/online-tests/attempts/:attemptId/answer', studentPortalController.saveOnlineTestAnswer);
router.post('/online-tests/attempts/:attemptId/submit', studentPortalController.submitOnlineTestAttempt);

// Portfolio
router.get('/portfolio', studentPortalController.getPortfolio);
router.post('/portfolio', studentPortalController.submitPortfolio);

export default router;
