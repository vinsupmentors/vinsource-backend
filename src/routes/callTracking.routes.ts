import { Router } from 'express';
import { callTrackingController } from '../controllers/callTracking.controller';
import { authenticateDevice } from '../middleware/deviceAuth';

// Deliberately NOT behind `authenticate` — this is hit unattended by the SIM
// call-tracking Android app via its own per-device token (see deviceAuth.ts),
// not by a logged-in portal user. Keep this router mounted at its own base
// path (not nested under /api/sales) so it never accidentally picks up the
// employee-JWT middleware that router applies to everything under it.
const router = Router();

router.post('/events', authenticateDevice, callTrackingController.ingestCallEvent);

export default router;
