import prisma from '../config/database';
import { emailService } from './email.service';
import { config } from '../config/env';

export const passwordReminderService = {
  async sendDailyReminders(): Promise<{ sent: number; failed: number }> {
    let sent = 0;
    let failed = 0;

    // Find all active users who still need to change their password
    const users = await prisma.user.findMany({
      where: {
        mustChangePassword: true,
        isActive: true,
        role: { not: 'STUDENT' }, // students have separate flow
      },
      include: {
        employee: { select: { firstName: true, lastName: true, email: true } },
      },
    });

    for (const user of users) {
      const firstName = user.employee?.firstName ?? 'Team Member';
      const email = user.employee?.email ?? user.email;

      try {
        await emailService.send({
          to: email,
          subject: '⚠️ Action Required: Please Change Your Vin-Source Portal Password',
          html: emailService.templates.passwordChangeReminder({
            firstName,
            email: user.email,
            loginUrl: config.FRONTEND_URL + '/login',
          }),
          template: 'passwordChangeReminder',
        });
        sent++;
      } catch {
        failed++;
      }
    }

    return { sent, failed };
  },
};
