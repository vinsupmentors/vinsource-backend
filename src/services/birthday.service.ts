import prisma from '../config/database';
import { emailService } from './email.service';
import { notificationService } from './notification.service';
import { config } from '../config/env';

export const birthdayService = {
  /**
   * Finds every ACTIVE employee whose dateOfBirth falls on today's month/day,
   * and for each one found, emails + notifies the rest of the company.
   * Safe to call multiple times a day — re-sends are harmless but you should
   * only wire this up to run once per day via the cron job in server.ts.
   */
  async sendTodaysBirthdayWishes() {
    const today = new Date();
    const todayMonth = today.getMonth();
    const todayDate = today.getDate();

    const allActive = await prisma.employee.findMany({
      where: { status: { in: ['ACTIVE', 'ON_PROBATION'] }, dateOfBirth: { not: null }, isSystemAccount: false },
      select: { id: true, userId: true, firstName: true, lastName: true, email: true, dateOfBirth: true, profilePhoto: true },
    });

    const celebrants = allActive.filter((emp) => {
      if (!emp.dateOfBirth) return false;
      const dob = new Date(emp.dateOfBirth);
      return dob.getMonth() === todayMonth && dob.getDate() === todayDate;
    });

    if (celebrants.length === 0) {
      return { celebrants: [], notified: 0 };
    }

    // Recipients: every active employee (including celebrants themselves can receive a copy too)
    const allEmployees = await prisma.employee.findMany({
      where: { status: { in: ['ACTIVE', 'ON_PROBATION'] }, isSystemAccount: false },
      select: { id: true, userId: true, firstName: true, lastName: true, email: true },
    });

    for (const celebrant of celebrants) {
      const celebrantName = `${celebrant.firstName} ${celebrant.lastName}`;

      // Email the whole company (skip the celebrant's own inbox if you'd rather keep it a surprise —
      // here we include everyone so it reads as a genuine company-wide announcement)
      const recipientEmails = allEmployees
        .filter((e) => e.email)
        .map((e) => e.email);

      if (recipientEmails.length > 0) {
        await emailService
          .send({
            to: recipientEmails,
            subject: `🎉 Happy Birthday, ${celebrantName}!`,
            html: emailService.templates.birthdayWish({
              celebrantName,
              celebrantFirstName: celebrant.firstName,
              // Absolute URL so the photo renders inside email clients
              photoUrl: celebrant.profilePhoto
                ? `${config.FRONTEND_URL}${celebrant.profilePhoto.startsWith('/') ? '' : '/'}${celebrant.profilePhoto}`
                : null,
              logoUrl: `${config.FRONTEND_URL}/vinsup-logo.png`,
            }),
            template: 'birthday_wish',
          })
          .catch((err) => console.error('Birthday email failed:', err));
      }

      // In-app notification for everyone
      const recipientUserIds = allEmployees
        .filter((e) => e.userId && e.userId !== celebrant.userId)
        .map((e) => e.userId);

      await notificationService.bulkCreate(recipientUserIds, {
        type: 'BIRTHDAY',
        title: `🎂 It's ${celebrantName}'s Birthday!`,
        message: `Wish ${celebrantName} a very Happy Birthday today!`,
        data: { employeeId: celebrant.id },
      });
    }

    return { celebrants: celebrants.map((c) => `${c.firstName} ${c.lastName}`), notified: celebrants.length };
  },
};
