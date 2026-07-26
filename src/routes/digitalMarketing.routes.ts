import { Router } from 'express';
import { digitalMarketingController } from '../controllers/digitalMarketing.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';
import { uploadCampaignBill, uploadCampaignDashboard, uploadCampaignClosure } from '../middleware/upload';

const router = Router();
router.use(authenticate);
router.use(requireModule('DIGITAL_MARKETING', 'VIEW'));

router.get('/stats', digitalMarketingController.stats);

// Cross-campaign ledgers — power the sidebar's Recharges / Daily Reports tabs
router.get('/recharges', digitalMarketingController.listAllRecharges);
router.get('/daily-reports', digitalMarketingController.listAllDailyReports);

router.get('/campaigns', digitalMarketingController.listCampaigns);
router.get('/campaigns/:id', digitalMarketingController.getCampaign);
router.post(
  '/campaigns',
  requireModule('DIGITAL_MARKETING', 'EDIT'),
  uploadCampaignBill,
  digitalMarketingController.createCampaign
);
router.put('/campaigns/:id', requireModule('DIGITAL_MARKETING', 'EDIT'), digitalMarketingController.updateCampaign);
router.delete('/campaigns/:id', requireModule('DIGITAL_MARKETING', 'ADMIN'), digitalMarketingController.remove);

// Recharges — every funding event (initial or top-up) requires its own bill copy
router.get('/campaigns/:id/recharges', digitalMarketingController.listRecharges);
router.post(
  '/campaigns/:id/recharges',
  requireModule('DIGITAL_MARKETING', 'EDIT'),
  uploadCampaignBill,
  digitalMarketingController.addRecharge
);

// Daily reports — leads funnel + spend + optional ad-platform dashboard screenshot
router.get('/campaigns/:id/daily-reports', digitalMarketingController.listDailyReports);
router.post(
  '/campaigns/:id/daily-reports',
  requireModule('DIGITAL_MARKETING', 'EDIT'),
  uploadCampaignDashboard,
  digitalMarketingController.upsertDailyReport
);

// Closure — overall rollup + mandatory expense sheet + ad-platform dashboard export
router.post(
  '/campaigns/:id/close',
  requireModule('DIGITAL_MARKETING', 'EDIT'),
  uploadCampaignClosure,
  digitalMarketingController.closeCampaign
);

export default router;
