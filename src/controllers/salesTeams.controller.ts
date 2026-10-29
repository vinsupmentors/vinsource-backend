import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

export const salesTeamsController = {
  async list(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const maps = await prisma.salesTeamMap.findMany();
      res.json({ success: true, data: maps });
    } catch (err) { next(err); }
  },

  /** Body: { employeeId, tlId } — tlId empty clears the mapping. */
  async set(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const employeeId = String(req.body?.employeeId || '');
      const tlId = req.body?.tlId ? String(req.body.tlId) : '';
      if (!employeeId) throw new AppError('Choose an employee', 400);
      if (!tlId || tlId === employeeId) {
        await prisma.salesTeamMap.deleteMany({ where: { employeeId } });
      } else {
        // A Team Lead can't themselves report to someone else's team (keeps it one level).
        if (await prisma.salesTeamMap.findFirst({ where: { tlId: employeeId }, select: { employeeId: true } })) throw new AppError('This person is a Team Lead for others — move their members first', 400);
        if (await prisma.salesTeamMap.findUnique({ where: { employeeId: tlId } })) throw new AppError('That person reports to another Team Lead, so they cannot be a TL', 400);
        await prisma.salesTeamMap.upsert({ where: { employeeId }, create: { employeeId, tlId }, update: { tlId } });
      }
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};
