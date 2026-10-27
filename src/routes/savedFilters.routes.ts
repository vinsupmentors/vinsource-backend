import { Router, Response, NextFunction } from 'express';
import prisma from '../config/database';
import { authenticate } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { getEffectiveAccess } from '../utils/moduleAccess';

// Saved advanced filters. Identity-scoped (like demoSessions.routes.ts): every
// handler checks ownership itself. A filter is private to its owner; an admin
// (ADMIN / SUPER_ADMIN, or ADMIN level on any module) may share it with everyone.
const router = Router();
router.use(authenticate);

const SCOPES = ['leads', 'callLog', 'activity', 'comfort', 'mybase'];

async function canShare(req: AuthRequest): Promise<boolean> {
  if (req.user!.role === 'SUPER_ADMIN' || req.user!.role === 'ADMIN') return true;
  const access = await getEffectiveAccess(req.user!.userId);
  return Object.values(access).includes('ADMIN');
}

router.get('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const scope = String(req.query.scope || '');
    if (!SCOPES.includes(scope)) throw new AppError('Unknown filter scope', 400);
    const rows = await prisma.savedFilter.findMany({
      where: { scope, OR: [{ ownerId: req.user!.userId }, { shared: true }] },
      orderBy: { name: 'asc' },
    });
    res.json({ success: true, data: rows.map((r) => ({ ...r, mine: r.ownerId === req.user!.userId })), canShare: await canShare(req) });
  } catch (err) { next(err); }
});

router.post('/', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const { scope, name, tree, shared } = req.body;
    if (!SCOPES.includes(scope)) throw new AppError('Unknown filter scope', 400);
    const nm = String(name || '').trim();
    if (!nm) throw new AppError('Give the filter a name', 400);
    if (!tree || typeof tree !== 'object') throw new AppError('Nothing to save', 400);
    const share = !!shared && (await canShare(req));
    const row = await prisma.savedFilter.create({ data: { scope, name: nm.slice(0, 120), tree, ownerId: req.user!.userId, shared: share } });
    res.status(201).json({ success: true, data: row });
  } catch (err) { next(err); }
});

router.delete('/:id', async (req: AuthRequest, res: Response, next: NextFunction) => {
  try {
    const f = await prisma.savedFilter.findUnique({ where: { id: req.params.id } });
    if (!f) throw new AppError('Filter not found', 404);
    if (f.ownerId !== req.user!.userId && !(await canShare(req))) throw new AppError('Not your filter', 403);
    await prisma.savedFilter.delete({ where: { id: f.id } });
    res.json({ success: true });
  } catch (err) { next(err); }
});

export default router;
