import { Router } from 'express';
import { salesController } from '../controllers/sales.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';

const router = Router();
router.use(authenticate);
router.use(requireModule('SALES', 'VIEW'));

router.get('/stats', salesController.stats);

router.get('/leads', salesController.listLeads);
router.post('/leads', requireModule('SALES', 'EDIT'), salesController.createLead);
router.post('/leads/bulk', requireModule('SALES', 'EDIT'), salesController.bulkUploadLeads);
router.put('/leads/:id', requireModule('SALES', 'EDIT'), salesController.updateLead);
router.delete('/leads/:id', requireModule('SALES', 'ADMIN'), salesController.deleteLead);

router.get('/leads/:id/calls', salesController.listCallLogs);
router.post('/leads/:id/calls', requireModule('SALES', 'EDIT'), salesController.addCallLog);

router.get('/demos', salesController.listDemos);
router.post('/demos', requireModule('SALES', 'EDIT'), salesController.createDemo);
router.put('/demos/:id', requireModule('SALES', 'EDIT'), salesController.updateDemo);
router.post('/demos/:id/reschedule', requireModule('SALES', 'EDIT'), salesController.rescheduleDemo);

router.get('/pulse', salesController.pulse);

// Report recipients — who gets the Sales Pulse / EOD emails (11,12,1,2,4,5,6).
router.get('/report-recipients', salesController.listReportRecipients);
router.post('/report-recipients', requireModule('SALES', 'EDIT'), salesController.addReportRecipient);
router.delete('/report-recipients/:id', requireModule('SALES', 'EDIT'), salesController.removeReportRecipient);

export default router;
