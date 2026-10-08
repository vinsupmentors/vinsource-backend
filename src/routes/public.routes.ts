import { Router } from 'express';
import { portfolioController } from '../controllers/portfolio.controller';
import { publicDemoController } from '../controllers/demoSessions.controller';
import rateLimit from 'express-rate-limit';
import { publicVerifyCertificate } from '../controllers/certificateRequests.controller';

// Deliberately NOT behind `authenticate` — this is the public surface a scanned
// QR code / shared link hits with no login. Keep this router minimal and make
// sure every controller method here only ever returns already-approved data.
const router = Router();

router.get('/portfolio/:slug', portfolioController.publicGet);
// Query-string, not a :certNo path param — certificate numbers contain
// literal slashes (VSA/ICP/2026/0001), which a path segment can't carry
// unambiguously once percent-encoded/decoded across both the browser router
// and Express. ?cert= sidesteps that entirely.
router.get('/certificate', publicVerifyCertificate);

// Demo sit-in join — public (the prospect has no account), so rate-limited per IP.
const demoLimiter = rateLimit({ windowMs: 5 * 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false });
router.post('/demo-join', demoLimiter, publicDemoController.join);

export default router;
