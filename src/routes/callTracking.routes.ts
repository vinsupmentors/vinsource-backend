import { Router } from 'express';
import { callTrackingController } from '../controllers/callTracking.controller';
import { authenticateDevice } from '../middleware/deviceAuth';
import { authenticate } from '../middleware/auth';
import { uploadCallRecording } from '../middleware/upload';

// The device routes are deliberately NOT behind `authenticate` — they are hit
// unattended by the SIM call-tracking Android app via its own per-device token
// (see deviceAuth.ts), not by a logged-in portal user. Keep this router mounted
// at its own base path (not nested under /api/sales) so it never accidentally
// picks up the employee-JWT middleware that router applies to everything under it.
// The playback route below DOES require a normal portal login.
const router = Router();

router.post('/events', authenticateDevice, callTrackingController.ingestCallEvent);
router.post('/events/:id/recording', authenticateDevice, uploadCallRecording, callTrackingController.uploadRecording);

// Portal users (BDA who made the call / Sales admin / Admin) — fetched as a blob by the CRM.
router.get('/recordings/:id', authenticate, callTrackingController.streamRecording);

export default router;
