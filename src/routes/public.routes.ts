import { Router } from 'express';
import { portfolioController } from '../controllers/portfolio.controller';
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

export default router;
