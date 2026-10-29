import { Router } from 'express';
import { salesOnboardingController } from '../controllers/salesOnboarding.controller';
import { reportSheetsController } from '../controllers/reportSheets.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';

const router = Router();
router.use(authenticate);
router.use(requireModule('REPORT_SHEETS', 'VIEW'));

router.get('/live/:key', reportSheetsController.live);
router.put('/live-targets', requireModule('REPORT_SHEETS', 'ADMIN'), reportSheetsController.setTarget);
router.post('/loan', requireModule('REPORT_SHEETS', 'EDIT'), reportSheetsController.addLoan);
router.put('/loan/:id/verify', requireModule('REPORT_SHEETS', 'ADMIN'), reportSheetsController.verifyLoan);
router.delete('/loan/:id', requireModule('REPORT_SHEETS', 'ADMIN'), reportSheetsController.deleteLoan);
router.patch('/demo/:id', requireModule('REPORT_SHEETS', 'EDIT'), reportSheetsController.editDemo);
router.patch('/loan/:id', requireModule('REPORT_SHEETS', 'EDIT'), reportSheetsController.editLoan);
router.post('/jodo/import', requireModule('REPORT_SHEETS', 'EDIT'), reportSheetsController.importJodo);
router.get('/proof/:id', salesOnboardingController.proof);
router.get('/books', reportSheetsController.listBooks);
router.get('/books/:id', reportSheetsController.getBook);
router.post('/books', requireModule('REPORT_SHEETS', 'ADMIN'), reportSheetsController.createBook);
router.put('/books/:id', requireModule('REPORT_SHEETS', 'ADMIN'), reportSheetsController.renameBook);
router.post('/books/:id/sheets', requireModule('REPORT_SHEETS', 'EDIT'), reportSheetsController.addSheet);
router.put('/sheets/:id', requireModule('REPORT_SHEETS', 'EDIT'), reportSheetsController.renameSheet);
router.delete('/sheets/:id', requireModule('REPORT_SHEETS', 'ADMIN'), reportSheetsController.deleteSheet);
router.patch('/sheets/:id/cells', requireModule('REPORT_SHEETS', 'EDIT'), reportSheetsController.saveCells);

export default router;
