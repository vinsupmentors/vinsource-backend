import { Router } from 'express';
import { portfolioController } from '../controllers/portfolio.controller';

// Deliberately NOT behind `authenticate` — this is the public surface a scanned
// QR code / shared link hits with no login. Keep this router minimal and make
// sure every controller method here only ever returns already-approved data.
const router = Router();

router.get('/portfolio/:slug', portfolioController.publicGet);

export default router;
