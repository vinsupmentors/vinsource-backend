import { Router } from 'express';
import { resignationController } from '../controllers/resignation.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

// Employee
router.post('/',           resignationController.submit);
router.get('/',            resignationController.list);
router.get('/:id',         resignationController.getById);

// Manager actions
router.put('/:id/manager-approve', requireMinRole('MANAGER'), resignationController.managerApprove);
router.put('/:id/manager-reject',  requireMinRole('MANAGER'), resignationController.managerReject);

// HR actions
router.put('/:id/hr-approve', requireMinRole('HR'), resignationController.hrApprove);
router.put('/:id/hr-reject',  requireMinRole('HR'), resignationController.hrReject);

// Exit clearance
router.post('/:id/exit-clearance',               requireMinRole('MANAGER'), resignationController.initiateExitClearance);
router.put('/:id/exit-clearance/doc/:docId',     requireMinRole('MANAGER'), resignationController.markDocumentReceived);
router.put('/:id/exit-clearance/manager-clear',  requireMinRole('MANAGER'), resignationController.managerClearExit);
router.put('/:id/exit-clearance/manager-reject', requireMinRole('MANAGER'), resignationController.managerRejectExit);
router.put('/:id/exit-clearance/hr-clear',       requireMinRole('HR'),      resignationController.hrClearExit);
router.put('/:id/exit-clearance/hr-reject',      requireMinRole('HR'),      resignationController.hrRejectExit);

export default router;
