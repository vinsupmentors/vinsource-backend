import { Router } from 'express';
import { calendarController } from '../controllers/calendar.controller';
import { authenticate } from '../middleware/auth';

// No requireModule gate, unlike most other route files — the Calendar is
// deliberately not a permission-gated module (per the product decision:
// "New standalone Calendar nav item", visible to admin/trainers/students
// alike). Every user who can log in gets a calendar; calendarController's
// own selfScheduleScope()/isAdmin logic is what actually limits which
// events they see, the same split of responsibility Live Classes uses for
// its own identity-scoped (non-module-gated) endpoints like join/leave.
const router = Router();
router.use(authenticate);

router.get('/', calendarController.list);

export default router;
