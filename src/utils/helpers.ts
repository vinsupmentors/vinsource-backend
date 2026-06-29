import bcrypt from 'bcryptjs';

export const hashPassword = (password: string): Promise<string> =>
  bcrypt.hash(password, 12);

export const comparePassword = (password: string, hash: string): Promise<boolean> =>
  bcrypt.compare(password, hash);

export const paginate = (page = 1, limit = 20) => ({
  skip: (page - 1) * limit,
  take: limit,
});

export const formatPagination = (total: number, page: number, limit: number) => ({
  total,
  page,
  limit,
  totalPages: Math.ceil(total / limit),
});

export const generateEmployeeCode = (prefix = 'EMP', count: number): string =>
  `${prefix}${String(count + 1).padStart(5, '0')}`;

export const getDateRange = (month: number, year: number) => {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0, 23, 59, 59);
  return { start, end };
};

export const calcWorkHours = (checkIn: Date, checkOut: Date, breakMinutes = 0): number => {
  const diff = (checkOut.getTime() - checkIn.getTime()) / (1000 * 60); // minutes
  return Math.max(0, (diff - breakMinutes) / 60);
};

export const calcLOP = (
  workingDays: number,
  presentDays: number,
  approvedLeaveDays: number
): number => Math.max(0, workingDays - presentDays - approvedLeaveDays);

export interface SalaryComponents {
  grossSalary: number;
  basic: number;
  hra: number;
  conveyance: number;
  medicalAllowance: number;
  specialAllowance: number;
  pf: number;
  esi: number;
  professionalTax: number;
  tds: number;
  totalDeductions: number;
  netSalary: number;
}

/**
 * Back-calculates all salary components from a monthly net take-home amount.
 *
 * hasPf = false (default):
 *   Employee receives exactly `netMonthly` in hand.
 *   Gross = net + PT. No PF deducted from salary.
 *
 * hasPf = true (permanent employees enrolled in PF):
 *   Employee PF = 12% of basic (deducted from gross).
 *   Employer PF = 12% of basic (paid by company — not deducted from gross, but recorded).
 *   Gross is solved so that gross - PF - PT - ESI - TDS = netMonthly.
 */
export function calcSalaryFromNet(netMonthly: number, hasPf = false): SalaryComponents {
  const CONVEYANCE = 1600;
  const MEDICAL = 1250;
  const PT = 200;

  let gross: number;
  let pf: number;

  if (!hasPf) {
    // No PF — gross is simply net + PT (ESI unlikely without PF, TDS only at very high salaries)
    // Check TDS threshold
    const grossNoPF = netMonthly + PT;
    const tdsCheck = grossNoPF > 20833 ? Math.round(Math.max(0, (grossNoPF * 12 - 250000) * 0.05 / 12)) : 0;
    gross = Math.round(netMonthly + PT + tdsCheck);
    pf = 0;
  } else {
    // With PF: PF = 12% of basic = 12% of (40% of gross) = 4.8% of gross
    // Solve: gross - 0.048*gross - PT - ESI - TDS = net
    // Try with TDS first (gross > 20833)
    gross = Math.round((netMonthly - 841.67) / 0.902);
    if (gross <= 20833) {
      gross = Math.round((netMonthly + PT) / (1 - 0.048));
    }
    pf = Math.round(gross * 0.4 * 0.12); // 12% of basic
  }

  const basic = Math.round(gross * 0.4);
  const hra = Math.round(basic * 0.4);
  const specialAllowance = Math.max(0, gross - basic - hra - CONVEYANCE - MEDICAL);
  const esi = gross < 21000 ? Math.round(gross * 0.0075) : 0;
  const tds = gross > 20833 ? Math.round(Math.max(0, (gross * 12 - 250000) * 0.05 / 12)) : 0;
  const totalDeductions = pf + esi + PT + tds;
  const netSalary = gross - totalDeductions;

  return {
    grossSalary: gross,
    basic,
    hra,
    conveyance: CONVEYANCE,
    medicalAllowance: MEDICAL,
    specialAllowance,
    pf,
    esi,
    professionalTax: PT,
    tds,
    totalDeductions,
    netSalary,
  };
}
