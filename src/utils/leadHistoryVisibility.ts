import prisma from '../config/database';

/**
 * When Sales Admin hands a lead out from MyBase with "show history" unticked,
 * the lead's historyHiddenBefore is set. Nothing is deleted — the new owner
 * just doesn't see anything older than that moment. Admins always see all.
 * Returns the cut-off date, or null when everything is visible.
 */
export async function historyCutoff(isAdmin: boolean, leadId: string): Promise<Date | null> {
  if (isAdmin) return null;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { historyHiddenBefore: true } });
  return lead?.historyHiddenBefore ?? null;
}
