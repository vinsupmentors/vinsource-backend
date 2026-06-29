import { Router } from 'express';
import { trainerPortalController } from '../controllers/trainerPortal.controller';
import { authenticate } from '../middleware/auth';

const router = Router();
router.use(authenticate);
// No module gate — every handler verifies the caller owns the relevant
// TrainerAssignment itself (see assertOwnsSchedule in the controller).

router.get('/schedules', trainerPortalController.mySchedules);
router.get('/schedules/:scheduleId/students', trainerPortalController.scheduleStudents);
router.get('/schedules/:scheduleId/attendance', trainerPortalController.getAttendance);
router.post('/schedules/:scheduleId/attendance', trainerPortalController.markAttendance);
router.get('/schedules/:scheduleId/tests', trainerPortalController.listTests);
router.post('/tests', trainerPortalController.createTest);
router.get('/tests/:testId/marks', trainerPortalController.testMarks);
router.post('/tests/:testId/marks', trainerPortalController.upsertMarks);
router.get('/feedback', trainerPortalController.listFeedback);
router.post('/feedback', trainerPortalController.upsertFeedback);
router.get('/schedules/:scheduleId/module-feedback', trainerPortalController.listModuleFeedback);
router.post('/schedules/:scheduleId/module-feedback', trainerPortalController.upsertModuleFeedback);

// Daily KRA — topics covered, per sub-batch (track), per day
router.get('/schedules/:scheduleId/kra', trainerPortalController.listMyKra);
router.post('/schedules/:scheduleId/kra', trainerPortalController.createKra);
router.put('/kra/:id', trainerPortalController.updateKra);
router.delete('/kra/:id', trainerPortalController.deleteKra);

// Projects / Feedback Forms / Online Tests — release & conduct
router.get('/schedules/:scheduleId/releasable-content', trainerPortalController.releasableContent);
router.post('/schedules/:scheduleId/release-project', trainerPortalController.releaseProject);
router.post('/schedules/:scheduleId/release-feedback-form', trainerPortalController.releaseFeedbackForm);
router.post('/schedules/:scheduleId/activate-test', trainerPortalController.activateOnlineTest);
router.post('/schedules/:scheduleId/close-release', trainerPortalController.closeRelease);
router.get('/schedules/:scheduleId/project-releases/:releaseId/submissions', trainerPortalController.projectSubmissions);
router.post('/schedules/:scheduleId/project-submissions/:submissionId/review', trainerPortalController.reviewProjectSubmission);
// Feedback form responses are intentionally NOT exposed to trainers — only the
// Production Manager may read what students submitted (see production.routes.ts).
router.get('/schedules/:scheduleId/test-releases/:releaseId/results', trainerPortalController.onlineTestResults);

export default router;
