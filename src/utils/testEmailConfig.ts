/**
 * Quick SMTP diagnostic — verifies the configured SMTP_USER/SMTP_PASS can
 * actually authenticate with the mail server, and optionally sends a real
 * test email so you can confirm delivery end-to-end.
 *
 * Use this whenever "student welcome email not sent" (or any other email)
 * is reported — sendStudentWelcomeEmail() and friends are all fire-and-forget
 * (never awaited, never surfaced to the UI), so the app itself will never
 * tell you an SMTP auth failure happened. This will.
 *
 * Run from backend/:
 *   npx ts-node src/utils/testEmailConfig.ts                     (verify only)
 *   npx ts-node src/utils/testEmailConfig.ts you@example.com     (verify + send a test email)
 */
import nodemailer from 'nodemailer';
import { config } from '../config/env';

async function main() {
  console.log('SMTP config in use:');
  console.log(`  host: ${config.SMTP_HOST}`);
  console.log(`  port: ${config.SMTP_PORT}`);
  console.log(`  user: ${config.SMTP_USER || '(empty!)'}`);
  console.log(`  pass: ${config.SMTP_PASS ? `set, ${config.SMTP_PASS.length} chars` : '(empty!)'}`);
  console.log(`  from: ${config.EMAIL_FROM}`);
  console.log('');

  if (!config.SMTP_USER || !config.SMTP_PASS) {
    console.error('SMTP_USER or SMTP_PASS is empty in .env — fix that first.');
    process.exit(1);
  }
  // A Gmail app password is always exactly 16 characters with no spaces —
  // the most common mistake is pasting it WITH the spaces Google displays
  // it with ("nbhr bezk mhin feor" instead of "nbhrbezkmhinfeor").
  if (config.SMTP_HOST.includes('gmail') && config.SMTP_PASS.length !== 16) {
    console.warn(`WARNING: SMTP_PASS is ${config.SMTP_PASS.length} characters, but a Gmail app password should be exactly 16 with no spaces. Check for a stray space or leftover quote in .env.`);
  }

  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });

  console.log('Verifying SMTP login...');
  try {
    await transporter.verify();
    console.log('✔ SMTP login succeeded — credentials are valid.\n');
  } catch (err) {
    console.error('✘ SMTP login FAILED — this is why emails are not sending:');
    console.error(err);
    process.exit(1);
  }

  const testTo = process.argv[2];
  if (!testTo) {
    console.log('No test address given — skipping actual send. Run again with an email address to send a real test message.');
    return;
  }

  console.log(`Sending a test email to ${testTo}...`);
  await transporter.sendMail({
    from: `"Vin-Source Portal" <${config.EMAIL_FROM}>`,
    to: testTo,
    subject: 'Vin-Source Portal — SMTP test',
    html: '<p>This is a test email confirming SMTP is working after the app-password update.</p>',
  });
  console.log('✔ Test email sent — check the inbox (and spam folder).');
}

main().catch((err) => { console.error(err); process.exit(1); });
