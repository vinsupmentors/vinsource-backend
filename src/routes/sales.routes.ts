import { salesTeamsController } from '../controllers/salesTeams.controller';
import { demoFeedbackController } from '../controllers/demoFeedback.controller';
import { Router } from 'express';
import { salesController } from '../controllers/sales.controller';
import { callTrackingController } from '../controllers/callTracking.controller';
import { salesDemoRoomController } from '../controllers/salesDemoRoom.controller';
import { salesWorkController } from '../controllers/salesWork.controller';
import { myBaseController } from '../controllers/myBase.controller';
import { leadDuplicatesController } from '../controllers/leadDuplicates.controller';
import { salesAlertsController } from '../controllers/salesAlerts.controller';
import { salesToolsController } from '../controllers/salesTools.controller';
import { leadConfigController } from '../controllers/leadConfig.controller';
import { salesDashboardController } from '../controllers/salesDashboard.controller';
import { salesOnboardingController } from '../controllers/salesOnboarding.controller';
import { transcriptsController } from '../controllers/transcripts.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import { uploadDemoProof, uploadPaymentProof } from '../middleware/upload';

const router = Router();
router.use(authenticate);
router.use(requireModule('SALES', 'VIEW'));

router.get('/stats', salesController.stats);
router.get('/dashboard', salesDashboardController.get);
router.get('/collections', salesDashboardController.collections);
router.get('/leads/:id/fees', salesDashboardController.leadFees);
router.get('/leads/:id/onboarding', salesOnboardingController.get);
router.post('/leads/:id/onboarding', requireModule('SALES', 'EDIT'), uploadPaymentProof, salesOnboardingController.onboard);
router.post('/leads/:id/payments', requireModule('SALES', 'EDIT'), uploadPaymentProof, salesOnboardingController.recordPayment);
router.delete('/leads/:id/onboarding', requireModule('SALES', 'ADMIN'), salesOnboardingController.undo);
router.put('/leads/:id/total-fee', requireModule('SALES', 'EDIT'), salesOnboardingController.setTotalFee);
router.get('/course-fees', salesOnboardingController.listCourseFees);
router.put('/course-fees', requireModule('SALES', 'ADMIN'), salesOnboardingController.saveCourseFee);
router.delete('/course-fees/:id', requireModule('SALES', 'ADMIN'), salesOnboardingController.deleteCourseFee);
router.get('/emi/quote', salesOnboardingController.emiQuote);
router.post('/installments/:id/pay', requireModule('SALES', 'EDIT'), uploadPaymentProof, salesOnboardingController.payInstallment);
router.get('/payment-proofs/:id', salesOnboardingController.proof);
router.get('/team', salesController.listTeam);
router.get('/team-map', requireModule('SALES', 'ADMIN'), salesTeamsController.list);
router.put('/team-map', requireModule('SALES', 'ADMIN'), salesTeamsController.set);

router.get('/leads', salesController.listLeads);
router.post('/leads', requireModule('SALES', 'EDIT'), salesController.createLead);
router.post('/leads/bulk', requireModule('SALES', 'EDIT'), salesController.bulkUploadLeads);
router.get('/leads/:id', salesController.getLead);
router.put('/leads/:id', requireModule('SALES', 'EDIT'), salesController.updateLead);
router.delete('/leads/:id', requireModule('SALES', 'ADMIN'), salesController.deleteLead);

router.get('/courses', salesController.courses);
router.get('/leads/:id/history', salesController.leadHistory);
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
router.post('/demos/:id/feedback/release', requireModule('SALES', 'EDIT'), demoFeedbackController.release);
router.post('/demos/:id/reschedule', requireModule('SALES', 'EDIT'), salesController.rescheduleDemo);

// Tasks / reminders (self-scoped inside the controller; Sales Admin can assign + see all).
router.get('/reminders', salesWorkController.reminders);
router.get('/leads/:id/notes', salesWorkController.listNotes);
router.post('/leads/:id/notes', requireModule('SALES', 'EDIT'), salesWorkController.addNote);
router.get('/tasks', salesWorkController.listTasks);
router.post('/tasks', requireModule('SALES', 'EDIT'), salesWorkController.createTask);
router.put('/tasks/:id', requireModule('SALES', 'EDIT'), salesWorkController.updateTask);
router.get('/sources', salesWorkController.sources);

// Summaries + activity monitor — Sales Admin.
router.get('/insights/assignment', requireModule('SALES', 'ADMIN'), salesWorkController.assignmentSummary);
router.get('/insights/stages', requireModule('SALES', 'ADMIN'), salesWorkController.stageSummary);
router.get('/insights/sources', requireModule('SALES', 'ADMIN'), salesWorkController.sourceSummary);
// Config lists (stages, update statuses, lost reasons, sources, lead scouts) — everyone reads, Sales Admin edits.
router.get('/config', leadConfigController.get);
router.post('/config/:kind', requireModule('SALES', 'ADMIN'), leadConfigController.save);
router.put('/config/:kind/:id', requireModule('SALES', 'ADMIN'), leadConfigController.save);
router.delete('/config/:kind/:id', requireModule('SALES', 'ADMIN'), leadConfigController.remove);

// Transcripts of calls + online demos (free Whisper). Self-scoped inside the controller; Sales Admin sees all.
router.get('/transcripts/status', transcriptsController.status);
router.get('/transcripts', transcriptsController.list);
router.get('/transcripts/:type/:id', transcriptsController.getOne);
router.post('/transcripts/:type/:id/run', requireModule('SALES', 'EDIT'), transcriptsController.run);

// Today view, call analytics, message templates (self-scoped inside the controller; Sales Admin sees all).
router.get('/today', salesToolsController.today);
router.get('/call-analytics', salesToolsController.callAnalytics);
router.get('/message-templates', salesToolsController.listTemplates);
router.post('/message-templates', requireModule('SALES', 'ADMIN'), salesToolsController.saveTemplate);
router.put('/message-templates/:id', requireModule('SALES', 'ADMIN'), salesToolsController.saveTemplate);
router.delete('/message-templates/:id', requireModule('SALES', 'ADMIN'), salesToolsController.deleteTemplate);
router.get('/leads/:id/message-preview', salesToolsController.previewMessage);
router.post('/leads/:id/message', requireModule('SALES', 'EDIT'), salesToolsController.sendMessage);
router.get('/target-alerts', requireModule('SALES', 'ADMIN'), salesToolsController.targetConfig);
router.put('/target-alerts', requireModule('SALES', 'ADMIN'), salesToolsController.saveTargetConfig);
router.post('/target-alerts/send-now', requireModule('SALES', 'ADMIN'), salesToolsController.sendTargetAlertsNow);
router.get('/mybase/batches', requireModule('SALES', 'ADMIN'), myBaseController.batches);
router.get('/duplicates', requireModule('SALES', 'ADMIN'), leadDuplicatesController.list);
router.post('/duplicates/merge', requireModule('SALES', 'ADMIN'), leadDuplicatesController.merge);
router.post('/duplicates/dismiss', requireModule('SALES', 'ADMIN'), leadDuplicatesController.dismiss);
router.get('/alert-rules', requireModule('SALES', 'ADMIN'), salesAlertsController.list);
router.post('/alert-rules', requireModule('SALES', 'ADMIN'), salesAlertsController.create);
router.put('/alert-rules/:id', requireModule('SALES', 'ADMIN'), salesAlertsController.update);
router.delete('/alert-rules/:id', requireModule('SALES', 'ADMIN'), salesAlertsController.remove);
router.get('/alert-rules/:id/preview', requireModule('SALES', 'ADMIN'), salesAlertsController.preview);
router.post('/alert-rules/:id/send-now', requireModule('SALES', 'ADMIN'), salesAlertsController.sendNow);
router.get('/mybase/pool', requireModule('SALES', 'ADMIN'), myBaseController.pool);
router.get('/mybase/summary', requireModule('SALES', 'ADMIN'), myBaseController.summary);
router.post('/mybase/count', requireModule('SALES', 'ADMIN'), myBaseController.count);
router.post('/mybase/assign', requireModule('SALES', 'ADMIN'), myBaseController.assign);
router.post('/mybase/pull', requireModule('SALES', 'ADMIN'), myBaseController.pull);
router.get('/insights/report', requireModule('SALES', 'ADMIN'), salesWorkController.salesReport);
router.get('/activity-feed', requireModule('SALES', 'ADMIN'), salesWorkController.activityFeed);

// Portal-hosted online demo room — BDA hosts, Sales Admin observes / approves reopen.
router.get('/demo-rooms', requireModule('SALES', 'ADMIN'), salesDemoRoomController.board);
router.post('/demos/:id/room/host', requireModule('SALES', 'EDIT'), salesDemoRoomController.host);
router.post('/demos/:id/room/end', requireModule('SALES', 'EDIT'), salesDemoRoomController.end);
router.post('/demos/:id/room/observe', requireModule('SALES', 'ADMIN'), salesDemoRoomController.observe);
router.post('/demos/:id/room/reopen-request', requireModule('SALES', 'EDIT'), salesDemoRoomController.requestReopen);
router.post('/demos/:id/room/reopen', requireModule('SALES', 'ADMIN'), salesDemoRoomController.decideReopen);

// Sales Pulse / Lead Quality are management-level views (aggregate numbers
// across every rep) — restricted to SALES ADMIN. BDAs get their own
// assigned-leads-only Leads tab plus the Demo Booked/Rescheduled/Conducted
// views instead (see listLeads/listDemos self-scoping in the controller).
router.get('/pulse', requireModule('SALES', 'ADMIN'), salesController.pulse);
router.get('/lead-quality', requireModule('SALES', 'ADMIN'), salesController.leadQuality);

// Leaderboard + Targets — per-salesperson KPI breakdown and the monthly
// goals set against them, both management-level views like Pulse above.
router.get('/leaderboard', requireModule('SALES', 'ADMIN'), salesController.leaderboard);
router.get('/targets', requireModule('SALES', 'ADMIN'), salesController.listTargets);
router.post('/targets', requireModule('SALES', 'ADMIN'), salesController.setTarget);

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

router.get('/missing-recordings', requireModule('SALES', 'ADMIN'), callTrackingController.missingRecordings);
router.get('/unmatched-calls', requireModule('SALES', 'EDIT'), callTrackingController.listUnmatchedCalls);
router.post('/unmatched-calls/:id/link', requireModule('SALES', 'EDIT'), callTrackingController.linkUnmatchedCall);
router.post('/unmatched-calls/:id/create-lead', requireModule('SALES', 'EDIT'), callTrackingController.createLeadFromUnmatchedCall);

// My Students — students linked to the caller as Skill Advisor at intake
// (see Student.skillAdvisorId). VIEW-level like the rest of this router;
// self-scoped inside the controller for anyone below SALES=ADMIN. The
// cross-rep "advised-students" overview is ADMIN-only, same treatment as
// Pulse/Leaderboard above.
router.get('/my-students', salesController.myStudents);
router.get('/my-students/:id', salesController.myStudentDetail);
router.get('/advised-students', requireModule('SALES', 'ADMIN'), salesController.advisedStudents);

export default router;
