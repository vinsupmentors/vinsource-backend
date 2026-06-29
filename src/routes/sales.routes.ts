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
router.put('/leads/:id', requireModule('SALES', 'EDIT'), salesController.updateLead);
router.delete('/leads/:id', requireModule('SALES', 'ADMIN'), salesController.deleteLead);

router.get('/demos', salesController.listDemos);
router.post('/demos', requireModule('SALES', 'EDIT'), salesController.createDemo);
router.put('/demos/:id', requireModule('SALES', 'EDIT'), salesController.updateDemo);

export default router;
