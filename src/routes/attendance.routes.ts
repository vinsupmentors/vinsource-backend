import { Router } from 'express';
import { attendanceController } from '../controllers/attendance.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

const router = Router();
router.use(authenticate);

router.post('/check-in', attendanceController.checkIn);
router.post('/check-out', attendanceController.checkOut);
router.get('/today', attendanceController.today);
router.get('/history', attendanceController.history);
router.get('/summary', attendanceController.summary);
router.post('/regularize', attendanceController.regularize);
router.get('/team', requireMinRole('MANAGER'), attendanceController.teamAttendance);
router.get('/team-today-logs', requireMinRole('MANAGER'), attendanceController.teamTodayLogs);
router.get('/wfh-pending', requireMinRole('MANAGER'), attendanceController.pendingWfh);
router.put('/:id/approve-wfh', requireMinRole('MANAGER'), attendanceController.approveWfh);

export default router;
