import { Router } from 'express';
import { admissionController } from '../controllers/admission.controller';
import { authenticate } from '../middleware/auth';
import { requireModule } from '../middleware/rbac';

const router = Router();
router.use(authenticate);
router.use(requireModule('ADMISSION', 'VIEW'));

// Courses (for the New Admission course/track picker)
router.get('/courses', admissionController.listCourses);

// Employees (for the employee-restricted coupon picker) — admin only, same as coupons
router.get('/employees/search', requireModule('ADMISSION', 'ADMIN'), admissionController.searchEmployees);

// Batch Plan — Course x (Offline/Online x timing-slot) seat matrix
router.get('/batch-plan', admissionController.getBatchPlan);

// Live fee calculator — used by every screen (New Admission, Edit, Payment,
// EMI, Reports) so the number shown is always the same one the backend will
// actually charge.
router.post('/calculate-fee', admissionController.calculateFeeEndpoint);

// Upcoming batches / seat availability — visible to anyone with Admission
// access (Sales reps need this to pick a batch); creating a batch is admin-only.
router.get('/batches/upcoming', admissionController.listUpcomingBatches);
router.get('/batches/:scheduleId/seats', admissionController.seatAvailability);
router.get('/batches/groups', requireModule('ADMISSION', 'ADMIN'), admissionController.listBatchGroups);
router.post('/batches', requireModule('ADMISSION', 'ADMIN'), admissionController.createBatchSchedule);

// Seat hold-back — admin withholds genuine seats from bookable inventory
// (e.g. for an anticipated college enrollment); reps request release, admin
// approves/rejects. The hold is enforced in the booking transaction itself,
// not just shown differently.
router.put('/batches/:scheduleId/hold', requireModule('ADMISSION', 'ADMIN'), admissionController.setHeldSeatsEndpoint);
router.get('/seat-requests', admissionController.listSeatHoldRequests);
router.post('/seat-requests', requireModule('ADMISSION', 'EDIT'), admissionController.createSeatHoldRequest);
router.post('/seat-requests/:id/approve', requireModule('ADMISSION', 'ADMIN'), admissionController.approveSeatHoldRequestEndpoint);
router.post('/seat-requests/:id/reject', requireModule('ADMISSION', 'ADMIN'), admissionController.rejectSeatHoldRequestEndpoint);

// Coupons — admin only (both viewing and managing). Reps only ever see a
// coupon's effect through /coupons/validate while building an admission,
// never the underlying list.
router.get('/coupons', requireModule('ADMISSION', 'ADMIN'), admissionController.listCoupons);
router.get('/coupons/validate', admissionController.validateCouponEndpoint);
router.post('/coupons', requireModule('ADMISSION', 'ADMIN'), admissionController.createCoupon);
router.put('/coupons/:id', requireModule('ADMISSION', 'ADMIN'), admissionController.updateCoupon);

// Course fee configuration — admin only
router.get('/course-fees', requireModule('ADMISSION', 'ADMIN'), admissionController.listCourseFees);
router.post('/course-fees', requireModule('ADMISSION', 'ADMIN'), admissionController.createCourseFee);
router.delete('/course-fees/:id', requireModule('ADMISSION', 'ADMIN'), admissionController.deactivateCourseFee);

// Admission config (rates, discounts, EMI limits, foreclosure policy) — admin only
router.get('/config', requireModule('ADMISSION', 'ADMIN'), admissionController.getConfig);
router.put('/config', requireModule('ADMISSION', 'ADMIN'), admissionController.updateConfig);

// Admissions — list/detail are open to any Admission access, but the
// controller itself pins non-admin callers to only their own records
// (defense in depth, not just a UI filter).
router.get('/', admissionController.listAdmissions);
router.post('/', requireModule('ADMISSION', 'EDIT'), admissionController.createAdmission);
router.get('/:id', admissionController.getAdmission);

export default router;
