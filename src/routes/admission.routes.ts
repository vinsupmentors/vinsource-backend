import { Router } from 'express';
import { admissionController } from '../controllers/admission.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';

const router = Router();
router.use(authenticate);
router.use(requireModule('ADMISSION', 'VIEW'));

// Courses (for the New Admission course/track picker)
router.get('/courses', admissionController.listCourses);

// Live fee calculator — used by every screen (New Admission, Edit, Payment,
// EMI, Reports) so the number shown is always the same one the backend will
// actually charge.
router.post('/calculate-fee', admissionController.calculateFeeEndpoint);

// Upcoming batches / seat availability
router.get('/batches/upcoming', admissionController.listUpcomingBatches);
router.get('/batches/:scheduleId/seats', admissionController.seatAvailability);

// Coupons
router.get('/coupons', admissionController.listCoupons);
router.get('/coupons/validate', admissionController.validateCouponEndpoint);
router.post('/coupons', requireModule('ADMISSION', 'EDIT'), admissionController.createCoupon);
router.put('/coupons/:id', requireModule('ADMISSION', 'EDIT'), admissionController.updateCoupon);

// Course fee configuration
router.get('/course-fees', admissionController.listCourseFees);
router.post('/course-fees', requireModule('ADMISSION', 'ADMIN'), admissionController.createCourseFee);
router.delete('/course-fees/:id', requireModule('ADMISSION', 'ADMIN'), admissionController.deactivateCourseFee);

// Admission config (rates, discounts, EMI limits, foreclosure policy)
router.get('/config', admissionController.getConfig);
router.put('/config', requireModule('ADMISSION', 'ADMIN'), admissionController.updateConfig);

// Admissions
router.get('/', admissionController.listAdmissions);
router.post('/', requireModule('ADMISSION', 'EDIT'), admissionController.createAdmission);
router.get('/:id', admissionController.getAdmission);

export default router;
