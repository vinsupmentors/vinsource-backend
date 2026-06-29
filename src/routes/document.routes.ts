import { Router } from 'express';
import { documentController } from '../controllers/document.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';
import { uploadDocument } from '../middleware/upload';

const router = Router();
router.use(authenticate);

// Employee: view and upload their own documents
router.get('/my', documentController.list);
router.post('/upload', uploadDocument, documentController.upload);
router.delete('/:id', documentController.delete);

// HR: view all employees' documents, mark original submitted, verify
router.get('/all', requireMinRole('HR'), documentController.listForHR);
router.get('/originals-summary', requireMinRole('HR'), documentController.originalsSummary);
router.post('/collect-originals', requireMinRole('HR'), documentController.collectOriginalsAtJoining);
router.get('/employee/:employeeId', requireMinRole('HR'), documentController.list);
router.put('/:id/mark-original', requireMinRole('HR'), documentController.markOriginal);
router.put('/:id/verify', requireMinRole('HR'), documentController.verify);

export default router;
