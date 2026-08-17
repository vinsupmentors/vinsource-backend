import { Router } from 'express';
import { batchCertificateController } from '../controllers/batchCertificate.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import { uploadCertificatePhoto, uploadCertificateEmailPdf } from '../middleware/upload';

const router = Router();
router.use(authenticate);
router.use(requireModule('CERTIFICATES', 'VIEW'));

router.get('/batches', batchCertificateController.listBatches);
router.get('/', batchCertificateController.listForBatch);
router.get('/:id', batchCertificateController.get);

router.post('/generate', requireModule('CERTIFICATES', 'EDIT'), batchCertificateController.generateForBatch);
router.put('/:id', requireModule('CERTIFICATES', 'EDIT'), batchCertificateController.update);
router.post('/:id/photo', requireModule('CERTIFICATES', 'EDIT'), uploadCertificatePhoto, batchCertificateController.uploadPhoto);
router.post('/:id/email', requireModule('CERTIFICATES', 'EDIT'), uploadCertificateEmailPdf, batchCertificateController.emailCertificate);
router.delete('/:id', requireModule('CERTIFICATES', 'EDIT'), batchCertificateController.remove);

export default router;
