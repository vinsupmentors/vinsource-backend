import { Router } from 'express';
import { reportSheetsController } from '../controllers/reportSheets.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';

const router = Router();
router.use(authenticate);
router.use(requireModule('REPORT_SHEETS', 'VIEW'));

router.get('/live/:key', reportSheetsController.live);
router.put('/live-targets', requireModule('REPORT_SHEETS', 'ADMIN'), reportSheetsController.setTarget);
router.get('/books', reportSheetsController.listBooks);
router.get('/books/:id', reportSheetsController.getBook);
router.post('/books', requireModule('REPORT_SHEETS', 'ADMIN'), reportSheetsController.createBook);
router.put('/books/:id', requireModule('REPORT_SHEETS', 'ADMIN'), reportSheetsController.renameBook);
router.post('/books/:id/sheets', requireModule('REPORT_SHEETS', 'EDIT'), reportSheetsController.addSheet);
router.put('/sheets/:id', requireModule('REPORT_SHEETS', 'EDIT'), reportSheetsController.renameSheet);
router.delete('/sheets/:id', requireModule('REPORT_SHEETS', 'ADMIN'), reportSheetsController.deleteSheet);
router.patch('/sheets/:id/cells', requireModule('REPORT_SHEETS', 'EDIT'), reportSheetsController.saveCells);

export default router;
