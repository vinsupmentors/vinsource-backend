/**
 * Sends a TEST birthday email for one employee to ONE address only.
 * Uses the exact same template, photo, and logo as the daily automation.
 *
 * Usage (on the VPS):
 *   npm run test:birthday -- V7032 v7032vinsup@gmail.com
 */
import prisma from '../config/database';
import { emailService } from '../services/email.service';
import { config } from '../config/env';

async function main() {
  const [code, to] = process.argv.slice(2);
  if (!code || !to) {
    console.log('Usage: npm run test:birthday -- <EMP_CODE> <recipient@email.com>');
    process.exit(1);
  }

  const emp = await prisma.employee.findFirst({
    where: { employeeCode: code.toUpperCase() },
    select: { firstName: true, lastName: true, profilePhoto: true, employeeCode: true },
  });
  if (!emp) {
    console.error(`✗ No employee found with code ${code}`);
    process.exit(1);
  }

  const celebrantName = `${emp.firstName} ${emp.lastName}`;
  const photoUrl = emp.profilePhoto
    ? `${config.FRONTEND_URL}${emp.profilePhoto.startsWith('/') ? '' : '/'}${emp.profilePhoto}`
    : null;

  console.log(`Employee : ${celebrantName} [${emp.employeeCode}]`);
  console.log(`Photo    : ${photoUrl || '(none uploaded — initial letter will be shown)'}`);
  console.log(`Sending TEST birthday email to ${to} only…`);

  await emailService.send({
    to,
    subject: `🎉 [TEST] Happy Birthday, ${celebrantName}!`,
    html: emailService.templates.birthdayWish({
      celebrantName,
      celebrantFirstName: emp.firstName,
      photoUrl,
      logoUrl: `${config.FRONTEND_URL}/vinsup-logo.png`,
    }),
    template: 'birthday_wish_test',
  });

  console.log('✓ Sent. Check the inbox (and spam folder).');
}

main()
  .catch((e) => { console.error('✗ Failed:', e instanceof Error ? e.message : e); process.exit(1); })
  .finally(() => prisma.$disconnect());
