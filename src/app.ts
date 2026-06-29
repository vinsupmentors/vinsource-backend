import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import { config } from './config/env';
import { errorHandler, notFound } from './middleware/errorHandler';

import path from 'path';
import authRoutes from './routes/auth.routes';
import employeeRoutes from './routes/employee.routes';
import attendanceRoutes from './routes/attendance.routes';
import attendanceRegularizationRoutes from './routes/attendanceRegularization.routes';
import leaveRoutes from './routes/leave.routes';
import payrollRoutes from './routes/payroll.routes';
import notificationRoutes from './routes/notification.routes';
import dashboardRoutes from './routes/dashboard.routes';
import documentRoutes from './routes/document.routes';
import assetRoutes from './routes/asset.routes';
import helpdeskRoutes from './routes/helpdesk.routes';
import orgRoutes, { buildDepartmentRouter, buildDesignationRouter, buildBranchRouter } from './routes/org.routes';
import reportRoutes from './routes/report.routes';
import compOffRoutes from './routes/compoff.routes';
import permissionRoutes from './routes/permission.routes';
import onboardingRoutes from './routes/onboarding.routes';
import resignationRoutes from './routes/resignation.routes';
import accessRoutes from './routes/access.routes';
import salesRoutes from './routes/sales.routes';
import financeSalesRoutes from './routes/financeSales.routes';
import financeAdminRoutes from './routes/financeAdmin.routes';
import productionRoutes from './routes/production.routes';
import placementsRoutes from './routes/placements.routes';
import digitalMarketingRoutes from './routes/digitalMarketing.routes';
import studentPortalRoutes from './routes/studentPortal.routes';
import trainerPortalRoutes from './routes/trainerPortal.routes';
import publicRoutes from './routes/public.routes';

const app = express();

// Security
app.use(helmet());
app.use(cors({
  origin: config.FRONTEND_URL,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
}));

// Rate limiting — relaxed for development; tighten for production
const isDev = config.NODE_ENV !== 'production';
app.use('/api/auth', rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 500 : 30,
  message: { success: false, message: 'Too many requests, please try again later' },
  skip: () => isDev, // completely skip in dev
}));

app.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  max: isDev ? 5000 : 500,
  skip: () => isDev,
}));

// Parsing & logging
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(config.NODE_ENV === 'production' ? 'combined' : 'dev'));

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok', timestamp: new Date() }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/employees', employeeRoutes);
app.use('/api/attendance', attendanceRoutes);
app.use('/api/attendance-regularization', attendanceRegularizationRoutes);
app.use('/api/leave', leaveRoutes);
app.use('/api/payroll', payrollRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/assets', assetRoutes);
app.use('/api/helpdesk', helpdeskRoutes);
app.use('/api/org', orgRoutes);
app.use('/api/reports', reportRoutes);
app.use('/api/comp-off', compOffRoutes);
app.use('/api/permissions', permissionRoutes);
app.use('/api/onboarding', onboardingRoutes);
app.use('/api/resignation', resignationRoutes);
app.use('/api/access', accessRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/finance-sales', financeSalesRoutes);
app.use('/api/finance-admin', financeAdminRoutes);
app.use('/api/production', productionRoutes);
app.use('/api/placements', placementsRoutes);
app.use('/api/digital-marketing', digitalMarketingRoutes);
app.use('/api/student-portal', studentPortalRoutes);
app.use('/api/trainer-portal', trainerPortalRoutes);
app.use('/api/public', publicRoutes);
app.use('/api/departments', buildDepartmentRouter());
app.use('/api/designations', buildDesignationRouter());
app.use('/api/branches', buildBranchRouter());

// Serve uploaded files — force inline display (preview in browser) instead of forced download.
// helmet() sets Cross-Origin-Resource-Policy: same-origin by default, which blocks the
// frontend (a different origin in dev, e.g. localhost:5173) from rendering these images even
// though the request succeeds (200). Relax CORP to cross-origin for this route only.
app.use('/uploads', (_req, res, next) => {
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  next();
}, express.static(path.join(__dirname, '..', 'uploads'), {
  setHeaders: (res) => {
    res.setHeader('Content-Disposition', 'inline');
  },
}));

// Error handling
app.use(notFound);
app.use(errorHandler);

export default app;
