/**
 * Sends the "please upload your profile photo" email to every active employee.
 *
 * Usage (on the VPS):
 *   npm run notify:photos                    → deadline defaults to tomorrow
 *   npm run notify:photos -- "5 July 2026"   → custom deadline text
 */
import prisma from '../config/database';
import { emailService } from '../services/email.service';
import { config } from '../config/env';

async function main() {
  const deadlineArg = process.argv[2];
  const tomorrow = new Date(Date.now() + 86400000);
  const deadline =
    deadlineArg ||
    tomorrow.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' });

  const employees = await prisma.employee.findMany({
    where: { status: { in: ['ACTIVE', 'ON_PROBATION'] }, isSystemAccount: false },
    select: { firstName: true, lastName: true, email: true, profilePhoto: true },
  });

  const targets = employees.filter((e) => e.email);
  console.log(`Sending photo-upload request to ${targets.length} employee(s), deadline: ${deadline}\n`);

  let sent = 0, failed = 0;
  for (const emp of targets) {
    try {
      await emailService.send({
        to: emp.email,
        subject: '📸 Action Required: Upload Your Profile Photo on Vin-Source Portal',
        html: emailService.templates.photoUploadRequest({
          firstName: emp.firstName,
          loginUrl: `${config.FRONTEND_URL}/login`,
          deadline,
          logoUrl: `${config.FRONTEND_URL}/vinsup-logo.png`,
        }),
        template: 'photo_upload_request',
      });
      sent++;
      console.log(`  ✓ ${emp.firstName} ${emp.lastName} <${emp.email}>${emp.profilePhoto ? ' (already has a photo)' : ''}`);
    } catch (err) {
      failed++;
      console.error(`  ✗ ${emp.email}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\nDone. Sent: ${sent}, failed: ${failed}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
