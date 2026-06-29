import { Router } from 'express';
import { orgController } from '../controllers/org.controller';
import { authenticate } from '../middleware/auth';
import { requireMinRole } from '../middleware/rbac';

// ── Standalone routers mounted at /api/departments, /api/designations, /api/branches ──
export function buildDepartmentRouter() {
  const r = Router();
  r.use(authenticate);
  r.get('/', orgController.departments);
  r.post('/', requireMinRole('HR'), orgController.createDepartment);
  r.put('/:id', requireMinRole('HR'), orgController.updateDepartment);
  r.delete('/:id', requireMinRole('HR'), orgController.deleteDepartment);
  return r;
}

export function buildDesignationRouter() {
  const r = Router();
  r.use(authenticate);
  r.get('/', orgController.designations);
  r.post('/', requireMinRole('HR'), orgController.createDesignation);
  r.put('/:id', requireMinRole('HR'), orgController.updateDesignation);
  r.delete('/:id', requireMinRole('HR'), orgController.deleteDesignation);
  return r;
}

export function buildBranchRouter() {
  const r = Router();
  r.use(authenticate);
  r.get('/', orgController.branches);
  return r;
}

// ── /api/org catch-all ──
const orgRouter = Router();
orgRouter.use(authenticate);
orgRouter.get('/departments', orgController.departments);
orgRouter.post('/departments', requireMinRole('HR'), orgController.createDepartment);
orgRouter.put('/departments/:id', requireMinRole('HR'), orgController.updateDepartment);
orgRouter.delete('/departments/:id', requireMinRole('HR'), orgController.deleteDepartment);
orgRouter.get('/designations', orgController.designations);
orgRouter.post('/designations', requireMinRole('HR'), orgController.createDesignation);
orgRouter.put('/designations/:id', requireMinRole('HR'), orgController.updateDesignation);
orgRouter.delete('/designations/:id', requireMinRole('HR'), orgController.deleteDesignation);
orgRouter.get('/branches', orgController.branches);
orgRouter.get('/managers', orgController.managers);
orgRouter.get('/chart', orgController.chart);

export default orgRouter;
