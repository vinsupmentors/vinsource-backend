import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

export const salesTeamsController = {
  /** All "reports to" arrows: [{ employeeId, tlId }]. A person may have several. */
  async list(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const maps = await prisma.salesTeamMap.findMany({ select: { employeeId: true, tlId: true } });
      res.json({ success: true, data: maps });
    } catch (err) { next(err); }
  },

  /** Body: { employeeId, tlId, action: 'add' | 'remove' }. Without tlId, every arrow out of employeeId is cleared. */
  async set(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = String(req.body?.employeeId || '');
      const tlId = req.body?.tlId ? String(req.body.tlId) : '';
      const action = req.body?.action === 'remove' ? 'remove' : 'add';
      if (!employeeId) throw new AppError('Choose an employee', 400);
      if (!tlId) {
        await prisma.salesTeamMap.deleteMany({ where: { employeeId } });
      } else if (action === 'remove') {
        await prisma.salesTeamMap.deleteMany({ where: { employeeId, tlId } });
      } else {
        if (tlId === employeeId) throw new AppError('A person cannot report to themselves', 400);
        // Keep it to one level: a Team Lead can't report to someone, and a member can't be a TL.
        if (await prisma.salesTeamMap.findFirst({ where: { tlId: employeeId } })) throw new AppError('This person is a Team Lead for others, so they cannot report to someone else', 400);
        if (await prisma.salesTeamMap.findFirst({ where: { employeeId: tlId } })) throw new AppError('That person reports to someone, so they cannot be a Team Lead', 400);
        await prisma.salesTeamMap.upsert({ where: { employeeId_tlId: { employeeId, tlId } }, create: { employeeId, tlId }, update: {} });
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },

  async layout(_req: AuthRequest, res: Response, next: NextFunction) {
    try { res.json({ success: true, data: await prisma.salesTeamNode.findMany({ select: { employeeId: true, x: true, y: true } }) }); } catch (err) { next(err); }
  },

  /** Body: { employeeId, x, y } saves a card position; { employeeId, remove: true } takes the card (and its arrows) off the canvas. */
  async saveNode(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = String(req.body?.employeeId || '');
      if (!employeeId) throw new AppError('Choose an employee', 400);
      if (req.body?.remove) {
        await prisma.salesTeamNode.deleteMany({ where: { employeeId } });
        await prisma.salesTeamMap.deleteMany({ where: { OR: [{ employeeId }, { tlId: employeeId }] } });
      } else {
        const x = Math.round(Number(req.body?.x)), y = Math.round(Number(req.body?.y));
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new AppError('Invalid position', 400);
        await prisma.salesTeamNode.upsert({ where: { employeeId }, create: { employeeId, x, y }, update: { x, y } });
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};
