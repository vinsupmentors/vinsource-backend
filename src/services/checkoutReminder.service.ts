import prisma from '../config/database';
import { emailService } from './email.service';

const REMINDER_HOURS = 8; // send reminder after this many work hours

function todayRange(): { start: Date; end: Date } {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function checkoutReminderHtml(data: {
  firstName: string;
  checkInTime: string;
  hoursWorked: number;
  portalUrl: string;
}): string {
  return `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <div style="background:#1e3a8a;padding:24px;text-align:center;">
        <h1 style="color:#fff;margin:0;font-size:22px;">⏰ Time to Check Out!</h1>
        <p style="color:#93c5fd;margin:6px 0 0;font-size:13px;">Vin-Source Portal — Attendance Reminder</p>
      </div>
      <div style="padding:26px;">
        <p>Dear <strong>${data.firstName}</strong>,</p>
        <p>You checked in at <strong>${data.checkInTime}</strong> and have now completed approximately <strong>${data.hoursWorked} hours</strong> of work today. Don't forget to <strong>check out</strong> on the portal so your attendance is recorded accurately.</p>

        <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:14px;border-radius:0 6px 6px 0;margin:20px 0;">
          <p style="margin:0;font-weight:700;color:#92400e;">⚠️ Please check out before leaving</p>
          <p style="margin:8px 0 0;font-size:14px;color:#78350f;">Forgetting to check out may affect your attendance record and work-hours calculation.</p>
        </div>

        <p style="text-align:center;margin:24px 0;">
          <a href="${data.portalUrl}" style="background:#1e3a8a;color:#fff;padding:13px 30px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;font-size:15px;">Go to Portal → Check Out</a>
        </p>

        <p style="color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:14px;margin-top:20px;">
          This is an automated reminder from the Vin-Source Portal attendance system.<br/>
          If you have already checked out, please disregard this email.
        </p>
      </div>
    </div>`;
}

export const checkoutReminderService = {
  /**
   * Finds every employee who checked in today but has NOT checked out,
   * and whose check-in was ≥ REMINDER_HOURS ago. Sends them an email
   * reminder to check out. Each employee gets at most ONE reminder per day
   * (deduped via EmailLog.template = 'checkoutReminder').
   */
  async sendCheckoutReminders(): Promise<{ sent: number; skipped: number }> {
    const { start, end } = todayRange();
    const now = new Date();
    const thresholdMs = REMINDER_HOURS * 60 * 60 * 1000;

    // All attendance records today with check-in but no check-out
    const openAttendances = await prisma.attendance.findMany({
      where: {
        date: { gte: start, lte: end },
        checkIn: { not: null },
        checkOut: null,
      },
      include: {
        employee: {
          select: { id: true, firstName: true, lastName: true, email: true },
        },
      },
    });

    let sent = 0;
    let skipped = 0;

    const portalUrl = process.env.FRONTEND_URL || 'https://vinsource.vinsupskillacademy.com';

    for (const att of openAttendances) {
      if (!att.checkIn) continue;

      // Check if this employee has worked >= REMINDER_HOURS
      const elapsed = now.getTime() - att.checkIn.getTime();
      if (elapsed < thresholdMs) { skipped++; continue; }

      const empEmail = att.employee?.email;
      if (!empEmail) { skipped++; continue; }

      // Dedup: already sent a reminder to this email today?
      const alreadySent = await prisma.emailLog.findFirst({
        where: {
          to: { contains: empEmail },
          template: 'checkoutReminder',
          sentAt: { gte: start, lte: end },
          status: 'SENT',
        },
      });
      if (alreadySent) { skipped++; continue; }

      const checkInTime = att.checkIn.toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', hour12: true,
      });
      const hoursWorked = Math.floor(elapsed / (1000 * 60 * 60));

      try {
        await emailService.send({
          to: empEmail,
          subject: `⏰ Reminder: Please check out on the portal`,
          html: checkoutReminderHtml({
            firstName: att.employee!.firstName,
            checkInTime,
            hoursWorked,
            portalUrl,
          }),
          template: 'checkoutReminder',
        });
        sent++;
      } catch (err) {
        console.error(`Checkout reminder failed for ${empEmail}:`, err);
        skipped++;
      }
    }

    return { sent, skipped };
  },
};
