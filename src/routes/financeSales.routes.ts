import { Router } from 'express';
import { financeSalesController } from '../controllers/financeSales.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';

const router = Router();
router.use(authenticate);
router.use(requireModule('FINANCE_SALES', 'VIEW'));

router.get('/stats', financeSalesController.stats);
router.get('/dashboard', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.dashboard);
router.get('/leads-search', financeSalesController.searchLeads);

router.get('/plans', financeSalesController.listPlans);
router.get('/plans/:id', financeSalesController.planDetail);
router.post('/plans', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.createPlan);
router.put('/plans/:id', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.updatePlan);
router.post('/plans/:id/cancel', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.cancelPlan);
router.post('/plans/:id/installments', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.addInstallment);

router.put('/installments/:id', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.updateInstallment);
router.delete('/installments/:id', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.removeInstallment);
router.post('/installments/:id/collect', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.collectInstallment);

// Admin approval queue — confirms money was actually received before it
// hits the ledger and the receipt goes out.
router.get('/approvals', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.listApprovals);
router.get('/approval-history', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.listApprovalHistory);
router.post('/installments/:id/approve', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.approveInstallment);

// Refund — Sales requests, Admin does the transfer and completes it.
router.post('/plans/:id/refund', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.requestRefund);
router.get('/refund-requests', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.listRefundRequests);
router.get('/refund-history', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.listRefundHistory);
router.post('/plans/:id/refund/complete', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.completeRefund);
router.post('/plans/:id/refund/reject', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.rejectRefund);

// Delete — Sales requests, only Admin-level access can approve the actual delete.
router.post('/plans/:id/delete-request', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.requestDeletePlan);
router.get('/deletion-requests', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.listDeletionRequests);
router.get('/deletion-log', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.listDeletionLog);
router.post('/plans/:id/delete-request/approve', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.approveDeletePlan);
router.post('/plans/:id/delete-request/reject', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.rejectDeletePlan);

router.get('/', financeSalesController.list);
router.post('/', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.create);
router.put('/:id', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.update);
router.delete('/:id', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.remove);

export default router;
