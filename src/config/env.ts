import dotenv from 'dotenv';
dotenv.config();

const required = (key: string): string => {
  const val = process.env[key];
  if (!val) throw new Error(`Missing required env var: ${key}`);
  return val;
};

export const config = {
  NODE_ENV: process.env.NODE_ENV || 'development',
  PORT: parseInt(process.env.PORT || '5000', 10),

  // Database
  DATABASE_URL: required('DATABASE_URL'),

  // Redis
  REDIS_URL: process.env.REDIS_URL || 'redis://localhost:6379',

  // JWT
  JWT_SECRET: required('JWT_SECRET'),
  JWT_REFRESH_SECRET: required('JWT_REFRESH_SECRET'),
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '2h',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  // Cloud Storage — Cloudflare R2 (S3-compatible)
  R2_ACCOUNT_ID:        process.env.R2_ACCOUNT_ID        || '',
  R2_ACCESS_KEY_ID:     process.env.R2_ACCESS_KEY_ID     || '',
  R2_SECRET_ACCESS_KEY: process.env.R2_SECRET_ACCESS_KEY || '',
  R2_BUCKET:            process.env.R2_BUCKET            || 'vinsource-docs',
  R2_ENDPOINT:          process.env.R2_ENDPOINT          || '', // https://<ACCOUNT_ID>.r2.cloudflarestorage.com
  R2_PUBLIC_URL:        process.env.R2_PUBLIC_URL        || '', // https://pub-xxxx.r2.dev

  // Email
  SMTP_HOST: process.env.SMTP_HOST || 'smtp.gmail.com',
  SMTP_PORT: parseInt(process.env.SMTP_PORT || '587', 10),
  SMTP_USER: process.env.SMTP_USER || '',
  SMTP_PASS: process.env.SMTP_PASS || '',
  EMAIL_FROM: process.env.EMAIL_FROM || 'no-reply@hrms.com',

  // Frontend
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',

  // GPS Geofencing for WFH detection (blank LAT/LNG = disabled)
  OFFICE_LAT: process.env.OFFICE_LAT ? parseFloat(process.env.OFFICE_LAT) : null,
  OFFICE_LNG: process.env.OFFICE_LNG ? parseFloat(process.env.OFFICE_LNG) : null,
  OFFICE_RADIUS_METERS: parseInt(process.env.OFFICE_RADIUS_METERS || '200', 10),

  // Escalation hours
  LEAVE_ESCALATION_REMINDER_1: parseInt(process.env.LEAVE_ESCALATION_REMINDER_1 || '24', 10),
  LEAVE_ESCALATION_REMINDER_2: parseInt(process.env.LEAVE_ESCALATION_REMINDER_2 || '48', 10),
  LEAVE_ESCALATION_HR: parseInt(process.env.LEAVE_ESCALATION_HR || '72', 10),
};
