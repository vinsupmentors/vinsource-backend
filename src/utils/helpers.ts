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

/**
 * Generates the next sequential employee code in the company's V-series
 * (V7000, V7001, … V7065 → next is V7066). Scans existing codes and returns
 * max + 1, so it is deletion-safe and stays correct after manual code edits.
 * Falls back to V7000 when no V-codes exist yet.
 */
export async function nextEmployeeCode(db: {
  employee: { findMany: (args: any) => Promise<{ employeeCode: string }[]> };
}): Promise<string> {
  const rows = await db.employee.findMany({ select: { employeeCode: true } });
  let max = 6999;
  for (const r of rows) {
    const m = /^V(\d+)$/i.exec((r.employeeCode || '').trim());
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  return `V${max + 1}`;
}

/** Converts '' / null to undefined — for optional FK/enum fields on create. */
export const orUndef = <T>(v: T | '' | null | undefined): T | undefined =>
  v === '' || v === null || v === undefined ? undefined : v;

/** Converts '' to null (clear the field), keeps undefined as "no change" — for updates. */
export const orNull = <T>(v: T | '' | null | undefined): T | null | undefined =>
  v === undefined ? undefined : v === '' || v === null ? null : v;

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
    // No PF. Solve gross - PT - TDS(gross) = net directly, where TDS(gross) is the
    // linear form of the annual-slab formula below (0.05*gross - 1041.67) once gross
    // crosses the taxable threshold — i.e. gross*(1-0.05) - PT + 1041.67 = net.
    // (Previously this estimated TDS from a *different*, lower base — netMonthly + PT,
    // which ignores TDS itself — then recomputed the real deduction from the final,
    // higher gross. That mismatch always left the actual net take-home short of the
    // target by the gap between the two estimates, e.g. ~₹200 on a ₹1,00,000 target.)
    gross = Math.round((netMonthly - 841.67) / 0.95);
    if (gross <= 20833) {
      gross = Math.round(netMonthly + PT);
    }
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
