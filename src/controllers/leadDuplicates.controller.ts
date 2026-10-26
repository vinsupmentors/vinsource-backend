import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';

const empSelect = { id: true, firstName: true, lastName: true };
const nameOf = (e?: { firstName: string; lastName: string } | null) => (e ? `${e.firstName} ${e.lastName}` : 'My Base');

export const leadDuplicatesController = {
  /** Groups of live leads sharing a phone number (last 10 digits), minus the ones Admin dismissed. */
  async list(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const groups = await prisma.lead.groupBy({
        by: ['phoneKey'], where: { deletedAt: null, phoneKey: { not: null } }, _count: { _all: true }, having: { phoneKey: { _count: { gt: 1 } } },
      });
      const keys = groups.map((g) => g.phoneKey as string);
      const dismissed = new Set((await prisma.leadDuplicateDismissal.findMany({ where: { phoneKey: { in: keys } }, select: { phoneKey: true } })).map((d) => d.phoneKey));
      const open = keys.filter((k) => !dismissed.has(k)).slice(0, 200);
      const leads = open.length ? await prisma.lead.findMany({
        where: { deletedAt: null, phoneKey: { in: open } },
        select: {
          id: true, name: true, phone: true, email: true, source: true, status: true, activityStatus: true, createdAt: true, phoneKey: true,
          assignedTo: { select: empSelect }, _count: { select: { callLogs: true, demos: true, leadNotes: true, tasks: true, collections: true, students: true } },
        },
        orderBy: { createdAt: 'asc' },
      }) : [];
      const byKey = new Map<string, typeof leads>();
      for (const l of leads) { if (!byKey.has(l.phoneKey!)) byKey.set(l.phoneKey!, []); byKey.get(l.phoneKey!)!.push(l); }
      res.json({
        success: true,
        data: {
          totalGroups: keys.length - dismissed.size,
          groups: open.map((k) => ({ phoneKey: k, leads: (byKey.get(k) || []).map((l) => ({ ...l, owner: nameOf(l.assignedTo) })) })),
        },
      });
    } catch (err) { next(err); }
  },

  /** Merge duplicates into one lead: every call, demo, note, task, payment and history row moves to the keeper; the others are removed from screen (soft delete). */
  async merge(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const keepId = String(req.body?.keepId || '');
      const mergeIds: string[] = Array.isArray(req.body?.mergeIds) ? req.body.mergeIds.map(String).filter((id: string) => id && id !== keepId) : [];
      if (!keepId || !mergeIds.length) throw new AppError('Choose the lead to keep and at least one duplicate to merge into it', 400);

      const all = await prisma.lead.findMany({ where: { id: { in: [keepId, ...mergeIds] }, deletedAt: null } });
      const keeper = all.find((l) => l.id === keepId);
      const losers = all.filter((l) => l.id !== keepId);
      if (!keeper || losers.length !== mergeIds.length) throw new AppError('One of the leads no longer exists', 404);
      if (losers.some((l) => l.phoneKey !== keeper.phoneKey)) throw new AppError('Only leads with the same phone number can be merged', 400);
      const actor = req.user?.employeeId || null;

      await prisma.$transaction(async (tx) => {
        const ids = losers.map((l) => l.id);
        await tx.leadCallLog.updateMany({ where: { leadId: { in: ids } }, data: { leadId: keepId } });
        await tx.demo.updateMany({ where: { leadId: { in: ids } }, data: { leadId: keepId } });
        await tx.leadNote.updateMany({ where: { leadId: { in: ids } }, data: { leadId: keepId } });
        await tx.salesTask.updateMany({ where: { leadId: { in: ids } }, data: { leadId: keepId } });
        await tx.leadHistory.updateMany({ where: { leadId: { in: ids } }, data: { leadId: keepId } });
        await tx.feeCollection.updateMany({ where: { leadId: { in: ids } }, data: { leadId: keepId } });
        await tx.feePaymentPlan.updateMany({ where: { leadId: { in: ids } }, data: { leadId: keepId } });
        await tx.student.updateMany({ where: { leadId: { in: ids } }, data: { leadId: keepId } });

        // Fill gaps on the keeper from the duplicates (never overwrite what the keeper already has).
        const fill: Record<string, unknown> = {};
        for (const f of ['email', 'source', 'courseInterest', 'city', 'educationQualification', 'collegeName', 'passedOutYear', 'currentStatus'] as const) {
          if (!(keeper as Record<string, unknown>)[f]) {
            const donor = losers.find((l) => (l as Record<string, unknown>)[f]);
            if (donor) fill[f] = (donor as Record<string, unknown>)[f];
          }
        }
        const lastContact = [keeper.lastContactAt, ...losers.map((l) => l.lastContactAt)].filter(Boolean).sort((a, b) => b!.getTime() - a!.getTime())[0];
        if (lastContact && lastContact.getTime() !== keeper.lastContactAt?.getTime()) fill.lastContactAt = lastContact;
        if (Object.keys(fill).length) await tx.lead.update({ where: { id: keepId }, data: fill });

        await tx.lead.updateMany({ where: { id: { in: ids } }, data: { deletedAt: new Date(), deletedById: actor } });
        await tx.leadHistory.createMany({
          data: [
            { leadId: keepId, actorId: actor, type: 'EDIT', summary: `Merged ${losers.length} duplicate lead${losers.length === 1 ? '' : 's'} into this one (${losers.map((l) => l.name).join(', ')})`, fromValue: null, toValue: null },
            ...losers.map((l) => ({ leadId: l.id, actorId: actor, type: 'DELETED', summary: `Merged into lead "${keeper.name}" (duplicate phone) — data kept on that lead`, fromValue: null, toValue: null })),
          ],
        });
      });

      res.json({ success: true, data: { kept: keepId, merged: losers.length } });
    } catch (err) { next(err); }
  },

  /** "These are different people" — hide this phone's group from the duplicates list. */
  async dismiss(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const phoneKey = String(req.body?.phoneKey || '');
      if (!phoneKey) throw new AppError('phoneKey is required', 400);
      await prisma.leadDuplicateDismissal.upsert({ where: { phoneKey }, update: {}, create: { phoneKey, dismissedById: req.user?.employeeId || null } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },
};
