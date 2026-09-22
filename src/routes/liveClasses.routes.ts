import { Router } from 'express';
import { liveClassesController } from '../controllers/liveClasses.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

// Staff-only (module-gated): scheduling, picking a batch/schedule to
// attach a class to, and the full CRUD lifecycle. Trainers need at least
// VIEW/EDIT on LIVE_CLASSES granted via Master Control (department default
// or a per-user override), same as every other module in this app —
// students are never granted module access at all (see requireStudent
// elsewhere), which is exactly why the join/leave/chat/participants
// endpoints below do NOT sit behind requireModule: they do their own
// enrollment/trainer-assignment check per class instead, so both a
// student and a trainer can reach the same endpoint safely.
router.get('/analytics', requireModule('LIVE_CLASSES', 'VIEW'), liveClassesController.analytics);
router.get('/schedules', requireModule('LIVE_CLASSES', 'EDIT'), liveClassesController.listSchedules);
router.post('/', requireModule('LIVE_CLASSES', 'EDIT'), liveClassesController.create);
router.put('/:id', requireModule('LIVE_CLASSES', 'EDIT'), liveClassesController.update);
router.post('/:id/cancel', requireModule('LIVE_CLASSES', 'EDIT'), liveClassesController.cancel);
router.post('/:id/start', requireModule('LIVE_CLASSES', 'EDIT'), liveClassesController.start);
router.post('/:id/end', requireModule('LIVE_CLASSES', 'EDIT'), liveClassesController.end);
router.post('/:id/attendance/sync', requireModule('LIVE_CLASSES', 'EDIT'), liveClassesController.syncAttendance);
router.post('/:id/host-actions/mute', requireModule('LIVE_CLASSES', 'EDIT'), liveClassesController.muteParticipant);
router.post('/:id/host-actions/remove', requireModule('LIVE_CLASSES', 'EDIT'), liveClassesController.removeParticipant);

// Identity-scoped (no module gate, same philosophy as trainerPortal.routes.ts
// — "every handler verifies ownership itself") — reachable by staff AND
// students; list/dashboard self-scope to the caller's own
// TrainerAssignment / active StudentBatchEnrollment rows (or everything, for
// LIVE_CLASSES=ADMIN), and the rest verify access against one specific class.
router.get('/dashboard', liveClassesController.dashboard);
router.get('/', liveClassesController.list);
router.get('/:id', liveClassesController.get);
router.post('/:id/join', liveClassesController.join);
router.post('/:id/leave', liveClassesController.leave);
router.get('/:id/participants', liveClassesController.participants);
router.get('/:id/chat', liveClassesController.listChat);
router.post('/:id/chat', liveClassesController.postChat);
router.get('/:id/attendance', liveClassesController.attendance);
router.get('/:id/recordings', liveClassesController.recordings);
router.get('/:id/recordings/:recordingId/play', liveClassesController.playRecording);

export default router;
