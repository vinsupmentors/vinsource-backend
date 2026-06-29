import { Router } from 'express';
import { financeSalesController } from '../controllers/financeSales.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';

const router = Router();
router.use(authenticate);
router.use(requireModule('FINANCE_SALES', 'VIEW'));

router.get('/stats', financeSalesController.stats);
router.get('/', financeSalesController.list);
router.post('/', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.create);
router.put('/:id', requireModule('FINANCE_SALES', 'EDIT'), financeSalesController.update);
router.delete('/:id', requireModule('FINANCE_SALES', 'ADMIN'), financeSalesController.remove);

export default router;
