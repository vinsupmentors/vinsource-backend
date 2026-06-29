import { Router } from 'express';
import { financeAdminController } from '../controllers/financeAdmin.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import { uploadExpenseAttachments } from '../middleware/upload';

const router = Router();
router.use(authenticate);
router.use(requireModule('FINANCE_ADMIN', 'VIEW'));

// Expense register — list/stats are scoped per-spender inside the controller
// (a regular spender only ever sees their own entries; ADMIN-level / SUPER_ADMIN see all).
// create/update accept multipart form data for the bill-copy/payment-proof attachments.
router.get('/stats', financeAdminController.stats);
router.get('/report', financeAdminController.report);
router.get('/', financeAdminController.list);
router.post('/', requireModule('FINANCE_ADMIN', 'EDIT'), uploadExpenseAttachments, financeAdminController.create);
router.put('/:id', requireModule('FINANCE_ADMIN', 'EDIT'), uploadExpenseAttachments, financeAdminController.update);
router.put('/:id/status', requireModule('FINANCE_ADMIN', 'EDIT'), financeAdminController.updateStatus);
router.delete('/:id', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.remove);

// Company-wide HO ledger / balance reconciliation — ADMIN-level only.
router.get('/ledger', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.ledger);
router.get('/category-summary', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.categorySummary);

// HO fund receipts (credits) — viewing/recording HO funding is ADMIN-level only.
router.get('/funds', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.listFunds);
router.post('/funds', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.createFund);
router.delete('/funds/:id', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.removeFund);

// Vendors — list is VIEW-level (every spender can pick a vendor on their own
// expense); managing the vendor master is ADMIN-level only.
router.get('/vendors/summary', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.vendorSummary);
router.get('/vendors', financeAdminController.listVendors);
router.post('/vendors', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.createVendor);
router.put('/vendors/:id', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.updateVendor);
router.delete('/vendors/:id', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.removeVendor);

// Recurring expense templates (fixed monthly costs) — ADMIN-level only.
router.get('/recurring', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.listRecurring);
router.post('/recurring', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.createRecurring);
router.put('/recurring/:id', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.updateRecurring);
router.delete('/recurring/:id', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.removeRecurring);
router.post('/recurring/generate', requireModule('FINANCE_ADMIN', 'ADMIN'), financeAdminController.generateRecurring);

export default router;
