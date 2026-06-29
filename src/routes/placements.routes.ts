import { Router } from 'express';
import { placementsController } from '../controllers/placements.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import { uploadOfferLetter } from '../middleware/upload';

const router = Router();
router.use(authenticate);
router.use(requireModule('PLACEMENTS', 'VIEW'));

router.get('/stats', placementsController.stats);
router.get('/pool', placementsController.pool);
router.get('/filters', placementsController.listFilterOptions);
router.get('/reports', placementsController.reports);
router.get('/students/:id/profile', placementsController.getStudentProfile);

router.get('/partners', placementsController.listPartners);
router.post('/partners', requireModule('PLACEMENTS', 'EDIT'), placementsController.createPartner);

router.get('/drives', placementsController.listDrives);
router.post('/drives', requireModule('PLACEMENTS', 'EDIT'), placementsController.createDrive);
router.put('/drives/:id', requireModule('PLACEMENTS', 'EDIT'), placementsController.updateDrive);

router.get('/results', placementsController.listResults);
router.post('/results', requireModule('PLACEMENTS', 'EDIT'), uploadOfferLetter, placementsController.createResult);
router.put('/results/:id', requireModule('PLACEMENTS', 'EDIT'), uploadOfferLetter, placementsController.updateResult);

// ── Softskill / Aptitude sessions ──────────────────────────────────────────
router.get('/softskill-sessions', placementsController.listSoftskillSessions);
router.post('/softskill-sessions', requireModule('PLACEMENTS', 'EDIT'), placementsController.createSoftskillSession);
router.get('/softskill-sessions/:id/attendance', placementsController.getSoftskillAttendance);
router.post('/softskill-sessions/:id/attendance', requireModule('PLACEMENTS', 'EDIT'), placementsController.markSoftskillAttendance);

// ── Drive candidate shortlist ───────────────────────────────────────────────
router.get('/drive-candidates', placementsController.listDriveCandidates);
router.post('/drive-candidates', requireModule('PLACEMENTS', 'EDIT'), placementsController.addDriveCandidate);
router.put('/drive-candidates/:id', requireModule('PLACEMENTS', 'EDIT'), placementsController.updateDriveCandidate);

// ── Interviews ───────────────────────────────────────────────────────────────
router.get('/interviews', placementsController.listInterviews);
router.put('/interviews/:id', requireModule('PLACEMENTS', 'EDIT'), placementsController.updateInterview);

export default router;
