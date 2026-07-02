import { createServer } from 'http';
import cron from 'node-cron';
import app from './app';
import { config } from './config/env';
import { initSocket } from './config/socket';
import prisma from './config/database';
import redis from './config/redis';
import { birthdayService } from './services/birthday.service';
import { releaseReminderService } from './services/releaseReminder.service';
import { attendanceCronService } from './services/attendanceCron.service';
import { passwordReminderService } from './services/passwordReminder.service';

const httpServer = createServer(app);
initSocket(httpServer);

const start = async () => {
  try {
    // Test DB connection
    await prisma.$connect();
    console.log('✅ Database connected');

    // Test Redis (non-fatal in development)
    try {
      await redis.connect();
    } catch (redisErr: any) {
      console.warn('⚠️  Redis unavailable, continuing without it:', redisErr.message);
    }

    httpServer.listen(config.PORT, () => {
      console.log(`🚀 HRMS Backend running on port ${config.PORT} [${config.NODE_ENV}]`);
    });

    // Password change reminder — runs every day at 9:00 AM, emails anyone with mustChangePassword=true
    cron.schedule('0 9 * * *', async () => {
      try {
        const result = await passwordReminderService.sendDailyReminders();
        if (result.sent > 0) {
          console.log(`🔑 Password change reminders sent: ${result.sent} (failed: ${result.failed})`);
        }
      } catch (err) {
        console.error('Password reminder cron failed:', err);
      }
    });

    // Daily birthday check — 8:30 AM India time (celebrant in To:, rest of company in Bcc:)
    cron.schedule('30 8 * * *', async () => {
      try {
        const result = await birthdayService.sendTodaysBirthdayWishes();
        if (result.celebrants.length > 0) {
          console.log(`🎂 Birthday wishes sent for: ${result.celebrants.join(', ')}`);
        }
      } catch (err) {
        console.error('Birthday cron job failed:', err);
      }
    }, { timezone: 'Asia/Kolkata' });

    // Deadline reminders — runs every day at 9:00 AM server time, emailing
    // students who haven't submitted a released Project/FeedbackForm/OnlineTest
    // with 3, 2, or 1 day(s) left before its deadline.
    cron.schedule('0 9 * * *', async () => {
      try {
        const result = await releaseReminderService.sendDueReminders();
        if (result.sent > 0) {
          console.log(`⏰ Deadline reminders sent: ${result.sent}`);
        }
      } catch (err) {
        console.error('Deadline reminder cron job failed:', err);
      }
    });

    // Daily attendance report — runs every day at 8:00 AM server time, emailing
    // yesterday's attendance summary (per batch/schedule, plus an absentee list)
    // to everyone configured as a DAILY_ATTENDANCE report recipient.
    cron.schedule('0 8 * * *', async () => {
      try {
        const result = await attendanceCronService.sendDailyAttendanceReport();
        if (result.sent > 0) {
          console.log(`📋 Daily attendance report sent to ${result.sent} recipient(s), ${result.schedulesReported} schedule(s) reported`);
        }
      } catch (err) {
        console.error('Daily attendance report cron job failed:', err);
      }
    });

    // Consecutive-absence escalation — runs every day at 9:30 AM server time,
    // flagging any active enrollment with a 2- or 3-day consecutive absence
    // streak (counting back from the most recent marked training day) and
    // emailing ESCALATION recipients + Production Managers. Deduped via
    // AttendanceEscalationLog so the same streak is never reported twice.
    cron.schedule('30 9 * * *', async () => {
      try {
        const result = await attendanceCronService.checkConsecutiveAbsenceEscalations();
        if (result.sent > 0) {
          console.log(`🚨 Attendance escalation emails sent: ${result.sent} (flagged: ${result.flagged})`);
        }
      } catch (err) {
        console.error('Attendance escalation cron job failed:', err);
      }
    });

    // Student status sync — runs every day at 7:00 AM server time, flipping
    // each ACTIVE student to INACTIVE if their lifetime attendance % drops
    // below 60, and reverting any INACTIVE student back to ACTIVE the moment
    // it recovers to 60% or above. Fully automatic, no PM action required.
    cron.schedule('0 7 * * *', async () => {
      try {
        const result = await attendanceCronService.syncStudentStatusByAttendance();
        if (result.toInactive > 0 || result.toActive > 0) {
          console.log(`🔄 Student status sync: ${result.toInactive} → INACTIVE, ${result.toActive} → ACTIVE (checked ${result.checked})`);
        }
      } catch (err) {
        console.error('Student status sync cron job failed:', err);
      }
    });
  } catch (err) {
    console.error('❌ Startup failed:', err);
    process.exit(1);
  }
};

start();

process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down...');
  await prisma.$disconnect();
  redis.disconnect();
  process.exit(0);
});
