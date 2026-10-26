import prisma from '../config/database';
import { emailService } from './email.service';
import { notificationService } from './notification.service';
import { computeSalesLeaderboard } from './salesLeaderboard.service';

/**
 * Target vs achievement alerts. On the configured days of the month (IST) every
 * salesperson with a target is compared against their pro-rata share of it
 * (goal × days elapsed ÷ days in month). Anyone below `behindPercent` of that
 * pace gets an email + in-app notification, and admins get one combined list.
 */

const IST_OFFSET = 5.5 * 3600 * 1000;
const istNow = () => new Date(Date.now() + IST_OFFSET);
const istDate = () => istNow().toISOString().slice(0, 10);
const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

export interface TargetAlertConfig {
  id: string; active: boolean; checkDays: string; behindPercent: number; notifyOwner: boolean; notifyAdmins: boolean;
  adminEmails: string | null; sendHour: number; lastSentOn: string | null;
}

export interface BehindRow {
  employeeId: string; name: string; email: string | null; userId: string | null;
  enrollGoal: number; enrolled: number; enrollExpected: number;
  revenueGoal: number; revenue: number; revenueExpected: number;
  behindEnroll: boolean; behindRevenue: boolean;
}

export async function getTargetAlertConfig(): Promise<TargetAlertConfig> {
  const existing = await prisma.salesTargetAlertConfig.findFirst();
  return existing || prisma.salesTargetAlertConfig.create({ data: {} });
}

/** Everyone with a target this month, flagged when behind pace. */
export async function computeBehind(behindPercent: number): Promise<{ rows: BehindRow[]; day: number; daysInMonth: number; monthLabel: string }> {
  const now = istNow();
  const year = now.getUTCFullYear(), month = now.getUTCMonth() + 1, day = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const start = new Date(`${year}-${String(month).padStart(2, '0')}-01T00:00:00+05:30`);
  const board = await computeSalesLeaderboard(start, new Date(), month, year);
  const targeted = board.filter((r) => r.target && (r.target.enrollmentGoal > 0 || r.target.revenueGoal > 0));
  const emps = await prisma.employee.findMany({ where: { id: { in: targeted.map((r) => r.employeeId) } }, select: { id: true, email: true, userId: true } });
  const byId = new Map(emps.map((e) => [e.id, e]));
  const pace = day / daysInMonth;
  const rows: BehindRow[] = targeted.map((r) => {
    const t = r.target!;
    const enrollExpected = t.enrollmentGoal * pace, revenueExpected = t.revenueGoal * pace;
    return {
      employeeId: r.employeeId, name: `${r.firstName} ${r.lastName}`, email: byId.get(r.employeeId)?.email || null, userId: byId.get(r.employeeId)?.userId || null,
      enrollGoal: t.enrollmentGoal, enrolled: r.enrolled, enrollExpected,
      revenueGoal: t.revenueGoal, revenue: r.revenue, revenueExpected,
      behindEnroll: t.enrollmentGoal > 0 && r.enrolled < enrollExpected * (behindPercent / 100),
      behindRevenue: t.revenueGoal > 0 && r.revenue < revenueExpected * (behindPercent / 100),
    };
  });
  const monthLabel = new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  return { rows, day, daysInMonth, monthLabel };
}

async function adminRecipients(cfg: TargetAlertConfig): Promise<string[]> {
  const own = (cfg.adminEmails || '').split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.includes('@'));
  if (own.length) return own;
  const rows = await prisma.reportRecipient.findMany({ where: { type: 'SALES_HOURLY' } });
  return rows.map((r: { email: string }) => r.email);
}

const wrap = (title: string, intro: string, inner: string) => `
  <div style="font-family:sans-serif;max-width:700px;margin:auto">
    <h2 style="color:#1e40af;margin-bottom:4px">${esc(title)}</h2><p style="color:#374151">${intro}</p>${inner}
    <p style="color:#9ca3af;font-size:11px;margin-top:20px">Sent automatically by the Vin-Source Portal.</p>
  </div>`;

export const salesTargetAlertsService = {
  /** Compute + send the alerts now (used by the daily tick and the "Send now" button). */
  async run(cfg: TargetAlertConfig): Promise<{ behind: number; emails: number }> {
    const { rows, day, daysInMonth, monthLabel } = await computeBehind(cfg.behindPercent);
    const behind = rows.filter((r) => r.behindEnroll || r.behindRevenue);
    if (!behind.length) return { behind: 0, emails: 0 };
    let emails = 0;
    const daysLeft = daysInMonth - day;

    if (cfg.notifyOwner) {
      for (const r of behind) {
        const lines: string[] = [];
        if (r.enrollGoal > 0) lines.push(`<tr><td style="padding:6px 8px">Enrolments</td><td style="padding:6px 8px">${r.enrolled} of ${r.enrollGoal}</td><td style="padding:6px 8px">${Math.ceil(r.enrollExpected)} expected by now</td></tr>`);
        if (r.revenueGoal > 0) lines.push(`<tr><td style="padding:6px 8px">Revenue</td><td style="padding:6px 8px">${inr(r.revenue)} of ${inr(r.revenueGoal)}</td><td style="padding:6px 8px">${inr(r.revenueExpected)} expected by now</td></tr>`);
        const need = r.enrollGoal > 0 ? Math.max(0, r.enrollGoal - r.enrolled) : 0;
        const msg = `You are behind your ${monthLabel} target (day ${day} of ${daysInMonth}). ${need ? `${need} more enrolment${need === 1 ? '' : 's'} needed in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.` : ''}`;
        if (r.userId) await notificationService.create({ userId: r.userId, type: 'SYSTEM', title: 'Behind your sales target', message: msg, data: {} }).catch(() => {});
        if (r.email) {
          try {
            await emailService.send({
              to: r.email, subject: `You are behind your ${monthLabel} sales target`, template: 'salesTargetOwner',
              html: wrap('Target check-in', esc(msg), `<table style="border-collapse:collapse;font-size:13px;width:100%"><tbody>${lines.join('')}</tbody></table>`),
            });
            emails++;
          } catch (e) { console.error('Target alert owner email failed:', e); }
        }
      }
    }

    if (cfg.notifyAdmins) {
      const to = await adminRecipients(cfg);
      if (to.length) {
        const body = behind.map((r) => `<tr>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb"><b>${esc(r.name)}</b></td>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${r.enrollGoal > 0 ? `${r.enrolled} / ${r.enrollGoal}${r.behindEnroll ? ' ⚠' : ''}` : '—'}</td>
          <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${r.revenueGoal > 0 ? `${inr(r.revenue)} / ${inr(r.revenueGoal)}${r.behindRevenue ? ' ⚠' : ''}` : '—'}</td></tr>`).join('');
        try {
          await emailService.send({
            to, subject: `Sales targets: ${behind.length} behind pace (${monthLabel}, day ${day})`, template: 'salesTargetAdmin',
            html: wrap('Behind-target report', `${behind.length} of ${rows.length} salespeople are below ${cfg.behindPercent}% of the pace needed to hit their ${esc(monthLabel)} target (day ${day} of ${daysInMonth}).`,
              `<table style="border-collapse:collapse;font-size:13px;width:100%"><thead><tr style="background:#f3f4f6;text-align:left"><th style="padding:6px 8px">Salesperson</th><th style="padding:6px 8px">Enrolments</th><th style="padding:6px 8px">Revenue</th></tr></thead><tbody>${body}</tbody></table>`),
          });
          emails++;
        } catch (e) { console.error('Target alert admin email failed:', e); }
      }
    }
    return { behind: behind.length, emails };
  },

  /** Daily tick (hourly cron): run when this is a check day and the configured hour, once per day. */
  async runDue(): Promise<{ behind: number; emails: number }> {
    const cfg = await getTargetAlertConfig();
    if (!cfg.active) return { behind: 0, emails: 0 };
    const now = istNow();
    const today = istDate();
    const days = cfg.checkDays.split(',').map((d) => Number(d.trim())).filter((d) => d >= 1 && d <= 31);
    if (now.getUTCHours() !== cfg.sendHour || !days.includes(now.getUTCDate()) || cfg.lastSentOn === today) return { behind: 0, emails: 0 };
    const r = await salesTargetAlertsService.run(cfg);
    await prisma.salesTargetAlertConfig.update({ where: { id: cfg.id }, data: { lastSentOn: today } });
    return r;
  },
};
