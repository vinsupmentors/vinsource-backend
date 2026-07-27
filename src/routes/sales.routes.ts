import { Router } from 'express';
import { salesController } from '../controllers/sales.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import { uploadDemoProof } from '../middleware/upload';

const router = Router();
router.use(authenticate);
router.use(requireModule('SALES', 'VIEW'));

router.get('/stats', salesController.stats);
router.get('/team', salesController.listTeam);

router.get('/leads', salesController.listLeads);
router.post('/leads', requireModule('SALES', 'EDIT'), salesController.createLead);
router.post('/leads/bulk', requireModule('SALES', 'EDIT'), salesController.bulkUploadLeads);
router.get('/leads/:id', salesController.getLead);
router.put('/leads/:id', requireModule('SALES', 'EDIT'), salesController.updateLead);
router.delete('/leads/:id', requireModule('SALES', 'ADMIN'), salesController.deleteLead);

router.get('/leads/:id/calls', salesController.listCallLogs);
router.post('/leads/:id/calls', requireModule('SALES', 'EDIT'), salesController.addCallLog);

router.get('/demos', salesController.listDemos);
router.post('/demos', requireModule('SALES', 'EDIT'), salesController.createDemo);
// uploadDemoProof parses multipart bodies (Mark Conducted attaches a proof
// photo); No Show/Cancel/reschedule-adjacent edits go through the same route
// as a multipart request too, just without a file — multer passes those
// through untouched.
router.put('/demos/:id', requireModule('SALES', 'EDIT'), uploadDemoProof, salesController.updateDemo);
router.post('/demos/:id/reschedule', requireModule('SALES', 'EDIT'), salesController.rescheduleDemo);

// Sales Pulse / Lead Quality are management-level views (aggregate numbers
// across every rep) — restricted to SALES ADMIN. BDAs get their own
// assigned-leads-only Leads tab plus the Demo Booked/Rescheduled/Conducted
// views instead (see listLeads/listDemos self-scoping in the controller).
router.get('/pulse', requireModule('SALES', 'ADMIN'), salesController.pulse);
router.get('/lead-quality', requireModule('SALES', 'ADMIN'), salesController.leadQuality);

// Report recipients — who gets the Sales Pulse / EOD emails (11,12,1,2,4,5,6).
router.get('/report-recipients', requireModule('SALES', 'ADMIN'), salesController.listReportRecipients);
router.post('/report-recipients', requireModule('SALES', 'ADMIN'), salesController.addReportRecipient);
router.delete('/report-recipients/:id', requireModule('SALES', 'ADMIN'), salesController.removeReportRecipient);

export default router;
