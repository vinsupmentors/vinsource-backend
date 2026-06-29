import prisma from '../config/database';
import { emailService } from './email.service';

const DAYS_TO_REMIND = [3, 2, 1];

function formatDeadline(deadline: Date): string {
  return new Date(deadline).toLocaleString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

/** Calendar-day difference between `deadline` and today, ignoring time-of-day. */
function daysUntil(deadline: Date): number {
  const now = new Date();
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const deadlineMidnight = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate());
  return Math.round((deadlineMidnight.getTime() - todayMidnight.getTime()) / 86400000);
}

type Recipient = { id: string; name: string; email: string | null };

async function sendReminders(
  releaseKind: 'PROJECT' | 'FEEDBACK_FORM' | 'ONLINE_TEST',
  releaseId: string,
  daysBefore: number,
  deadline: Date,
  kindLabel: string,
  title: string,
  courseName: string,
  notSubmitted: Recipient[]
) {
  if (notSubmitted.length === 0) return 0;

  const alreadySent = await prisma.deadlineReminderLog.findMany({
    where: {
      releaseKind,
      releaseId,
      daysBefore,
      studentId: { in: notSubmitted.map((s) => s.id) },
    },
    select: { studentId: true },
  });
  const alreadySentIds = new Set(alreadySent.map((r) => r.studentId));
  const toRemind = notSubmitted.filter((s) => !alreadySentIds.has(s.id));
  if (toRemind.length === 0) return 0;

  let sent = 0;
  for (const student of toRemind) {
    if (!student.email) continue;
    try {
      await emailService.send({
        to: student.email,
        subject: `⏰ ${daysBefore} day${daysBefore === 1 ? '' : 's'} left: ${title}`,
        html: emailService.templates.deadlineReminder({
          studentName: student.name,
          kindLabel,
          title,
          courseName,
          deadline: formatDeadline(deadline),
          daysLeft: daysBefore,
        }),
        template: 'deadlineReminder',
      });
      await prisma.deadlineReminderLog.create({
        data: { releaseKind, releaseId, studentId: student.id, daysBefore },
      });
      sent++;
    } catch (err) {
      console.error(`Deadline reminder failed for student ${student.id} (${releaseKind}/${releaseId}/${daysBefore}d):`, err);
    }
  }
  return sent;
}

export const releaseReminderService = {
  /**
   * For every ACTIVE Project/FeedbackForm/OnlineTest release with a deadline
   * landing exactly 3, 2, or 1 day(s) from today, emails every enrolled
   * student who has NOT yet submitted/responded/completed an attempt.
   * Dedupes via DeadlineReminderLog so a daily cron run never double-emails
   * the same (release, student, daysBefore) combination.
   */
  async sendDueReminders() {
    let totalSent = 0;

    // ── Projects ──────────────────────────────────────────────────────────
    const projectReleases = await prisma.projectRelease.findMany({
      where: { status: 'ACTIVE', deadline: { not: null } },
      include: {
        project: { include: { module: { select: { title: true, courseId: true } } } },
        schedule: { include: { course: { select: { name: true } } } },
        submissions: { select: { studentId: true } },
      },
    });
    for (const release of projectReleases) {
      const daysBefore = daysUntil(release.deadline!);
      if (!DAYS_TO_REMIND.includes(daysBefore)) continue;

      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { scheduleId: release.scheduleId, status: 'ACTIVE' },
        include: { student: { select: { id: true, firstName: true, lastName: true, email: true } } },
      });
      const submittedIds = new Set(release.submissions.map((s) => s.studentId));
      const notSubmitted = enrollments
        .filter((e) => !submittedIds.has(e.student.id))
        .map((e) => ({ id: e.student.id, name: `${e.student.firstName} ${e.student.lastName}`, email: e.student.email }));

      totalSent += await sendReminders(
        'PROJECT',
        release.id,
        daysBefore,
        release.deadline!,
        'Project',
        release.project.title,
        release.schedule.course.name,
        notSubmitted
      );
    }

    // ── Feedback Forms ───────────────────────────────────────────────────
    const formReleases = await prisma.feedbackFormRelease.findMany({
      where: { status: 'ACTIVE', deadline: { not: null } },
      include: {
        form: true,
        schedule: { include: { course: { select: { name: true } } } },
        responses: { select: { studentId: true } },
      },
    });
    for (const release of formReleases) {
      const daysBefore = daysUntil(release.deadline!);
      if (!DAYS_TO_REMIND.includes(daysBefore)) continue;

      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { scheduleId: release.scheduleId, status: 'ACTIVE' },
        include: { student: { select: { id: true, firstName: true, lastName: true, email: true } } },
      });
      const respondedIds = new Set(release.responses.map((r) => r.studentId));
      const notSubmitted = enrollments
        .filter((e) => !respondedIds.has(e.student.id))
        .map((e) => ({ id: e.student.id, name: `${e.student.firstName} ${e.student.lastName}`, email: e.student.email }));

      totalSent += await sendReminders(
        'FEEDBACK_FORM',
        release.id,
        daysBefore,
        release.deadline!,
        'Feedback Form',
        release.form.title,
        release.schedule.course.name,
        notSubmitted
      );
    }

    // ── Online Tests ─────────────────────────────────────────────────────
    const testReleases = await prisma.onlineTestRelease.findMany({
      where: { status: 'ACTIVE', deadline: { not: null } },
      include: {
        test: true,
        schedule: { include: { course: { select: { name: true } } } },
        attempts: { select: { studentId: true, status: true } },
      },
    });
    for (const release of testReleases) {
      const daysBefore = daysUntil(release.deadline!);
      if (!DAYS_TO_REMIND.includes(daysBefore)) continue;

      const enrollments = await prisma.studentBatchEnrollment.findMany({
        where: { scheduleId: release.scheduleId, status: 'ACTIVE' },
        include: { student: { select: { id: true, firstName: true, lastName: true, email: true } } },
      });
      // A student counts as "submitted" only if they have a completed attempt
      // (SUBMITTED / AUTO_SUBMITTED_VIOLATION / EXPIRED). IN_PROGRESS still
      // needs a reminder since they haven't actually finished.
      const completedIds = new Set(
        release.attempts.filter((a) => a.status !== 'IN_PROGRESS').map((a) => a.studentId)
      );
      const notSubmitted = enrollments
        .filter((e) => !completedIds.has(e.student.id))
        .map((e) => ({ id: e.student.id, name: `${e.student.firstName} ${e.student.lastName}`, email: e.student.email }));

      totalSent += await sendReminders(
        'ONLINE_TEST',
        release.id,
        daysBefore,
        release.deadline!,
        'Online Test',
        release.test.title,
        release.schedule.course.name,
        notSubmitted
      );
    }

    return { sent: totalSent };
  },
};
