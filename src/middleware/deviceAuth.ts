import { Request, Response, NextFunction } from 'express';
import prisma from '../config/database';

/**
 * Authenticates the SIM call-tracking Android app's requests. Deliberately
 * separate from the normal `authenticate` middleware — that one expects a
 * logged-in employee's JWT, but this endpoint is hit unattended by a
 * background service on a salesperson's phone with nobody logged into the
 * portal on that device. Instead it presents a long-lived per-device token
 * (issued once via the device-registration endpoint) in an `x-device-token`
 * header.
 */
export interface DeviceRequest extends Request {
  device?: { id: string; employeeId: string };
}

export const authenticateDevice = async (req: DeviceRequest, res: Response, next: NextFunction): Promise<void> => {
  const token = req.headers['x-device-token'];
  if (!token || typeof token !== 'string') {
    res.status(401).json({ success: false, message: 'Missing device token' });
    return;
  }
  const device = await prisma.salesDevice.findUnique({ where: { deviceToken: token } });
  if (!device || !device.isActive) {
    res.status(401).json({ success: false, message: 'Invalid or deactivated device token' });
    return;
  }
  req.device = { id: device.id, employeeId: device.employeeId };
  // Fire-and-forget — a heartbeat write failing shouldn't block the actual
  // call-event ingestion it's riding along with.
  prisma.salesDevice.update({ where: { id: device.id }, data: { lastSeenAt: new Date() } }).catch(() => {});
  next();
};
