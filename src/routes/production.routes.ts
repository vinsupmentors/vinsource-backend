import { Router } from 'express';
import { productionController } from '../controllers/production.controller';
import { productionContentController } from '../controllers/productionContent.controller';
import { productionReportsController } from '../controllers/productionReports.controller';
import { portfolioController } from '../controllers/portfolio.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import { uploadProjectResource } from '../middleware/upload';

const router = Router();
router.use(authenticate);
router.use(requireModule('PRODUCTION_TRAINING', 'VIEW'));

router.get('/stats', productionController.stats);

// Courses & modules
router.get('/courses', productionController.listCourses);
router.post('/courses', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.createCourse);
router.put('/courses/:id', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.updateCourse);
router.post('/courses/:courseId/modules', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.addModule);
router.put('/modules/:id', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.updateModule);

// Batches & schedules
router.get('/batches', productionController.listBatches);
router.post('/batches', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.createBatch);
router.put('/batches/:id', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.updateBatch);
router.post('/batches/:batchId/schedules', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.addSchedule);
router.post('/schedules/:scheduleId/trainers', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.assignTrainer);
router.delete('/schedules/:scheduleId/trainers/:trainerId', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.removeTrainer);
router.put('/schedules/:scheduleId', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.updateSchedule);
router.delete('/schedules/:scheduleId', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.deleteSchedule);

// Students & enrollments
router.get('/students', productionController.listStudents);
router.post('/students', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.createStudent);
router.post('/students/bulk', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.bulkUploadStudents);
// PM authority: push an entire sub-batch (schedule + optional track) into the
// Placements pool — flags students only (status + movedToPlacementAt), no
// eligibility gate, no auto-created PlacementResult.
router.post('/students/push-to-placements', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.pushToPlacements);

// PM authority: bulk status change for an explicit, checkbox-picked list of
// students within a filtered sub-batch view — the general-purpose tool for
// updating 50-70 students at once instead of editing each one individually.
// NOTE: must be registered before the '/students/:id' route below, otherwise
// Express matches ':id' first and treats the literal "bulk-status" as a
// student id (caused a 500 — PrismaClientValidationError on updateStudent).
router.put('/students/bulk-status', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.bulkUpdateStudentStatus);

router.put('/students/:id', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.updateStudent);
router.post('/enrollments', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.enrollStudent);
router.post('/enrollments/bulk', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.bulkEnrollStudents);
router.put('/enrollments/:id', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionController.updateEnrollment);

// Projects (PM-authored, module-wise)
router.get('/projects', productionContentController.listProjects);
router.post('/projects', requireModule('PRODUCTION_TRAINING', 'EDIT'), uploadProjectResource, productionContentController.createProject);
router.put('/projects/:id', requireModule('PRODUCTION_TRAINING', 'EDIT'), uploadProjectResource, productionContentController.updateProject);

// Feedback forms (PM builds a full custom template per module)
router.get('/feedback-forms', productionContentController.listFeedbackForms);
router.post('/feedback-forms', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionContentController.saveFeedbackForm);

// Feedback responses — PM-only read surface. Trainers cannot see these (see trainerPortal.routes.ts).
router.get('/feedback-releases', productionContentController.listFeedbackReleases);
router.get('/feedback-releases/:releaseId/responses', productionContentController.feedbackResponses);

// Online tests (PM authors MCQ-only tests; bulk question upload)
router.get('/online-tests', productionContentController.listOnlineTests);
router.get('/online-tests/:id', productionContentController.getOnlineTest);
router.post('/online-tests', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionContentController.createOnlineTest);
router.put('/online-tests/:id', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionContentController.updateOnlineTest);
router.post('/online-tests/:id/questions', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionContentController.addQuestion);
router.post('/online-tests/:id/questions/bulk', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionContentController.bulkUploadQuestions);
router.delete('/online-tests/:id/questions/:questionId', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionContentController.deleteQuestion);

// ── Reports (PM/admin view — read-only aggregates over existing data) ──────
router.get('/reports/trainer', productionReportsController.trainerReport);
router.get('/reports/batches', productionReportsController.batchReport);
router.get('/reports/attendance', productionReportsController.attendanceReport);
router.get('/reports/students', productionReportsController.studentList);
router.get('/reports/students/:studentId', productionReportsController.studentReport);
router.get('/reports/kra', productionReportsController.listKra);

// Student Portfolio approvals — student fills it in the student portal, PM reviews here.
router.get('/portfolios/pending', portfolioController.pending);
router.get('/portfolios', portfolioController.list);
router.get('/portfolios/:id', portfolioController.get);
router.post('/portfolios/:id/approve', requireModule('PRODUCTION_TRAINING', 'EDIT'), portfolioController.approve);
router.post('/portfolios/:id/reject', requireModule('PRODUCTION_TRAINING', 'EDIT'), portfolioController.reject);

// Report recipients (settings) — who gets the daily attendance report / escalation emails.
// Mutations require EDIT since this controls who receives sensitive student data.
router.get('/report-recipients', productionReportsController.listRecipients);
router.post('/report-recipients', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionReportsController.addRecipient);
router.delete('/report-recipients/:id', requireModule('PRODUCTION_TRAINING', 'EDIT'), productionReportsController.removeRecipient);

export default router;
