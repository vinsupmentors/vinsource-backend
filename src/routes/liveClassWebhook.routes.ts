import { Router } from 'express';
import { liveClassesController } from '../controllers/liveClasses.controller';

// Deliberately NOT behind `authenticate` — this is called by our own
// self-hosted LiveKit server, not a logged-in portal user. Authenticity is
// verified inside the controller via the webhook's own signature (signed
// with LIVEKIT_API_KEY/SECRET), not a session token. See app.ts for why this
// route is mounted with express.raw() BEFORE the global express.json() —
// signature verification needs the exact raw request body.
const router = Router();
router.post('/', liveClassesController.webhook);

export default router;
