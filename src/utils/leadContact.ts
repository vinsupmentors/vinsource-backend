import prisma from '../config/database';

/** Records the FIRST time a lead was contacted. No-op if it was already set, so it never moves. */
export async function markFirstContact(leadId: string, at: Date = new Date()) {
  await prisma.lead.updateMany({ where: { id: leadId, firstContactedAt: null }, data: { firstContactedAt: at } }).catch(() => undefined);
}
