import nodemailer from 'nodemailer';
import { config } from '../config/env';
import prisma from '../config/database';

const transporter = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_PORT === 465,
  auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
});

export interface EmailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface EmailOptions {
  to: string | string[];
  cc?: string | string[];
  bcc?: string | string[];
  subject: string;
  html: string;
  template?: string;
  attachments?: EmailAttachment[];
}

export const emailService = {
  async send(opts: EmailOptions) {
    try {
      await transporter.sendMail({
        from: `"Vin-Source Portal" <${config.EMAIL_FROM}>`,
        to: Array.isArray(opts.to) ? opts.to.join(', ') : opts.to,
        cc: opts.cc ? (Array.isArray(opts.cc) ? opts.cc.join(', ') : opts.cc) : undefined,
        bcc: opts.bcc ? (Array.isArray(opts.bcc) ? opts.bcc.join(', ') : opts.bcc) : undefined,
        subject: opts.subject,
        html: opts.html,
        attachments: opts.attachments?.map((a) => ({
          filename: a.filename,
          content: a.content,
          contentType: a.contentType ?? 'application/pdf',
        })),
      });
      await prisma.emailLog.create({
        data: {
          to:
            (Array.isArray(opts.to) ? opts.to.join(', ') : opts.to) +
            (opts.bcc ? ` | bcc: ${Array.isArray(opts.bcc) ? opts.bcc.length + ' recipients' : opts.bcc}` : ''),
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
        <div style="background:#1e3a8a;padding:28px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:24px;letter-spacing:1px;">Vin-Source Portal</h1>
          <p style="color:#93c5fd;margin:6px 0 0;font-size:13px;">Vinsup Skill Academy — HR & Operations</p>
        </div>
        <div style="padding:28px;">
          <h2 style="color:#1e3a8a;margin-top:0;">Welcome to the Team, ${data.firstName}! 🎉</h2>
          <p>Your employee account has been created on the <strong>Vin-Source Portal</strong>. You can now log in to access your profile, attendance, payslips, and more.</p>

          <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 8px;font-weight:600;color:#0369a1;">Your Login Credentials</p>
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:4px 0 0 0;"><strong>Portal URL</strong></td><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;"><a href="${data.loginUrl}" style="color:#1e40af;">${data.loginUrl}</a></td></tr>
              <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;"><strong>Email (Username)</strong></td><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;">${data.email}</td></tr>
              <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;border-radius:0 0 0 4px;"><strong>Temporary Password</strong></td><td style="padding:8px 12px;background:#fffbeb;border:1px solid #e5e7eb;font-family:monospace;font-size:16px;letter-spacing:3px;font-weight:700;color:#92400e;">${data.password}</td></tr>
            </table>
          </div>

          <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:14px;border-radius:0 6px 6px 0;margin:20px 0;">
            <p style="margin:0;font-weight:700;color:#92400e;">⚠️ Important: Change Your Password on First Login</p>
            <p style="margin:8px 0 0;color:#78350f;font-size:14px;">Your temporary password must be changed immediately. You will be prompted automatically.</p>
          </div>

          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 10px;font-weight:700;color:#374151;">How to Change Your Password:</p>
            <ol style="margin:0;padding-left:20px;color:#374151;font-size:14px;line-height:1.8;">
              <li>Click the <strong>Sign In</strong> button below and log in with the credentials above.</li>
              <li>You will be automatically taken to the <strong>Change Password</strong> screen.</li>
              <li>Enter your temporary password in the <em>Current Password</em> field.</li>
              <li>Enter your new password (minimum 6 characters) in the <em>New Password</em> field.</li>
              <li>Re-enter your new password to confirm.</li>
              <li>Click <strong>Update Password</strong>. You're done!</li>
            </ol>
            <p style="margin:10px 0 0;font-size:13px;color:#6b7280;">You can also change your password anytime from your <strong>Profile → Security</strong> section.</p>
          </div>

          <p style="text-align:center;margin:24px 0;">
            <a href="${data.loginUrl}" style="background:#1e3a8a;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;font-size:15px;">Sign In to Vin-Source Portal →</a>
          </p>

          <p style="color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:14px;margin-top:20px;">
            If you have trouble logging in, please contact HR at <a href="mailto:operation@vinsupskillacademy.com" style="color:#1e40af;">operation@vinsupskillacademy.com</a><br/>
            This is an automated message from the Vin-Source Portal.
          </p>
        </div>
      </div>`,

    passwordChangeReminder: (data: { firstName: string; email: string; loginUrl: string }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#dc2626;padding:24px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:22px;">⚠️ Password Change Required</h1>
          <p style="color:#fca5a5;margin:6px 0 0;font-size:13px;">Vin-Source Portal — Vinsup Skill Academy</p>
        </div>
        <div style="padding:28px;">
          <p>Dear <strong>${data.firstName}</strong>,</p>
          <p>This is a reminder that your <strong>Vin-Source Portal</strong> account still has a temporary password. For the security of your account, please log in and change it today.</p>

          <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 6px;font-weight:700;color:#991b1b;">Your account is at risk until you change your password.</p>
            <p style="margin:0;font-size:14px;color:#7f1d1d;">Login Email: <strong>${data.email}</strong></p>
          </div>

          <div style="background:#f9fafb;border:1px solid #e5e7eb;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 10px;font-weight:700;color:#374151;">Steps to Change Your Password:</p>
            <ol style="margin:0;padding-left:20px;color:#374151;font-size:14px;line-height:1.8;">
              <li>Click <strong>Sign In</strong> below and log in with your current credentials.</li>
              <li>Go to your <strong>Profile</strong> (top-right corner, click your name).</li>
              <li>Click <strong>Security</strong> or you will be prompted automatically.</li>
              <li>Enter your current password, then your new password.</li>
              <li>Click <strong>Update Password</strong>.</li>
            </ol>
          </div>

          <p style="text-align:center;margin:24px 0;">
            <a href="${data.loginUrl}" style="background:#dc2626;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;font-size:15px;">Change My Password Now →</a>
          </p>

          <p style="background:#fef3c7;padding:12px;border-radius:6px;font-size:13px;color:#92400e;">
            You will receive this reminder every day until your password is changed.
          </p>

          <p style="color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:14px;margin-top:20px;">
            Need help? Contact HR at <a href="mailto:operation@vinsupskillacademy.com" style="color:#1e40af;">operation@vinsupskillacademy.com</a>
          </p>
        </div>
      </div>`,

    passwordResetEmail: (data: { firstName: string; resetUrl: string }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#1e3a8a;padding:28px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:24px;">Vin-Source Portal</h1>
          <p style="color:#93c5fd;margin:6px 0 0;font-size:13px;">Password Reset Request</p>
        </div>
        <div style="padding:28px;">
          <h2 style="color:#1e3a8a;margin-top:0;">Reset Your Password 🔒</h2>
          <p>Dear <strong>${data.firstName}</strong>,</p>
          <p>We received a request to reset your Vin-Source Portal password. Click the button below to set a new password. This link is valid for <strong>1 hour</strong>.</p>

          <p style="text-align:center;margin:28px 0;">
            <a href="${data.resetUrl}" style="background:#1e3a8a;color:#fff;padding:14px 32px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;font-size:15px;">Reset My Password →</a>
          </p>

          <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:14px;border-radius:0 6px 6px 0;margin:20px 0;">
            <p style="margin:0;font-size:13px;color:#92400e;">If you did not request a password reset, you can safely ignore this email. Your password will not change.</p>
          </div>

          <p style="color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:14px;margin-top:20px;">
            This link will expire in 1 hour. If you need help, contact HR at <a href="mailto:operation@vinsupskillacademy.com" style="color:#1e40af;">operation@vinsupskillacademy.com</a>
          </p>
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

    birthdayWish: (data: { celebrantName: string; celebrantFirstName: string; photoUrl?: string | null; messageLine?: string; logoUrl?: string }) => `
      <div style="font-family:Georgia,'Times New Roman',serif;max-width:620px;margin:auto;">
        <div style="font-family:Arial,Helvetica,sans-serif;padding:0 4px 18px;">
          <p style="margin:0 0 14px;">Dear ${data.celebrantFirstName},</p>
          <p style="margin:0 0 6px;">Wishing you a wonderful <strong>birthday</strong> filled with joy, laughter, and everything you love the most.</p>
          <p style="margin:0 0 14px;">May the year ahead open doors to new achievements, meaningful experiences, and moments you'll cherish forever.</p>
          <p style="margin:0;">Happy <strong>Birthday</strong> once again!</p>
        </div>

        <!-- Birthday card -->
        <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f7f8fa;border:1px solid #e5e7eb;border-radius:4px;">
          <tr>
            <!-- Photo panel -->
            <td width="45%" valign="top" style="padding:26px 0 26px 26px;">
              <table role="presentation" cellpadding="0" cellspacing="0" width="100%">
                <tr><td style="background:#1e3a8a;padding:6px;">
                  ${data.photoUrl
                    ? `<img src="${data.photoUrl}" alt="${data.celebrantName}" width="230" style="display:block;width:100%;max-width:230px;height:auto;background:#fff;" />`
                    : `<div style="background:#e8edf7;text-align:center;padding:70px 10px;color:#1e3a8a;font-size:64px;font-weight:bold;font-family:Arial,sans-serif;">${data.celebrantFirstName.charAt(0).toUpperCase()}</div>`}
                </td></tr>
                <tr><td style="background:#1e3a8a;text-align:center;padding:8px 6px;">
                  <span style="color:#ffffff;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;letter-spacing:0.5px;">${data.celebrantName}</span>
                </td></tr>
              </table>
            </td>
            <!-- Message panel -->
            <td width="55%" valign="top" style="padding:26px;">
              <p style="text-align:right;margin:0 0 18px;font-family:Arial,sans-serif;">
                ${data.logoUrl
                  ? `<img src="${data.logoUrl}" alt="Vinsup Skill Academy" height="42" style="height:42px;width:auto;display:inline-block;" />`
                  : `<span style="display:inline-block;background:#1e3a8a;color:#fff;font-weight:bold;font-size:14px;letter-spacing:1px;padding:6px 12px;border-radius:3px;">VINSUP<br/><span style="font-size:8px;letter-spacing:2px;">SKILL ACADEMY</span></span>`}
              </p>
              <p style="font-family:'Brush Script MT',cursive;color:#1e3a8a;font-size:30px;margin:0;line-height:1.1;">Happy</p>
              <p style="font-family:'Brush Script MT',cursive;color:#1e3a8a;font-size:48px;margin:0 0 18px;line-height:1.1;">Birthday</p>
              <p style="font-family:Arial,sans-serif;color:#374151;font-size:12.5px;line-height:1.7;margin:0;">
                ${data.messageLine || 'Wishing a very happy birthday to a valued member of our team. Your dedication, energy, and contribution inspire everyone around you. Have an amazing day and an even better year ahead!'}
              </p>
              <p style="font-size:26px;margin:16px 0 0;">🎉🎊</p>
            </td>
          </tr>
        </table>

        <p style="font-family:Arial,sans-serif;color:#6b7280;font-size:12px;margin:16px 4px 0;">— With warm wishes from everyone at Vinsup Skill Academy</p>
      </div>`,

    studentWelcome: (data: { name: string; studentCode: string; email: string; loginUrl: string; batchLine?: string; logoUrl?: string }) => `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#1e3a8a;padding:24px;text-align:center;">
          ${data.logoUrl ? `<img src="${data.logoUrl}" alt="Vinsup Skill Academy" height="40" style="height:40px;width:auto;display:inline-block;background:#fff;padding:4px 10px;border-radius:6px;margin-bottom:10px;" /><br/>` : ''}
          <h1 style="color:#fff;margin:0;font-size:22px;">🎓 Welcome to Vinsup Skill Academy!</h1>
          <p style="color:#93c5fd;margin:6px 0 0;font-size:13px;">Your student portal account is ready</p>
        </div>
        <div style="padding:26px;">
          <p>Dear <strong>${data.name}</strong>,</p>
          <p>Congratulations on joining <strong>Vinsup Skill Academy</strong>${data.batchLine ? ` — you have been enrolled in <strong>${data.batchLine}</strong>` : ''}! Your student portal account has been created. Here you'll track your attendance, marks, projects, tests, and more.</p>

          <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 8px;font-weight:700;color:#0369a1;">Your Login Credentials</p>
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;"><strong>Portal</strong></td><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;"><a href="${data.loginUrl}" style="color:#1e40af;">${data.loginUrl}</a></td></tr>
              <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;"><strong>Email (Username)</strong></td><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;">${data.email}</td></tr>
              <tr><td style="padding:8px 12px;background:#fff;border:1px solid #e5e7eb;"><strong>Temporary Password</strong></td><td style="padding:8px 12px;background:#fffbeb;border:1px solid #e5e7eb;font-family:monospace;font-size:16px;letter-spacing:2px;font-weight:700;color:#92400e;">${data.studentCode}</td></tr>
            </table>
            <p style="margin:8px 0 0;font-size:12px;color:#64748b;">Your temporary password is your Student ID.</p>
          </div>

          <div style="background:#fef3c7;border-left:4px solid #f59e0b;padding:14px;border-radius:0 6px 6px 0;margin:20px 0;">
            <p style="margin:0;font-weight:700;color:#92400e;">⚠️ First login — 2 quick steps</p>
            <ol style="margin:8px 0 0;padding-left:20px;color:#78350f;font-size:14px;line-height:1.8;">
              <li><strong>Set a new password</strong> — you'll be asked to change the temporary one immediately.</li>
              <li><strong>Complete your profile</strong> — fill in your name, phone, photo, and other details in the wizard that follows.</li>
            </ol>
          </div>

          <p style="text-align:center;margin:24px 0;">
            <a href="${data.loginUrl}" style="background:#1e3a8a;color:#fff;padding:13px 30px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;font-size:15px;">Log In to Student Portal →</a>
          </p>

          <p style="color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:14px;margin-top:20px;">
            Trouble logging in? Contact your trainer or write to <a href="mailto:operation@vinsupskillacademy.com" style="color:#1e40af;">operation@vinsupskillacademy.com</a><br/>
            Student ID: <strong>${data.studentCode}</strong> — keep this for all academy communication.
          </p>
        </div>
      </div>`,

    photoUploadRequest: (data: { firstName: string; loginUrl: string; deadline: string; logoUrl?: string }) => `
      <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#1e3a8a;padding:24px;text-align:center;">
          ${data.logoUrl ? `<img src="${data.logoUrl}" alt="Vinsup Skill Academy" height="40" style="height:40px;width:auto;display:inline-block;background:#fff;padding:4px 10px;border-radius:6px;margin-bottom:10px;" /><br/>` : ''}
          <h1 style="color:#fff;margin:0;font-size:22px;">📸 Update Your Profile Photo</h1>
          <p style="color:#93c5fd;margin:6px 0 0;font-size:13px;">Vin-Source Portal — Vinsup Skill Academy</p>
        </div>
        <div style="padding:26px;">
          <p>Dear <strong>${data.firstName}</strong>,</p>
          <p>We're adding profile photos across the Vin-Source Portal — they'll appear on your profile, the org chart, and in celebration emails (like birthday wishes 🎂).</p>
          <p><strong>Please upload a clear, professional photo of yourself by ${data.deadline}.</strong></p>

          <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px;margin:18px 0;">
            <p style="margin:0 0 8px;font-weight:700;color:#0369a1;">How to upload (takes under a minute):</p>
            <ol style="margin:0;padding-left:20px;color:#374151;font-size:14px;line-height:1.8;">
              <li>Log in to the <a href="${data.loginUrl}" style="color:#1e40af;">Vin-Source Portal</a>.</li>
              <li>Click your name in the top-right corner.</li>
              <li>Choose <strong>Upload Photo</strong> and select your picture.</li>
            </ol>
          </div>

          <div style="background:#fef9c3;border-left:4px solid #eab308;padding:12px 14px;border-radius:0 6px 6px 0;margin:18px 0;">
            <p style="margin:0;font-size:13px;color:#713f12;"><strong>Photo guidelines:</strong> recent, front-facing, plain background, formal/business attire preferred. JPG or PNG, max 5&nbsp;MB.</p>
          </div>

          <p style="text-align:center;margin:22px 0 8px;">
            <a href="${data.loginUrl}" style="background:#1e3a8a;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;font-size:14px;">Open Vin-Source Portal →</a>
          </p>

          <p style="color:#6b7280;font-size:12px;border-top:1px solid #e5e7eb;padding-top:12px;margin-top:18px;">
            Questions? Contact HR at <a href="mailto:operation@vinsupskillacademy.com" style="color:#1e40af;">operation@vinsupskillacademy.com</a>
          </p>
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

    appointmentLetterApproval: (data: { approverName: string; employeeName: string; letterId: string; portalUrl: string }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#1e3a8a;padding:24px;">
          <h1 style="color:#fff;margin:0;font-size:22px;">Appointment Letter — Approval Required</h1>
          <p style="color:#93c5fd;margin:6px 0 0;font-size:13px;">Vin-Source Portal — Vinsup Skill Academy</p>
        </div>
        <div style="padding:24px;">
          <p>Dear ${data.approverName},</p>
          <p>An appointment letter has been created for <strong>${data.employeeName}</strong> and is awaiting your approval.</p>
          <p>Please log in to the portal to review and approve or reject the letter.</p>
          <p style="text-align:center;margin:24px 0;">
            <a href="${data.portalUrl}" style="background:#1e3a8a;color:#fff;padding:12px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block;">Review Letter →</a>
          </p>
          <p style="color:#6b7280;font-size:12px;">Vin-Source Portal — Vinsup Skill Academy</p>
        </div>
      </div>`,

    appointmentLetterToEmployee: (data: { employeeName: string; joiningDate: string; designation: string; department: string }) => `
      <div style="font-family:sans-serif;max-width:600px;margin:auto;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
        <div style="background:#1e3a8a;padding:28px;text-align:center;">
          <h1 style="color:#fff;margin:0;font-size:24px;letter-spacing:1px;">Vinsup Skill Academy</h1>
          <p style="color:#93c5fd;margin:6px 0 0;font-size:13px;">Appointment Letter</p>
        </div>
        <div style="padding:28px;">
          <p>Dear <strong>${data.employeeName}</strong>,</p>
          <p>We are pleased to offer you the position of <strong>${data.designation}</strong> in our <strong>${data.department}</strong> department at Vinsup Skill Academy.</p>
          <p>Please find your official appointment letter attached to this email. Kindly review all the terms and conditions mentioned in the letter.</p>
          <div style="background:#f0f9ff;border:1px solid #bae6fd;border-radius:8px;padding:16px;margin:20px 0;">
            <p style="margin:0 0 6px;font-weight:700;color:#0369a1;">Key Details</p>
            <table style="width:100%;border-collapse:collapse;">
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#fff;"><strong>Position</strong></td><td style="padding:8px;border:1px solid #e5e7eb;background:#fff;">${data.designation}</td></tr>
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#fff;"><strong>Department</strong></td><td style="padding:8px;border:1px solid #e5e7eb;background:#fff;">${data.department}</td></tr>
              <tr><td style="padding:8px;border:1px solid #e5e7eb;background:#fff;"><strong>Date of Joining</strong></td><td style="padding:8px;border:1px solid #e5e7eb;background:#fff;">${data.joiningDate}</td></tr>
            </table>
          </div>
          <p>If you have any questions, please contact HR at <a href="mailto:operation@vinsupskillacademy.com" style="color:#1e40af;">operation@vinsupskillacademy.com</a></p>
          <p>We look forward to welcoming you to our team!</p>
          <p style="margin-top:24px;">Warm regards,<br/><strong>Pooranam Annamalai</strong><br/>Chief Business and People Officer<br/>Vinsup Skill Academy</p>
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
