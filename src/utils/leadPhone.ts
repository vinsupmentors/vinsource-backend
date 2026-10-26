import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';

/**
 * Duplicate-control key for a lead's phone: the last 10 digits, so "+91 98765-43210",
 * "09876543210" and "9876543210" are all the same person. Stored on Lead.phoneKey.
 */
export function leadPhoneKey(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (!digits) return null;
  return digits.length > 10 ? digits.slice(-10) : digits;
}

/** The live (not removed) lead already using this phone, if any. */
export async function findDuplicateLead(phone: string, excludeId?: string) {
  const key = leadPhoneKey(phone);
  if (!key) return null;
  return prisma.lead.findFirst({
    where: { phoneKey: key, deletedAt: null, ...(excludeId ? { id: { not: excludeId } } : {}) },
    select: { id: true, name: true, status: true, assignedTo: { select: { firstName: true, lastName: true } } },
  });
}

/** Throws a 409 naming the existing lead and who owns it. */
export async function assertNoDuplicateLead(phone: string, excludeId?: string) {
  const dup = await findDuplicateLead(phone, excludeId);
  if (dup) {
    const owner = dup.assignedTo ? `${dup.assignedTo.firstName} ${dup.assignedTo.lastName}` : 'My Base (unassigned)';
    throw new AppError(`This phone number already belongs to lead "${dup.name}" — owner: ${owner}`, 409);
  }
}
