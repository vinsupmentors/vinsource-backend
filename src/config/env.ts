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
  JWT_EXPIRES_IN: process.env.JWT_EXPIRES_IN || '15m',
  JWT_REFRESH_EXPIRES_IN: process.env.JWT_REFRESH_EXPIRES_IN || '7d',

  // AWS
  AWS_REGION: process.env.AWS_REGION || 'us-east-1',
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID || '',
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY || '',
  AWS_S3_BUCKET: process.env.AWS_S3_BUCKET || 'hrms-documents',

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
