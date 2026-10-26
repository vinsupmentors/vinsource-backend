import { Response, NextFunction } from 'express';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { ALERT_TYPES, describeRule, salesAlertsService } from '../services/salesAlerts.service';

const ACTIVITY = ['DNP', 'FOLLOW_UP', 'DEMO_BOOKED', 'DEMO_OVER'];

/** Validate + shape rule input from the screen. */
function parse(body: Record<string, unknown>) {
  const type = String(body.type || '');
  if (!ALERT_TYPES[type]) throw new AppError('Choose a valid rule type', 400);
  const name = String(body.name || '').trim();
  if (!name) throw new AppError('Give the rule a name', 400);
  const days = Number(body.days);
  if (!Number.isFinite(days) || days < 1 || days > 365) throw new AppError('Days must be between 1 and 365', 400);
  const activityStatus = type === 'STATUS_STALE' ? String(body.activityStatus || '') : '';
  if (type === 'STATUS_STALE' && !ACTIVITY.includes(activityStatus)) throw new AppError('Choose which status this rule watches', 400);
  const sendHour = Number(body.sendHour ?? 9);
  if (!Number.isInteger(sendHour) || sendHour < 0 || sendHour > 23) throw new AppError('Send hour must be 0–23', 400);
  const adminEmails = String(body.adminEmails || '').split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean);
  if (adminEmails.some((e) => !e.includes('@'))) throw new AppError('One of the admin emails is not valid', 400);
  return {
    name, type, days: Math.round(days), activityStatus: activityStatus || null,
    includeMyBase: body.includeMyBase !== false, notifyOwner: body.notifyOwner !== false, notifyAdmins: body.notifyAdmins !== false,
    adminEmails: adminEmails.length ? adminEmails.join(', ') : null, sendHour, active: body.active !== false,
  };
}

export const salesAlertsController = {
  async list(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const rules = await prisma.salesAlertRule.findMany({ orderBy: { createdAt: 'asc' } });
      res.json({ success: true, data: { rules: rules.map((r) => ({ ...r, description: describeRule(r) })), types: ALERT_TYPES } });
    } catch (err) { next(err); }
  },
  async create(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const rule = await prisma.salesAlertRule.create({ data: parse(req.body || {}) });
      res.status(201).json({ success: true, data: rule });
    } catch (err) { next(err); }
  },
  async update(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const rule = await prisma.salesAlertRule.update({ where: { id: req.params.id }, data: parse(req.body || {}) });
      res.json({ success: true, data: rule });
    } catch (err) { next(err); }
  },
  async remove(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.salesAlertRule.delete({ where: { id: req.params.id } });
      res.json({ success: true });
    } catch (err) { next(err); }
  },
  /** Who would be emailed right now, without sending anything. */
  async preview(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const rule = await prisma.salesAlertRule.findUnique({ where: { id: req.params.id } });
      if (!rule) throw new AppError('Rule not found', 404);
      res.json({ success: true, data: await salesAlertsService.preview(rule) });
    } catch (err) { next(err); }
  },
  /** Send this rule's digest immediately (useful to test the emails). */
  async sendNow(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const rule = await prisma.salesAlertRule.findUnique({ where: { id: req.params.id } });
      if (!rule) throw new AppError('Rule not found', 404);
      const r = await salesAlertsService.runRule(rule);
      res.json({ success: true, data: r });
    } catch (err) { next(err); }
  },
};
