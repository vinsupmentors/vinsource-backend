import { Router } from 'express';
import { salesController } from '../controllers/sales.controller';
import { callTrackingController } from '../controllers/callTracking.controller';
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

// Global call log — every call across all leads for a day (or full history
// for a searched number), like a phone's own call log. VIEW-level like the
// rest of this router; self-scoped to the caller's own calls inside the
// controller for anyone below SALES=ADMIN.
router.get('/call-log', salesController.listCallLog);

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

// SIM call-tracking — device enrollment is ADMIN-only (issues a secret
// token); the unmatched-call review queue is regular EDIT access, same level
// as logging a call manually. The actual call-event ingestion from the phone
// itself lives in callTracking.routes.ts under /api/call-tracking, since it
// authenticates via device token instead of an employee login.
router.get('/devices', requireModule('SALES', 'ADMIN'), callTrackingController.listDevices);
router.post('/devices', requireModule('SALES', 'ADMIN'), callTrackingController.registerDevice);
router.put('/devices/:id/deactivate', requireModule('SALES', 'ADMIN'), callTrackingController.deactivateDevice);

router.get('/unmatched-calls', requireModule('SALES', 'EDIT'), callTrackingController.listUnmatchedCalls);
router.post('/unmatched-calls/:id/link', requireModule('SALES', 'EDIT'), callTrackingController.linkUnmatchedCall);
router.post('/unmatched-calls/:id/create-lead', requireModule('SALES', 'EDIT'), callTrackingController.createLeadFromUnmatchedCall);

export default router;
