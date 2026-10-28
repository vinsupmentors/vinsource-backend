import { AppError } from '../middleware/errorHandler';
import { getAdmissionConfig, getEmiInterestRate, splitIntoInstallments } from '../services/admissionFeeEngine';

/** Longest EMI the sales team offers, whatever the fee. */
export const EMI_MAX_MONTHS = 5;
/** Longest tenure by course fee (from the team's EMI Guide). */
const TENURE_BY_FEE: { minFee: number; maxMonths: number }[] = [
  { minFee: 50000, maxMonths: 5 },
  { minFee: 30000, maxMonths: 4 },
  { minFee: 25000, maxMonths: 3 },
  { minFee: 0, maxMonths: 2 },
];
const round = (n: number) => Math.round(n * 100) / 100;

export function allowedEmiMonths(fee: number): number[] {
  const max = Math.min(EMI_MAX_MONTHS, (TENURE_BY_FEE.find((t) => fee >= t.minFee) || TENURE_BY_FEE[TENURE_BY_FEE.length - 1]).maxMonths);
  return Array.from({ length: max - 1 }, (_, i) => i + 2);
}

/**
 * Down payment is the configured % (20) of the fee. Interest is charged ONLY on the balance
 * (fee − down payment), at the rate for the chosen tenure; the balance + interest is split equally.
 */
export async function quoteEmi(fee: number, months: number) {
  if (!(fee > 0)) throw new AppError('Enter the course fee first', 400);
  const allowed = allowedEmiMonths(fee);
  if (!allowed.includes(months)) throw new AppError(`For a fee of ₹${fee.toLocaleString('en-IN')}, EMI can be ${allowed[0]}${allowed.length > 1 ? `–${allowed[allowed.length - 1]}` : ''} months.`, 400);
  const config = await getAdmissionConfig();
  const downPayment = round(fee * (config.downPaymentPct / 100));
  const balance = round(fee - downPayment);
  const ratePct = getEmiInterestRate(config, months);
  const interest = round(balance * (ratePct / 100));
  const monthly = splitIntoInstallments(round(balance + interest), months);
  return { fee, months, downPaymentPct: config.downPaymentPct, downPayment, balance, ratePct, interest, totalPayable: round(fee + interest), monthly, allowedMonths: allowed };
}

export function addMonthsKeepDay(d: Date, n: number): Date {
  const r = new Date(d);
  const day = r.getDate();
  r.setDate(1);
  r.setMonth(r.getMonth() + n);
  r.setDate(Math.min(day, new Date(r.getFullYear(), r.getMonth() + 1, 0).getDate()));
  return r;
}
