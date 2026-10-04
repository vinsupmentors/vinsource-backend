import { Response, NextFunction } from 'express';
import { verifyToken } from '../utils/jwt';
import { AuthRequest } from '../types';
import prisma from '../config/database';

// Student sessions are pinned to one device (User.boundDeviceId). Checking
// that on every request costs a primary-key lookup, so the result is cached
// for a few seconds — short enough that an admin approving a device change
// (which calls invalidateStudentDeviceCache) takes effect immediately, long
// enough to absorb a burst of parallel API calls from one page load.
const DEVICE_CACHE_TTL_MS = 15_000;
const deviceCache = new Map<string, { boundDeviceId: string | null; at: number }>();

export const invalidateStudentDeviceCache = (userId: string): void => {
  deviceCache.delete(userId);
};

async function getBoundDeviceId(userId: string): Promise<string | null> {
  const hit = deviceCache.get(userId);
  if (hit && Date.now() - hit.at < DEVICE_CACHE_TTL_MS) return hit.boundDeviceId;
  const u = await prisma.user.findUnique({ where: { id: userId }, select: { boundDeviceId: true } });
  const boundDeviceId = u?.boundDeviceId ?? null;
  deviceCache.set(userId, { boundDeviceId, at: Date.now() });
  return boundDeviceId;
}

export const authenticate = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    res.status(401).json({ success: false, message: 'No token provided' });
    return;
  }
  const token = header.slice(7);
  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    res.status(401).json({ success: false, message: 'Invalid or expired token' });
    return;
  }

  if (payload.role === 'STUDENT') {
    try {
      const bound = await getBoundDeviceId(payload.userId);
      // No deviceId on the token = issued before single-device login
      // existed; treat it as signed out so the student logs in again and
      // gets bound. A mismatch = the account was moved to another device
      // (admin-approved) or this token belongs to a device that's no longer
      // the registered one.
      if (!payload.deviceId || !bound || payload.deviceId !== bound) {
        res.status(401).json({
          success: false,
          code: 'DEVICE_CHANGED',
          message: 'Your account is now active on a different device, so you have been signed out here. Please sign in again.',
        });
        return;
      }
    } catch (err) {
      next(err);
      return;
    }
  }

  req.user = payload;
  next();
};
