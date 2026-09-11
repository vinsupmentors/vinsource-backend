/**
 * Verifies the current SMTP_HOST/SMTP_USER/SMTP_PASS in .env can actually
 * authenticate — no email sent, just the login handshake nodemailer does
 * before sending. Fast way to confirm a credential fix worked without
 * needing a real student/employee record to trigger a template.
 *
 * Usage (from backend/):
 *   npx ts-node src/utils/testSmtpAuth.ts
 */
import nodemailer from 'nodemailer';
import { config } from '../config/env';

async function main() {
  console.log(`Testing SMTP login for ${config.SMTP_USER} @ ${config.SMTP_HOST}:${config.SMTP_PORT} ...`);
  const transporter = nodemailer.createTransport({
    host: config.SMTP_HOST,
    port: config.SMTP_PORT,
    secure: config.SMTP_PORT === 465,
    auth: { user: config.SMTP_USER, pass: config.SMTP_PASS },
  });
  try {
    await transporter.verify();
    console.log('✓ SMTP login succeeded — credentials are good.');
    process.exit(0);
  } catch (err) {
    console.error('✗ SMTP login failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  }
}

main();
