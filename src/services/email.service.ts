import nodemailer from 'nodemailer';
import { config } from '../config/env';
import prisma from '../config/database';

const transporter = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_PORT === 465,
  auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
});

export interface EmailOptions {
  to: string | string[];
  subject: string;
  html: string;
  template?: string;
}

export const emailService = {
  async send(opts: EmailOptions) {
    try {
      await transporter.sendMail({
        from: `"HRMS" <${config.EMAIL_FROM}>`,
        to: Array.isArray(opts.to) ? opts.to.join(', ') : opts.to,
        subject: opts.subject,
        html: opts.html,
      });
      await prisma.emailLog.create({
        data: {
          to: Array.isArray(opts.to) ? opts.to.join(', ') : opts.to,
          from: config.EMAIL_FROM,
          subject: opts.subject,
          template: opts.template,
          status: 'SENT',
        },
      });
    } catch (error: unknown) {
      await prisma.emailLog.create({
        data: {
          to: Array.isArray(opts.to) ? opts.to.join(', ') : opts.to,
          from: config.EMAIL_FROM,
          subject: opts.subject,
          template: opts.template,
          status: 'FAILED',
          errorMsg: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }
  },

  templates: {
    leaveApplied: (data: { employeeName: string; leaveType: string; startDate: string; endDate: string; days: number }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;">
        <h2 style="color:#1e40af;">Leave Request Submitted</h2>
        <p>Dear Manager,</p>
        <p><strong>${data.employeeName}</strong> has applied for leave:</p>
        <table style="width:100%;border-collapse:collapse;">
          <tr><td style="padding:8px;border:1px solid #e5e7eb;"><strong>Leave Type</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.leaveType}</td></tr>
          <tr><td style="padding:8px;border:1px solid #e5e7eb;"><strong>From</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.startDate}</td></tr>
          <tr><td style="padding:8px;border:1px solid #e5e7eb;"><strong>To</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.endDate}</td></tr>
          <tr><td style="padding:8px;border:1px solid #e5e7eb;"><strong>Days</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.days}</td></tr>
        </table>
        <p>Please log in to the HRMS portal to review.</p>
      </div>`,

    leaveApproved: (data: { employeeName: string; leaveType: string; startDate: string; endDate: string }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;">
        <h2 style="color:#16a34a;">Leave Approved ✓</h2>
        <p>Dear ${data.employeeName},</p>
        <p>Your <strong>${data.leaveType}</strong> from <strong>${data.startDate}</strong> to <strong>${data.endDate}</strong> has been <span style="color:#16a34a;">approved</span>.</p>
      </div>`,

    leaveRejected: (data: { employeeName: string; leaveType: string; reason?: string }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;">
        <h2 style="color:#dc2626;">Leave Rejected</h2>
        <p>Dear ${data.employeeName},</p>
        <p>Your <strong>${data.leaveType}</strong> request has been rejected.</p>
        ${data.reason ? `<p><strong>Reason:</strong> ${data.reason}</p>` : ''}
      </div>`,

    welcomeEmployee: (data: { firstName: string; email: string; password: string; loginUrl: string }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#1e40af;padding:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">Welcome to the Team! 🎉</h1>
        </div>
        <div style="padding:24px;">
          <p>Dear ${data.firstName},</p>
          <p>Your HRMS account has been created by HR. You can now log in to access your profile, payslips, attendance, and more.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Login Email</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.email}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Temporary Password</strong></td><td style="padding:8px;border:1px solid #e5e7eb;font-family:monospace;font-size:16px;letter-spacing:2px;">${data.password}</td></tr>
          </table>
          <p style="background:#fef3c7;padding:12px;border-radius:6px;border-left:4px solid #f59e0b;">
            <strong>Action Required:</strong> Please log in and change your password immediately after your first login.
          </p>
          <p style="text-align:center;margin:20px 0;">
            <a href="${data.loginUrl}" style="background:#1e40af;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">Log In to HRMS &rarr;</a>
          </p>
          <p style="color:#6b7280;font-size:12px;">If you have any trouble logging in, please contact your HR team.</p>
        </div>
      </div>`,

    hrPasswordReset: (data: { firstName: string; email: string; newPassword: string; loginUrl: string; resetBy: string }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#0f766e;padding:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">Your Password Has Been Reset 🔑</h1>
        </div>
        <div style="padding:24px;">
          <p>Dear ${data.firstName},</p>
          <p>Your HRMS account password has been reset by <strong>${data.resetBy}</strong>. Your new login credentials are:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Login Email</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.email}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>New Password</strong></td><td style="padding:8px;border:1px solid #e5e7eb;font-family:monospace;font-size:16px;letter-spacing:2px;">${data.newPassword}</td></tr>
          </table>
          <p style="background:#fef3c7;padding:12px;border-radius:6px;border-left:4px solid #f59e0b;">
            <strong>Action Required:</strong> Please log in and change your password immediately.
          </p>
          <p style="text-align:center;margin:20px 0;">
            <a href="${data.loginUrl}" style="background:#0f766e;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;display:inline-block;">Log In to HRMS &rarr;</a>
          </p>
          <p style="color:#6b7280;font-size:12px;">If you did not expect this reset, please contact HR immediately.</p>
        </div>
      </div>`,

    payrollGenerated: (data: { firstName: string; month: string; year: number; netSalary: number }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;">
        <h2 style="color:#1e40af;">Payslip Generated</h2>
        <p>Dear ${data.firstName},</p>
        <p>Your payslip for <strong>${data.month} ${data.year}</strong> has been generated.</p>
        <p><strong>Net Salary:</strong> ₹${data.netSalary.toLocaleString()}</p>
        <p>Login to the portal to download your payslip.</p>
      </div>`,

    onboardingWelcome: (data: { name: string; email: string; tempPassword: string; onboardingId: string; joiningDate: string }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#1e40af;padding:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">Welcome to the Team! 🎉</h1>
        </div>
        <div style="padding:24px;">
          <p>Dear ${data.name},</p>
          <p>We are delighted to have you join us. Your account has been created and you can now access the HR portal.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Login Email</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.email}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Temporary Password</strong></td><td style="padding:8px;border:1px solid #e5e7eb;font-family:monospace;font-size:16px;">${data.tempPassword}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Joining Date</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.joiningDate}</td></tr>
          </table>
          <p style="background:#fef3c7;padding:12px;border-radius:6px;border-left:4px solid #f59e0b;">
            <strong>Action Required:</strong> Please log in and sign your onboarding documents to complete your onboarding. Change your password after first login.
          </p>
          <p style="color:#6b7280;font-size:12px;">If you have questions, please contact HR.</p>
        </div>
      </div>`,

    birthdayWish: (data: { recipientName: string; celebrantName: string }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:linear-gradient(135deg,#ec4899,#8b5cf6);padding:24px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:24px;">🎉 Happy Birthday, ${data.celebrantName}! 🎂</h1>
        </div>
        <div style="padding:24px;">
          <p>Dear ${data.recipientName},</p>
          <p>Today is a special day — please join us in wishing <strong>${data.celebrantName}</strong> a very Happy Birthday! 🎈</p>
          <p>Let's take a moment to celebrate and make their day extra special.</p>
          <p style="background:#fdf2f8;padding:12px;border-radius:6px;border-left:4px solid #ec4899;">
            Wishing you a fantastic year ahead, filled with success and happiness!
          </p>
          <p style="color:#6b7280;font-size:12px;">— With wishes from the entire team</p>
        </div>
      </div>`,

    resignationNotice: (data: { recipientName: string; empName: string; reason: string; requestedLastDate: string; role: string }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#dc2626;padding:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">Resignation Notice</h1>
        </div>
        <div style="padding:24px;">
          <p>Dear ${data.recipientName},</p>
          <p>This is to inform you that <strong>${data.empName}</strong> has submitted a formal resignation.</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Employee</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.empName}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Requested Last Date</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.requestedLastDate}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Reason</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.reason}</td></tr>
          </table>
          <p>Please log in to the HRMS portal to review and ${data.role === 'manager' ? 'approve/reject the resignation and set the final last working date' : 'process this resignation request'}.</p>
        </div>
      </div>`,

    projectReleased: (data: { studentName: string; projectTitle: string; moduleTitle: string; courseName: string; deadline?: string | null }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#1e40af;padding:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">New Project Released 📋</h1>
        </div>
        <div style="padding:24px;">
          <p>Dear ${data.studentName},</p>
          <p>A new project has been released for your <strong>${data.courseName}</strong> training:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Project</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.projectTitle}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Module</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.moduleTitle}</td></tr>
            ${data.deadline ? `<tr><td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>Deadline</strong></td><td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>${data.deadline}</strong></td></tr>` : ''}
          </table>
          <p>Please log in to the student portal to view the project brief and submit your work${data.deadline ? ' before the deadline above' : ''}.</p>
        </div>
      </div>`,

    feedbackFormReleased: (data: { studentName: string; formTitle: string; moduleTitle: string; courseName: string; deadline?: string | null }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#1e40af;padding:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">Feedback Form Available 📝</h1>
        </div>
        <div style="padding:24px;">
          <p>Dear ${data.studentName},</p>
          <p>A feedback form has been released for your <strong>${data.courseName}</strong> training:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Form</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.formTitle}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Module</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.moduleTitle}</td></tr>
            ${data.deadline ? `<tr><td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>Deadline</strong></td><td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>${data.deadline}</strong></td></tr>` : ''}
          </table>
          <p>Please log in to the student portal to fill it out${data.deadline ? ' before the deadline above' : ''}.</p>
        </div>
      </div>`,

    testActivated: (data: { studentName: string; testTitle: string; moduleTitle: string; courseName: string; durationMinutes: number; deadline?: string | null }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#1e40af;padding:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">Online Test Activated 🧪</h1>
        </div>
        <div style="padding:24px;">
          <p>Dear ${data.studentName},</p>
          <p>An online test has been activated for your <strong>${data.courseName}</strong> training:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Test</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.testTitle}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Module</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.moduleTitle}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Duration</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.durationMinutes} minutes once started</td></tr>
            ${data.deadline ? `<tr><td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>Available Until</strong></td><td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>${data.deadline}</strong></td></tr>` : ''}
          </table>
          <p>Please log in to the student portal to start the test${data.deadline ? ' before the deadline above' : ''}. Your timer starts the moment you click Start.</p>
        </div>
      </div>`,

    // Sent to the Production Manager + assigned trainer(s) alongside the student emails above.
    staffReleaseNotice: (data: { recipientName: string; kindLabel: string; title: string; courseName: string; scheduleLabel: string; deadline?: string | null; studentCount: number }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#0f766e;padding:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">${data.kindLabel} Released</h1>
        </div>
        <div style="padding:24px;">
          <p>Dear ${data.recipientName},</p>
          <p><strong>${data.title}</strong> was just released to <strong>${data.studentCount}</strong> student(s) in:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Course</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.courseName}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Schedule</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.scheduleLabel}</td></tr>
            ${data.deadline ? `<tr><td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>Deadline</strong></td><td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>${data.deadline}</strong></td></tr>` : ''}
          </table>
          <p style="color:#6b7280;font-size:12px;">You're receiving this as the Production Manager or assigned trainer for this batch.</p>
        </div>
      </div>`,

    // 3 / 2 / 1 day-before-deadline reminder, sent only to students who haven't submitted yet.
    deadlineReminder: (data: { studentName: string; kindLabel: string; title: string; courseName: string; deadline: string; daysLeft: number }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#dc2626;padding:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">⏰ ${data.daysLeft} day${data.daysLeft === 1 ? '' : 's'} left!</h1>
        </div>
        <div style="padding:24px;">
          <p>Dear ${data.studentName},</p>
          <p>This is a reminder that you have not yet submitted the following ${data.kindLabel.toLowerCase()} for <strong>${data.courseName}</strong>:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>${data.kindLabel}</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.title}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>Deadline</strong></td><td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>${data.deadline}</strong></td></tr>
          </table>
          <p style="background:#fef2f2;padding:12px;border-radius:6px;border-left:4px solid #dc2626;">
            Please log in to the student portal and submit before the deadline to avoid missing out.
          </p>
        </div>
      </div>`,

    dailyAttendanceReport: (data: {
      dateLabel: string;
      rows: { scheduleLabel: string; courseName: string; present: number; absent: number; total: number }[];
      absentees: { studentName: string; studentCode: string; scheduleLabel: string }[];
    }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#2563eb;padding:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">📋 Daily Attendance Report</h1>
          <p style="color:#dbeafe;margin:4px 0 0;">${data.dateLabel}</p>
        </div>
        <div style="padding:24px;">
          <p>Attendance summary for <strong>${data.dateLabel}</strong> across all active batches:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr>
              <td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Batch / Schedule</strong></td>
              <td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Course</strong></td>
              <td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Present</strong></td>
              <td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Absent</strong></td>
              <td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Total</strong></td>
            </tr>
            ${data.rows
              .map(
                (r) => `<tr>
              <td style="padding:8px;border:1px solid #e5e7eb;">${r.scheduleLabel}</td>
              <td style="padding:8px;border:1px solid #e5e7eb;">${r.courseName}</td>
              <td style="padding:8px;border:1px solid #e5e7eb;">${r.present}</td>
              <td style="padding:8px;border:1px solid #e5e7eb;">${r.absent}</td>
              <td style="padding:8px;border:1px solid #e5e7eb;">${r.total}</td>
            </tr>`
              )
              .join('')}
          </table>
          ${
            data.absentees.length
              ? `<p style="margin-top:24px;"><strong>Absentees (${data.absentees.length}):</strong></p>
          <table style="width:100%;border-collapse:collapse;margin:8px 0;">
            <tr>
              <td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>Student</strong></td>
              <td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>Student Code</strong></td>
              <td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>Batch / Schedule</strong></td>
            </tr>
            ${data.absentees
              .map(
                (a) => `<tr>
              <td style="padding:8px;border:1px solid #e5e7eb;">${a.studentName}</td>
              <td style="padding:8px;border:1px solid #e5e7eb;">${a.studentCode}</td>
              <td style="padding:8px;border:1px solid #e5e7eb;">${a.scheduleLabel}</td>
            </tr>`
              )
              .join('')}
          </table>`
              : `<p style="background:#f0fdf4;padding:12px;border-radius:6px;border-left:4px solid #16a34a;">No absences recorded for this day. 🎉</p>`
          }
        </div>
      </div>`,

    attendanceEscalation: (data: {
      studentName: string;
      studentCode: string;
      scheduleLabel: string;
      courseName: string;
      consecutiveDays: number;
      lastAbsentDate: string;
    }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#dc2626;padding:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">🚨 ${data.consecutiveDays}-Day Absence Escalation</h1>
        </div>
        <div style="padding:24px;">
          <p>The following student has been marked <strong>absent for ${data.consecutiveDays} consecutive training days</strong> and requires follow-up:</p>
          <table style="width:100%;border-collapse:collapse;margin:16px 0;">
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Student</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.studentName}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Student Code</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.studentCode}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Batch / Schedule</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.scheduleLabel}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#f9fafb;"><strong>Course</strong></td><td style="padding:8px;border:1px solid #e5e7eb;">${data.courseName}</td></tr>
            <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>Last Absent Date</strong></td><td style="padding:8px;border:1px solid #e5e7eb;background:#fef3c7;"><strong>${data.lastAbsentDate}</strong></td></tr>
          </table>
          <p style="background:#fef2f2;padding:12px;border-radius:6px;border-left:4px solid #dc2626;">
            Please reach out to the student and/or escalate per the standard attendance follow-up process.
          </p>
        </div>
      </div>`,
  },
};
