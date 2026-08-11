import { Response, NextFunction } from 'express';
import crypto from 'crypto';
import { CallDirection } from '@prisma/client';
import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { AuthRequest } from '../types';
import { DeviceRequest } from '../middleware/deviceAuth';
import { normalizePhone } from '../utils/phone';

const employeeSelect = { id: true, firstName: true, lastName: true } as const;

export const callTrackingController = {
  // ─── Device management (HR/Sales Admin) ────────────────────────────────

  async listDevices(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const devices = await prisma.salesDevice.findMany({
        include: { employee: { select: employeeSelect } },
        orderBy: { createdAt: 'desc' },
      });
      // Token itself is only ever shown once, at creation — a lost token means
      // re-registering the device, not "look it up again".
      res.json({ success: true, data: devices.map(({ deviceToken: _t, ...d }) => d) });
    } catch (err) { next(err); }
  },

  async registerDevice(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { employeeId, label } = req.body;
      if (!employeeId) throw new AppError('employeeId is required', 400);
      const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
      if (!employee) throw new AppError('Employee not found', 404);

      const deviceToken = crypto.randomBytes(24).toString('hex');
      const device = await prisma.salesDevice.create({
        data: { employeeId, label, deviceToken },
        include: { employee: { select: employeeSelect } },
      });

      res.status(201).json({
        success: true,
        data: device,
        message: 'Device registered. Copy the token now — it will not be shown again; enter it into the call-tracking app on that phone.',
      });
    } catch (err) { next(err); }
  },

  async deactivateDevice(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      await prisma.salesDevice.update({ where: { id: req.params.id }, data: { isActive: false } });
      res.json({ success: true, message: 'Device deactivated' });
    } catch (err) { next(err); }
  },

  // ─── Call-event ingestion (device-token auth, hit by the Android app) ──

  async ingestCallEvent(req: DeviceRequest, res: Response, next: NextFunction) {
    try {
      if (!req.device) throw new AppError('Device not authenticated', 401);
      const { phoneNumber, direction, durationSeconds, occurredAt, recordingUrl } = req.body;
      if (!phoneNumber) throw new AppError('phoneNumber is required', 400);
      if (direction && !Object.values(CallDirection).includes(direction)) {
        throw new AppError(`direction must be one of ${Object.values(CallDirection).join(', ')}`, 400);
      }

      const normalized = normalizePhone(phoneNumber);
      const calledAt = occurredAt ? new Date(occurredAt) : new Date();

      // No index-friendly way to match against inconsistently-formatted
      // stored numbers, so normalize both sides in application code. Leads
      // tables at this scale (a sales team's working set, not millions of
      // rows) make this a non-issue — and this only runs once per call, not
      // in a hot path.
      let matchedLeadId: string | null = null;
      if (normalized) {
        const leads = await prisma.lead.findMany({ select: { id: true, phone: true } });
        const leadMatch = leads.find((l) => normalizePhone(l.phone) === normalized);
        if (leadMatch) {
          matchedLeadId = leadMatch.id;
        } else {
          // Fall back to Student.phone — e.g. the lead already converted and
          // the call came in on the number now on file for the student
          // instead of whatever was originally on the Lead. Call history
          // still lives on the Lead record, so only useful if that student
          // has a leadId to attach to.
          const students = await prisma.student.findMany({ select: { leadId: true, phone: true } });
          const studentMatch = students.find((s) => normalizePhone(s.phone) === normalized && s.leadId);
          if (studentMatch?.leadId) matchedLeadId = studentMatch.leadId;
        }
      }

      const log = await prisma.leadCallLog.create({
        data: {
          leadId: matchedLeadId,
          source: 'AUTO',
          direction: direction || undefined,
          durationSeconds: durationSeconds != null ? Number(durationSeconds) : undefined,
          recordingUrl: recordingUrl || undefined,
          rawPhoneNumber: phoneNumber,
          deviceId: req.device.id,
          calledById: req.device.employeeId,
          calledAt,
        },
      });

      if (matchedLeadId) {
        await prisma.lead.update({ where: { id: matchedLeadId }, data: { lastContactAt: calledAt } });
      }

      res.status(201).json({ success: true, data: { id: log.id, matched: !!matchedLeadId } });
    } catch (err) { next(err); }
  },

  // ─── Unmatched-call review queue (Sales team) ──────────────────────────

  async listUnmatchedCalls(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const calls = await prisma.leadCallLog.findMany({
        where: { leadId: null, source: 'AUTO' },
        include: { calledBy: { select: employeeSelect } },
        orderBy: { calledAt: 'desc' },
      });
      res.json({ success: true, data: calls });
    } catch (err) { next(err); }
  },

  /** Attach an unmatched call-log row to an existing lead after review. */
  async linkUnmatchedCall(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { leadId } = req.body;
      if (!leadId) throw new AppError('leadId is required', 400);
      const [call, lead] = await Promise.all([
        prisma.leadCallLog.findUnique({ where: { id: req.params.id } }),
        prisma.lead.findUnique({ where: { id: leadId } }),
      ]);
      if (!call) throw new AppError('Call log not found', 404);
      if (call.leadId) throw new AppError('Call is already linked to a lead', 400);
      if (!lead) throw new AppError('Lead not found', 404);

      const updated = await prisma.leadCallLog.update({ where: { id: call.id }, data: { leadId } });
      await prisma.lead.update({ where: { id: leadId }, data: { lastContactAt: call.calledAt } });
      res.json({ success: true, data: updated });
    } catch (err) { next(err); }
  },

  /** Create a brand-new lead directly from an unmatched call. */
  async createLeadFromUnmatchedCall(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { name } = req.body;
      const call = await prisma.leadCallLog.findUnique({ where: { id: req.params.id } });
      if (!call) throw new AppError('Call log not found', 404);
      if (call.leadId) throw new AppError('Call is already linked to a lead', 400);
      if (!call.rawPhoneNumber) throw new AppError('Call has no phone number on file', 400);

      const lead = await prisma.$transaction(async (tx) => {
        const newLead = await tx.lead.create({
          data: {
            name: name?.trim() || 'Unknown (from inbound call)',
            phone: call.rawPhoneNumber!,
            source: 'Inbound Call',
            assignedToId: call.calledById,
            lastContactAt: call.calledAt,
          },
        });
        await tx.leadCallLog.update({ where: { id: call.id }, data: { leadId: newLead.id } });
        return newLead;
      });

      res.status(201).json({ success: true, data: lead });
    } catch (err) { next(err); }
  },
};
