import { Router } from 'express';
import { financeSalesController } from '../controllers/financeSales.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';

const router = Router();
router.use(authenticate);
router.use(requireModule('FINANCE_SALES', 'VIEW'));

router.get('/stats', financeSalesController.stats);
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
router.post('/installments/:id/approve', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.approveInstallment);

router.get('/', financeSalesController.list);
router.post('/', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.create);
router.put('/:id', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.update);
router.delete('/:id', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.remove);

export default router;
