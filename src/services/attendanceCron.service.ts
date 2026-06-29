import prisma from '../config/database';
import { emailService } from './email.service';

// ── Shared recipient helper ─────────────────────────────────────────────────
// "Management" = anyone with EDIT access on the Production/Training module
// (Production Managers). Used as the always-included audience for escalation
// emails, per the ReportRecipientType.ESCALATION schema comment ("in addition
// to management"). Schedule-agnostic (unlike trainerPortal's
// getStaffRecipients, which is scoped to one schedule) since these crons run
// globally across all schedules.
async function getProductionManagers(): Promise<{ name: string; email: string }[]> {
  const managerGrants = await prisma.userModuleAccess.findMany({
    where: { module: 'PRODUCTION_TRAINING', accessLevel: 'EDIT' },
    include: { user: { include: { employee: true } } },
  });

  const recipients = new Map<string, { name: string; email: string }>();
  for (const g of managerGrants) {
    const emp = g.user.employee;
    const email = emp?.email || g.user.email;
    if (email) {
      recipients.set(email, { name: emp ? `${emp.firstName} ${emp.lastName}` : g.user.email, email });
    }
  }
  return Array.from(recipients.values());
}

async function getConfiguredRecipients(type: 'DAILY_ATTENDANCE' | 'ESCALATION'): Promise<{ name: string | null; email: string }[]> {
  const rows = await prisma.reportRecipient.findMany({ where: { type } });
  return rows.map((r: { name: string | null; email: string }) => ({ name: r.name, email: r.email }));
}

function startOfDay(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function formatDateLabel(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}

export const attendanceCronService = {
  /**
   * Sends a daily attendance summary (for "yesterday") to everyone configured
   * as a DAILY_ATTENDANCE report recipient. Only schedules that actually have
   * attendance records marked for that date are included (so weekends/off-days
   * with no marked attendance are silently skipped — there's no WEEKEND/HOLIDAY
   * status on StudentAttendance, unlike the employee-side Attendance model).
   */
  async sendDailyAttendanceReport(): Promise<{ sent: number; schedulesReported: number }> {
    const recipients = await getConfiguredRecipients('DAILY_ATTENDANCE');
    if (recipients.length === 0) return { sent: 0, schedulesReported: 0 };

    const yesterday = startOfDay(new Date());
    yesterday.setDate(yesterday.getDate() - 1);
    const dayStart = yesterday;
    const dayEnd = new Date(yesterday);
    dayEnd.setHours(23, 59, 59, 999);

    const attendances = await prisma.studentAttendance.findMany({
      where: { date: { gte: dayStart, lte: dayEnd } },
      include: {
        student: { select: { firstName: true, lastName: true, studentCode: true } },
        schedule: { select: { id: true, batch: { select: { code: true } }, course: { select: { name: true } } } },
      },
    });

    if (attendances.length === 0) return { sent: 0, schedulesReported: 0 };

    const byScheduleId = new Map<string, typeof attendances>();
    for (const a of attendances) {
      if (!byScheduleId.has(a.scheduleId)) byScheduleId.set(a.scheduleId, []);
      byScheduleId.get(a.scheduleId)!.push(a);
    }

    const rows: { scheduleLabel: string; courseName: string; present: number; absent: number; total: number }[] = [];
    const absentees: { studentName: string; studentCode: string; scheduleLabel: string }[] = [];

    for (const [, records] of byScheduleId) {
      const first = records[0];
      const scheduleLabel = first.schedule.batch.code;
      const courseName = first.schedule.course.name;
      const present = records.filter((r) => r.status === 'PRESENT' || r.status === 'LATE').length;
      const absent = records.filter((r) => r.status === 'ABSENT').length;
      rows.push({ scheduleLabel, courseName, present, absent, total: records.length });

      for (const r of records.filter((r) => r.status === 'ABSENT')) {
        absentees.push({
          studentName: `${r.student.firstName} ${r.student.lastName}`,
          studentCode: r.student.studentCode,
          scheduleLabel,
        });
      }
    }

    const dateLabel = formatDateLabel(yesterday);
    const html = emailService.templates.dailyAttendanceReport({ dateLabel, rows, absentees });

    await emailService.send({
      to: recipients.map((r) => r.email),
      subject: `Daily Attendance Report — ${dateLabel}`,
      html,
      template: 'dailyAttendanceReport',
    });

    return { sent: recipients.length, schedulesReported: byScheduleId.size };
  },

  /**
   * Checks every active enrollment for a current consecutive-ABSENT streak
   * (counting back from the most recent marked training day, not calendar
   * days) and fires a one-time escalation email the moment the streak hits
   * exactly 2 or exactly 3 days. Dedup is enforced via AttendanceEscalationLog
   * keyed on (student, schedule, streak length, most-recent-absent-date) so a
   * re-run (or daily re-check while the streak holds steady) never double-sends.
   */
  async checkConsecutiveAbsenceEscalations(): Promise<{ sent: number; flagged: number }> {
    const [escalationRecipients, managers] = await Promise.all([
      getConfiguredRecipients('ESCALATION'),
      getProductionManagers(),
    ]);

    const recipientEmails = new Map<string, true>();
    for (const r of [...escalationRecipients, ...managers]) recipientEmails.set(r.email, true);
    const toList = Array.from(recipientEmails.keys());
    if (toList.length === 0) return { sent: 0, flagged: 0 };

    const enrollments = await prisma.studentBatchEnrollment.findMany({
      where: { status: 'ACTIVE' },
      include: {
        student: { select: { firstName: true, lastName: true, studentCode: true } },
        schedule: { select: { id: true, batch: { select: { code: true } }, course: { select: { name: true } } } },
      },
    });

    let sent = 0;
    let flagged = 0;

    for (const enr of enrollments) {
      const recent = await prisma.studentAttendance.findMany({
        where: { studentId: enr.studentId, scheduleId: enr.scheduleId },
        orderBy: { date: 'desc' },
        take: 5,
      });

      let streak = 0;
      for (const r of recent) {
        if (r.status === 'ABSENT') streak++;
        else break;
      }

      if (streak !== 2 && streak !== 3) continue;
      flagged++;

      const asOfDate = startOfDay(recent[0].date);
      const existing = await prisma.attendanceEscalationLog.findUnique({
        where: {
          studentId_scheduleId_consecutiveDays_asOfDate: {
            studentId: enr.studentId,
            scheduleId: enr.scheduleId,
            consecutiveDays: streak,
            asOfDate,
          },
        },
      });
      if (existing) continue;

      const html = emailService.templates.attendanceEscalation({
        studentName: `${enr.student.firstName} ${enr.student.lastName}`,
        studentCode: enr.student.studentCode,
        scheduleLabel: enr.schedule.batch.code,
        courseName: enr.schedule.course.name,
        consecutiveDays: streak,
        lastAbsentDate: formatDateLabel(asOfDate),
      });

      await emailService.send({
        to: toList,
        subject: `🚨 ${streak}-Day Absence Escalation — ${enr.student.firstName} ${enr.student.lastName}`,
        html,
        template: 'attendanceEscalation',
      });

      await prisma.attendanceEscalationLog.create({
        data: { studentId: enr.studentId, scheduleId: enr.scheduleId, consecutiveDays: streak, asOfDate },
      });

      sent++;
    }

    return { sent, flagged };
  },

  /**
   * Daily ACTIVE ↔ INACTIVE sync, driven purely by lifetime attendance %.
   * For every student currently ACTIVE or INACTIVE, computes
   * (PRESENT + LATE) / total marked attendance records across all their
   * schedules. Below 60% → INACTIVE; at or above 60% → ACTIVE. Students with
   * no attendance records yet are left untouched (they shouldn't be in
   * ACTIVE/INACTIVE in the first place — that transition is owned by
   * markAttendance — but this guards against edge cases either way).
   * Never touches ENROLLED/ONBOARDED/COMPLETED/IN_PLACEMENT/PLACED/
   * BATCH_TRANSFER students.
   */
  async syncStudentStatusByAttendance(): Promise<{ toInactive: number; toActive: number; checked: number }> {
    const students = await prisma.student.findMany({
      where: { status: { in: ['ACTIVE', 'INACTIVE'] } },
      select: { id: true, status: true },
    });
    if (!students.length) return { toInactive: 0, toActive: 0, checked: 0 };

    let toInactive = 0;
    let toActive = 0;

    for (const s of students) {
      const records = await prisma.studentAttendance.findMany({
        where: { studentId: s.id },
        select: { status: true },
      });
      if (!records.length) continue;

      const presentOrLate = records.filter((r) => r.status === 'PRESENT' || r.status === 'LATE').length;
      const pct = (presentOrLate / records.length) * 100;

      if (pct < 60 && s.status === 'ACTIVE') {
        await prisma.student.update({ where: { id: s.id }, data: { status: 'INACTIVE' } });
        toInactive++;
      } else if (pct >= 60 && s.status === 'INACTIVE') {
        await prisma.student.update({ where: { id: s.id }, data: { status: 'ACTIVE' } });
        toActive++;
      }
    }

    return { toInactive, toActive, checked: students.length };
  },
};
