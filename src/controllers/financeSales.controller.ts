import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { paginate, formatPagination } from '../utils/helpers';

const employeeSelect = { id: true, firstName: true, lastName: true, employeeCode: true };

export const financeSalesController = {
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 20, mode, search } = req.query;
      const p = Number(page), l = Number(limit);

      const where: Record<string, unknown> = {};
      if (mode) where.mode = mode;
      if (search) {
        where.OR = [
          { studentName: { contains: String(search) } },
          { receiptNo: { contains: String(search) } },
        ];
      }

      const [collections, total, sumResult] = await Promise.all([
        prisma.feeCollection.findMany({
          where,
          include: {
            lead: { select: { id: true, name: true, courseInterest: true } },
            receivedBy: { select: employeeSelect },
          },
          orderBy: { collectedAt: 'desc' },
          ...paginate(p, l),
        }),
        prisma.feeCollection.count({ where }),
        prisma.feeCollection.aggregate({ where, _sum: { amount: true } }),
      ]);

      res.json({
        success: true,
        data: collections,
        meta: { ...formatPagination(total, p, l), totalAmount: sumResult._sum.amount || 0 },
      });
    } catch (err) { next(err); }
  },

  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { leadId, studentName, amount, mode, receivedById, receiptNo, remarks, collectedAt } = req.body;
      if (!studentName || !amount) throw new AppError('Student name and amount are required', 400);

      const collection = await prisma.feeCollection.create({
        data: {
          leadId: leadId || undefined,
          studentName,
          amount: Number(amount),
          mode,
          receivedById,
          receiptNo: receiptNo || undefined,
          remarks,
          collectedAt: collectedAt ? new Date(collectedAt) : undefined,
        },
        include: { lead: true, receivedBy: { select: employeeSelect } },
      });
      res.status(201).json({ success: true, data: collection });
    } catch (err) { next(err); }
  },

  async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { studentName, amount, mode, receivedById, receiptNo, remarks } = req.body;
      const collection = await prisma.feeCollection.update({
        where: { id: req.params.id },
        data: {
          studentName, amount: amount !== undefined ? Number(amount) : undefined,
          mode, receivedById, receiptNo, remarks,
        },
        include: { lead: true, receivedBy: { select: employeeSelect } },
      });
      res.json({ success: true, data: collection });
    } catch (err) { next(err); }
  },

  async remove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.feeCollection.delete({ where: { id: req.params.id } });
      res.json({ success: true, message: 'Collection deleted' });
    } catch (err) { next(err); }
  },

  async stats(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const startOfMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
      const [totalAll, totalThisMonth, byMode, count] = await Promise.all([
        prisma.feeCollection.aggregate({ _sum: { amount: true } }),
        prisma.feeCollection.aggregate({ _sum: { amount: true }, where: { collectedAt: { gte: startOfMonth } } }),
        prisma.feeCollection.groupBy({ by: ['mode'], _sum: { amount: true } }),
        prisma.feeCollection.count(),
      ]);

      const modeTotals: Record<string, number> = {};
      for (const row of byMode) modeTotals[row.mode] = row._sum.amount || 0;

      res.json({
        success: true,
        data: {
          totalCollected: totalAll._sum.amount || 0,
          collectedThisMonth: totalThisMonth._sum.amount || 0,
          modeTotals,
          totalTransactions: count,
        },
      });
    } catch (err) { next(err); }
  },
};
