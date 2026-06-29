import { Router } from 'express';
import { helpdeskController } from '../controllers/helpdesk.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

router.post('/', helpdeskController.create);
router.get('/my', helpdeskController.myTickets);
router.get('/', requireMinRole('MANAGER'), helpdeskController.listAll);
router.get('/:id', helpdeskController.get);
router.post('/:id/comments', helpdeskController.addComment);
router.put('/:id', requireMinRole('MANAGER'), helpdeskController.update);

export default router;
