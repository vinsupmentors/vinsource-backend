/**
 * Re-sends the welcome/credentials email to students who never got it.
 * Targets students who still have a temporary password (mustChangePassword)
 * and a real email address — i.e. exactly the ones who can still use the
 * "password = your Student ID" instructions safely.
 *
 * Usage (on the VPS):
 *   npm run notify:students                  → dry run, lists who would get it
 *   npm run notify:students -- --send       → actually send
 *   npm run notify:students -- --send STU00012 STU00015   → only these codes
 */
import prisma from '../config/database';
import { emailService } from '../services/email.service';
import { config } from '../config/env';

async function main() {
  const args = process.argv.slice(2);
  const send = args.includes('--send');
  const onlyCodes = args.filter((a) => a !== '--send').map((a) => a.toUpperCase());

  const students = await prisma.student.findMany({
    where: {
      user: { mustChangePassword: true, isActive: true },
      ...(onlyCodes.length ? { studentCode: { in: onlyCodes } } : {}),
    },
    include: {
      user: { select: { email: true } },
      enrollments: { include: { schedule: { include: { batch: true, course: true } } } },
    },
    orderBy: { createdAt: 'desc' },
  });

  const targets = students.filter((s) => {
    const email = (s.email || s.user?.email || '').trim();
    return email && !email.endsWith('.local');
  });

  console.log(`${send ? 'SENDING to' : 'DRY RUN —'} ${targets.length} student(s) with temp passwords and real emails:\n`);

  let sent = 0, failed = 0;
  for (const s of targets) {
    const email = (s.email || s.user!.email).trim();
    const enr = s.enrollments[0];
    const batchLine = enr ? `${enr.schedule.batch.code} — ${enr.schedule.course.name} (${enr.schedule.timing})` : undefined;
    console.log(`  ${s.studentCode}  ${s.firstName} ${s.lastName}  <${email}>  ${batchLine || ''}`);
    if (!send) continue;
    try {
      await emailService.send({
        to: email,
        cc: 'v7032vinsup@gmail.com',
        subject: '🎓 Welcome to Vinsup Skill Academy — Your Student Portal Login',
        html: emailService.templates.studentWelcome({
          name: `${s.firstName} ${s.lastName}`.trim() || 'Student',
          studentCode: s.studentCode,
          email: email.toLowerCase(),
          loginUrl: `${config.FRONTEND_URL}/login`,
          batchLine,
          logoUrl: `${config.FRONTEND_URL}/vinsup-logo.png`,
        }),
        template: 'student_welcome',
      });
      sent++;
    } catch (err) {
      failed++;
      console.error(`    ✗ failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log(send ? `\nDone. Sent: ${sent}, failed: ${failed}` : '\nDry run only — re-run with --send to email them.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
