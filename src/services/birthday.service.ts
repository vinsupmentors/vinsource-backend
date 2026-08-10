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

    // exitDate is the authoritative "this person has left" signal — belt and
    // braces alongside status, since status can lag behind reality if HR
    // hasn't gotten around to flipping it to TERMINATED/RESIGNED yet.
    const allActive = await prisma.employee.findMany({
      where: { status: { in: ['ACTIVE', 'ON_PROBATION'] }, exitDate: null, dateOfBirth: { not: null }, isSystemAccount: false },
      select: { id: true, userId: true, firstName: true, lastName: true, email: true, dateOfBirth: true, profilePhoto: true },
    });

    const celebrants = allActive.filter((emp) => {
      if (!emp.dateOfBirth) return false;
      const dob = new Date(emp.dateOfBirth);
      return dob.getMonth() === todayMonth && dob.getDate() === todayDate;
    });

    if (celebrants.length === 0) {
      return { celebrants: [], notified: 0, skippedEmailNoPhoto: [] };
    }

    // Recipients: every active employee (including celebrants themselves can receive a copy too)
    const allEmployees = await prisma.employee.findMany({
      where: { status: { in: ['ACTIVE', 'ON_PROBATION'] }, exitDate: null, isSystemAccount: false },
      select: { id: true, userId: true, firstName: true, lastName: true, email: true },
    });

    for (const celebrant of celebrants) {
      const celebrantName = `${celebrant.firstName} ${celebrant.lastName}`;

      // Celebrant in To:, every other active employee in Bcc:
      const bccEmails = allEmployees
        .filter((e) => e.email && e.email !== celebrant.email)
        .map((e) => e.email);

      // Only send the email if a profile photo is on file — a birthday
      // wish without a photo looks unfinished, and it's cheap for HR to
      // just ask the employee to upload one before their next birthday.
      // The in-app notification still goes out either way (no photo
      // involved there), so the celebration isn't missed entirely.
      if (celebrant.email && celebrant.profilePhoto) {
        await emailService
          .send({
            to: celebrant.email,
            bcc: bccEmails,
            subject: `🎉 Happy Birthday, ${celebrantName}!`,
            html: emailService.templates.birthdayWish({
              celebrantName,
              celebrantFirstName: celebrant.firstName,
              // Absolute URL so the photo renders inside email clients
              photoUrl: `${config.FRONTEND_URL}${celebrant.profilePhoto.startsWith('/') ? '' : '/'}${celebrant.profilePhoto}`,
              logoUrl: `${config.FRONTEND_URL}/vinsup-logo.png`,
            }),
            template: 'birthday_wish',
          })
          .catch((err) => console.error('Birthday email failed:', err));
      } else if (celebrant.email) {
        console.warn(`Birthday email skipped for ${celebrantName} — no profile photo on file.`);
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

    return {
      celebrants: celebrants.map((c) => `${c.firstName} ${c.lastName}`),
      notified: celebrants.length,
      skippedEmailNoPhoto: celebrants.filter((c) => !c.profilePhoto).map((c) => `${c.firstName} ${c.lastName}`),
    };
  },
};
