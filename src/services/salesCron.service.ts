import prisma from '../config/database';
import { emailService } from './email.service';
import { computeSalesPulse } from './salesPulse.service';

async function getConfiguredRecipients(): Promise<{ name: string | null; email: string }[]> {
  const rows = await prisma.reportRecipient.findMany({ where: { type: 'SALES_HOURLY' } });
  return rows.map((r: { name: string | null; email: string }) => ({ name: r.name, email: r.email }));
}

export const salesCronService = {
  /**
   * Sends the current "as of now" sales snapshot to everyone configured as a
   * SALES_HOURLY report recipient. Called at 11, 12, 1, 2, 4, 5 and 6 — the
   * 6 PM run is marked as the End of Day report (same numbers, different
   * subject/heading, since 6 PM is simply the last checkpoint of the day).
   */
  async sendPulseReport(isEod: boolean): Promise<{ sent: number }> {
    const recipients = await getConfiguredRecipients();
    if (recipients.length === 0) return { sent: 0 };

    const stats = await computeSalesPulse();
    const timeLabel = new Date().toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit', hour12: true });

    const html = emailService.templates.salesPulseReport({ timeLabel, isEod, stats });
    await emailService.send({
      to: recipients.map((r) => r.email),
      subject: isEod ? `🌙 Sales — End of Day Report (${timeLabel})` : `📞 Sales Pulse — ${timeLabel}`,
      html,
      template: 'salesPulseReport',
    });

    return { sent: recipients.length };
  },
};
