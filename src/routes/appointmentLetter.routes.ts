import { Router } from 'express';
import { appointmentLetterController } from '../controllers/appointmentLetter.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

// Any authenticated HR/ADMIN/SUPER_ADMIN can list and create
router.get('/', requireMinRole('HR'), appointmentLetterController.list);
router.post('/', requireMinRole('HR'), appointmentLetterController.create);

// Specific letter actions
router.get('/:id', requireMinRole('HR'), appointmentLetterController.get);
router.put('/:id', requireMinRole('HR'), appointmentLetterController.update);
router.post('/:id/submit', requireMinRole('HR'), appointmentLetterController.submit);
router.get('/:id/pdf', requireMinRole('HR'), appointmentLetterController.downloadPdf);
router.delete('/:id', requireMinRole('HR'), appointmentLetterController.remove);

// Approval actions — SUPER_ADMIN and ADMIN level (Pooranam is ADMIN)
router.post('/:id/approve', requireMinRole('ADMIN'), appointmentLetterController.approve);
router.post('/:id/reject', requireMinRole('ADMIN'), appointmentLetterController.reject);

export default router;
