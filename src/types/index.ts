import { Role } from '@prisma/client';
import { Request } from 'express';

export interface AuthPayload {
  userId: string;
  employeeId?: string;
  studentId?: string;
  role: Role;
  companyId?: string;
  email: string;
  canManageAccess?: boolean;
}

export interface AuthRequest extends Request {
  user?: AuthPayload;
}

export interface PaginationQuery {
  page?: number;
  limit?: number;
  search?: string;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
}

export interface ApiResponse<T = unknown> {
  success: boolean;
  message: string;
  data?: T;
  meta?: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface DashboardStats {
  totalEmployees: number;
  activeEmployees: number;
  presentToday: number;
  onLeaveToday: number;
  pendingLeaves: number;
  pendingApprovals: number;
  newJoinees: number;
  upcomingBirthdays: { name: string; date: string }[];
}

export interface PayslipData {
  employee: {
    name: string;
    employeeCode: string;
    designation: string;
    department: string;
    bankAccount: string;
  };
  earnings: {
    basic: number;
    hra: number;
    conveyance: number;
    medicalAllowance: number;
    specialAllowance: number;
    bonus: number;
    incentives: number;
    grossSalary: number;
  };
  deductions: {
    pf: number;
    esi: number;
    professionalTax: number;
    tds: number;
    loanRecovery: number;
    lopDeduction: number;
    totalDeductions: number;
  };
  net: {
    netSalary: number;
    lopDays: number;
    workingDays: number;
    presentDays: number;
  };
  period: { month: number; year: number };
}

export interface SocketEvents {
  NOTIFICATION: 'notification';
  ATTENDANCE_UPDATE: 'attendance:update';
  LEAVE_UPDATE: 'leave:update';
  USER_ONLINE: 'user:online';
  USER_OFFLINE: 'user:offline';
}
