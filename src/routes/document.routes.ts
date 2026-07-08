import { Router, Request, Response, NextFunction } from 'express';
import { documentController } from '../controllers/document.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';
import { uploadDocument } from '../middleware/upload';
import { getEffectiveAccess } from '../utils/moduleAccess';
import { AuthRequest } from '../types';

const router = Router();
router.use(authenticate);

/**
 * Allows either a user with HR role (or above) OR a user who has been granted
 * the HR module via UserModuleAccess (e.g. a designated document reviewer like Yureka).
 * minLevel controls whether VIEW or EDIT access is required for the module path.
 */
const LEVEL_RANK: Record<string, number> = { NONE: 0, VIEW: 1, EDIT: 2, ADMIN: 3 };
const ROLE_RANK: Record<string, number> = { STUDENT: 0, EMPLOYEE: 1, MANAGER: 2, HR: 3, ADMIN: 4, SUPER_ADMIN: 5 };

function requireHROrModule(minLevel: 'VIEW' | 'EDIT' = 'VIEW') {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const user = (req as AuthRequest).user;
    if (!user) { res.status(401).json({ success: false, message: 'Unauthorized' }); return; }
    // HR role or above -> pass
    if ((ROLE_RANK[user.role] || 0) >= ROLE_RANK['HR']) { next(); return; }
    // Otherwise check HR module access
    try {
      const access = await getEffectiveAccess(user.userId);
      const level = access['HR'];
      if (level && LEVEL_RANK[level] >= LEVEL_RANK[minLevel]) { next(); return; }
    } catch { /* fall through to 403 */ }
    res.status(403).json({ success: false, message: 'Insufficient permissions' });
  };
}

// Employee: view and upload their own documents
router.get('/my', documentController.list);
router.post('/upload', uploadDocument, documentController.upload);
router.delete('/:id', documentController.delete);

// HR: view all employees' documents, mark original submitted, verify
// requireHROrModule allows the HR role OR HR module access (e.g. Yureka as doc reviewer)
router.get('/all', requireHROrModule('VIEW'), documentController.listForHR);
router.get('/originals-summary', requireHROrModule('VIEW'), documentController.originalsSummary);
router.post('/collect-originals', requireMinRole('HR'), documentController.collectOriginalsAtJoining);
router.get('/employee/:employeeId', requireHROrModule('VIEW'), documentController.list);
router.put('/:id/mark-original', requireMinRole('HR'), documentController.markOriginal);
router.put('/:id/verify', requireHROrModule('EDIT'), documentController.verify);

export default router;
