import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { paginate, formatPagination } from '../utils/helpers';

export const assetController = {
  // List all assets (HR/Admin view) with current assignment
  async listAll(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { page = 1, limit = 20, status, type } = req.query;
      const p = Number(page), l = Number(limit);

      const where: Record<string, unknown> = {};
      if (status) where.status = status;
      if (type) where.type = type;

      const [assets, total] = await Promise.all([
        prisma.asset.findMany({
          where,
          include: {
            assignments: {
              where: { returnedAt: null },
              include: {
                employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true } },
              },
              orderBy: { assignedAt: 'desc' },
              take: 1,
            },
          },
          orderBy: { createdAt: 'desc' },
          ...paginate(p, l),
        }),
        prisma.asset.count({ where }),
      ]);

      res.json({ success: true, data: assets, meta: formatPagination(total, p, l) });
    } catch (err) { next(err); }
  },

  // Get assets assigned to the logged-in employee
  async myAssets(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const emp = await prisma.employee.findUnique({ where: { userId: req.user!.userId } });
      if (!emp) return res.json({ success: true, data: [] });

      const assignments = await prisma.assetAssignment.findMany({
        where: { employeeId: emp.id, returnedAt: null },
        include: { asset: true },
        orderBy: { assignedAt: 'desc' },
      });

      res.json({ success: true, data: assignments });
    } catch (err) { next(err); }
  },

  // Get all assignments for an employee (history)
  async employeeAssets(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const assignments = await prisma.assetAssignment.findMany({
        where: { employeeId: req.params.employeeId },
        include: { asset: true },
        orderBy: { assignedAt: 'desc' },
      });
      res.json({ success: true, data: assignments });
    } catch (err) { next(err); }
  },

  // Create a new asset
  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, type, serialNumber, brand, model, purchaseDate, warrantyDate, notes, employeeId } = req.body;
      if (!name || !type) throw new AppError('Name and type are required', 400);

      // Validate the optional direct-assignment target before creating anything
      if (employeeId) {
        const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
        if (!emp) throw new AppError('Selected employee not found', 404);
      }

      const asset = await prisma.asset.create({
        data: {
          name,
          type,
          serialNumber: serialNumber || undefined,
          brand,
          model,
          purchaseDate: purchaseDate ? new Date(purchaseDate) : undefined,
          warrantyDate: warrantyDate ? new Date(warrantyDate) : undefined,
          notes,
          status: employeeId ? 'ASSIGNED' : undefined,
        },
      });

      // Optional: assign to an employee in the same step
      if (employeeId) {
        await prisma.assetAssignment.create({
          data: { assetId: asset.id, employeeId, notes: notes || undefined },
        });
      }

      res.status(201).json({ success: true, data: asset, message: employeeId ? 'Asset created and assigned' : 'Asset created' });
    } catch (err) { next(err); }
  },

  // Assign asset to employee
  async assign(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { employeeId, condition, notes } = req.body;
      const { id: assetId } = req.params;

      const asset = await prisma.asset.findUnique({ where: { id: assetId } });
      if (!asset) throw new AppError('Asset not found', 404);
      if (asset.status === 'ASSIGNED') throw new AppError('Asset already assigned', 400);

      const [assignment] = await prisma.$transaction([
        prisma.assetAssignment.create({
          data: { assetId, employeeId, condition, notes },
          include: { asset: true, employee: { select: { firstName: true, lastName: true, employeeCode: true } } },
        }),
        prisma.asset.update({ where: { id: assetId }, data: { status: 'ASSIGNED' } }),
      ]);

      res.status(201).json({ success: true, data: assignment });
    } catch (err) { next(err); }
  },

  // Return asset
  async return(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { condition, notes } = req.body;
      const { assignmentId } = req.params;

      const assignment = await prisma.assetAssignment.findUnique({
        where: { id: assignmentId },
        include: { asset: true },
      });
      if (!assignment) throw new AppError('Assignment not found', 404);
      if (assignment.returnedAt) throw new AppError('Asset already returned', 400);

      const [updated] = await prisma.$transaction([
        prisma.assetAssignment.update({
          where: { id: assignmentId },
          data: { returnedAt: new Date(), condition: condition || assignment.condition, notes: notes || assignment.notes },
        }),
        prisma.asset.update({ where: { id: assignment.assetId }, data: { status: 'AVAILABLE' } }),
      ]);

      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name, type, serialNumber, brand, model, purchaseDate, warrantyDate, status, notes } = req.body;
      const asset = await prisma.asset.update({
        where: { id: req.params.id },
        data: {
          name, type, serialNumber, brand, model,
          purchaseDate: purchaseDate ? new Date(purchaseDate) : undefined,
          warrantyDate: warrantyDate ? new Date(warrantyDate) : undefined,
          status: status as any,
          notes,
        },
      });
      res.json({ success: true, data: asset });
    } catch (err) { next(err); }
  },
};
