import prisma from '../config/database';
import { emailService } from './email.service';

/**
 * Rule-based lead alerts. Each active SalesAlertRule is evaluated once a day at
 * its send hour (IST). Matching leads — assigned or sitting in My Base — are
 * emailed as a digest: every owner gets their own list, and Sales Admin gets
 * one combined digest grouped by salesperson.
 */

const DAY = 86400000;
const IST_OFFSET = 5.5 * 3600 * 1000;
const MAX_ROWS = 2000;

export const ALERT_TYPES: Record<string, string> = {
  NO_ACTIVITY: 'No call/meeting logged for N days',
  STATUS_STALE: 'Stuck on a status for N days (e.g. DNP)',
  FOLLOWUP_OVERDUE: 'Follow-up overdue by N days',
  NOT_CONTACTED: 'Assigned N days ago and never contacted',
};

interface Rule {
  id: string; name: string; type: string; days: number; activityStatus: string | null;
  includeMyBase: boolean; notifyOwner: boolean; notifyAdmins: boolean; adminEmails: string | null; sendHour: number;
  lastSentOn?: string | null;
}

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
const istNow = () => new Date(Date.now() + IST_OFFSET);
const istDate = () => istNow().toISOString().slice(0, 10);
const startOfTodayIst = () => new Date(new Date(`${istDate()}T00:00:00+05:30`).getTime());
const fmt = (d: Date | null) => (d ? new Date(d.getTime() + IST_OFFSET).toISOString().slice(0, 16).replace('T', ' ') : '—');
const ago = (d: Date | null) => (d ? `${Math.floor((Date.now() - d.getTime()) / DAY)}d ago` : 'never');

export function describeRule(r: Pick<Rule, 'type' | 'days' | 'activityStatus'>): string {
  const status = (r.activityStatus || '').replace(/_/g, ' ');
  switch (r.type) {
    case 'NO_ACTIVITY': return `no call or meeting for ${r.days} day${r.days === 1 ? '' : 's'}`;
    case 'STATUS_STALE': return `still "${status}" with no new activity for ${r.days} day${r.days === 1 ? '' : 's'}`;
    case 'FOLLOWUP_OVERDUE': return `follow-up overdue by ${r.days}+ day${r.days === 1 ? '' : 's'}`;
    case 'NOT_CONTACTED': return `assigned ${r.days}+ day${r.days === 1 ? '' : 's'} ago and never contacted`;
    default: return r.type;
  }
}

function ruleWhere(rule: Rule): Record<string, unknown> {
  const days = Math.max(1, rule.days);
  const cutoff = new Date(Date.now() - days * DAY);
  const and: Record<string, unknown>[] = [
    { OR: [{ activityStatus: null }, { activityStatus: { notIn: ['NOT_INTERESTED', 'DISQUALIFIED'] } }] },
  ];
  const where: Record<string, unknown> = { deletedAt: null, status: { notIn: ['ENROLLED', 'LOST'] }, AND: and };
  if (!rule.includeMyBase || rule.type === 'NOT_CONTACTED') where.assignedToId = { not: null };
  switch (rule.type) {
    case 'NO_ACTIVITY':
      and.push({ OR: [{ lastContactAt: { lt: cutoff } }, { lastContactAt: null, createdAt: { lt: cutoff } }] });
      break;
    case 'STATUS_STALE':
      if (rule.activityStatus) where.activityStatus = rule.activityStatus;
      and.push({ OR: [{ lastContactAt: { lt: cutoff } }, { lastContactAt: null, createdAt: { lt: cutoff } }] });
      break;
    case 'FOLLOWUP_OVERDUE':
      where.nextFollowUpAt = { lt: new Date(startOfTodayIst().getTime() - (days - 1) * DAY) };
      break;
    case 'NOT_CONTACTED':
      where.lastContactAt = null;
      and.push({ OR: [{ assignedAt: { lt: cutoff } }, { assignedAt: null, createdAt: { lt: cutoff } }] });
      break;
    default:
      throw new Error(`Unknown alert rule type ${rule.type}`);
  }
  return where;
}

async function matchingLeads(rule: Rule) {
  const where = ruleWhere(rule);
  const [rows, total] = await Promise.all([
    prisma.lead.findMany({
      where,
      select: {
        id: true, name: true, phone: true, status: true, activityStatus: true, lastContactAt: true, nextFollowUpAt: true, createdAt: true, source: true,
        assignedTo: { select: { id: true, firstName: true, lastName: true, email: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: MAX_ROWS,
    }),
    prisma.lead.count({ where }),
  ]);
  return { rows, total };
}

type Row = Awaited<ReturnType<typeof matchingLeads>>['rows'][number];

function table(rows: Row[], limit: number) {
  const body = rows.slice(0, limit).map((l) => `
    <tr>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(l.name)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(l.phone)}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(String(l.status).replace(/_/g, ' '))}${l.activityStatus ? ` · ${esc(String(l.activityStatus).replace(/_/g, ' '))}` : ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(ago(l.lastContactAt))}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #e5e7eb">${esc(fmt(l.nextFollowUpAt))}</td>
    </tr>`).join('');
  const more = rows.length > limit ? `<p style="color:#6b7280;font-size:12px">…and ${rows.length - limit} more. Open the portal to see them all.</p>` : '';
  return `<table style="border-collapse:collapse;width:100%;font-size:13px"><thead><tr style="background:#f3f4f6;text-align:left">
    <th style="padding:6px 8px">Lead</th><th style="padding:6px 8px">Phone</th><th style="padding:6px 8px">Stage · Status</th><th style="padding:6px 8px">Last contact</th><th style="padding:6px 8px">Follow-up</th></tr></thead><tbody>${body}</tbody></table>${more}`;
}

const wrap = (title: string, intro: string, inner: string) => `
  <div style="font-family:sans-serif;max-width:760px;margin:auto">
    <h2 style="color:#1e40af;margin-bottom:4px">${esc(title)}</h2>
    <p style="color:#374151">${intro}</p>${inner}
    <p style="color:#9ca3af;font-size:11px;margin-top:20px">Sent automatically by the Vin-Source Portal sales alert rules.</p>
  </div>`;

async function adminRecipients(rule: Rule): Promise<string[]> {
  const own = (rule.adminEmails || '').split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.includes('@'));
  if (own.length) return own;
  const rows = await prisma.reportRecipient.findMany({ where: { type: 'SALES_HOURLY' } });
  return rows.map((r: { email: string }) => r.email);
}

export const salesAlertsService = {
  describeRule,

  /** How many leads currently match + a small sample — used by the rules screen preview. */
  async preview(rule: Rule) {
    const { rows, total } = await matchingLeads(rule);
    const owners = new Map<string, { name: string; count: number }>();
    for (const l of rows) {
      const k = l.assignedTo?.id || '__base__';
      const cur = owners.get(k) || { name: l.assignedTo ? `${l.assignedTo.firstName} ${l.assignedTo.lastName}` : 'My Base (unassigned)', count: 0 };
      cur.count++; owners.set(k, cur);
    }
    return { total, perOwner: Array.from(owners.values()).sort((a, b) => b.count - a.count), sample: rows.slice(0, 10).map((l) => ({ id: l.id, name: l.name, phone: l.phone, owner: l.assignedTo ? `${l.assignedTo.firstName} ${l.assignedTo.lastName}` : 'My Base', lastContact: ago(l.lastContactAt) })) };
  },

  /** Evaluate one rule and email the digests. Returns how many leads matched and how many emails went out. */
  async runRule(rule: Rule): Promise<{ matched: number; emails: number }> {
    const { rows, total } = await matchingLeads(rule);
    if (!rows.length) return { matched: 0, emails: 0 };
    const what = describeRule(rule);
    let emails = 0;

    const byOwner = new Map<string, { name: string; email: string | null; leads: Row[] }>();
    for (const l of rows) {
      const k = l.assignedTo?.id || '__base__';
      if (!byOwner.has(k)) byOwner.set(k, { name: l.assignedTo ? `${l.assignedTo.firstName} ${l.assignedTo.lastName}` : 'My Base (unassigned)', email: l.assignedTo?.email || null, leads: [] });
      byOwner.get(k)!.leads.push(l);
    }

    if (rule.notifyOwner) {
      for (const [k, o] of byOwner) {
        if (k === '__base__' || !o.email) continue;
        try {
          await emailService.send({
            to: o.email, subject: `Action needed: ${o.leads.length} lead${o.leads.length === 1 ? '' : 's'} — ${rule.name}`, template: 'salesAlertOwner',
            html: wrap(rule.name, `Hi ${esc(o.name)}, you have <b>${o.leads.length}</b> lead${o.leads.length === 1 ? '' : 's'} with ${esc(what)}. Please follow up.`, table(o.leads, 100)),
          });
          emails++;
        } catch (e) { console.error('Sales alert owner email failed:', e); }
      }
    }

    if (rule.notifyAdmins) {
      const to = await adminRecipients(rule);
      if (to.length) {
        const summary = Array.from(byOwner.values()).sort((a, b) => b.leads.length - a.leads.length);
        const inner = `
          <table style="border-collapse:collapse;font-size:13px;margin-bottom:14px"><tbody>${summary.map((o) => `<tr><td style="padding:4px 12px 4px 0"><b>${esc(o.name)}</b></td><td>${o.leads.length}</td></tr>`).join('')}</tbody></table>
          ${summary.map((o) => `<h4 style="margin:16px 0 6px">${esc(o.name)} (${o.leads.length})</h4>${table(o.leads, 25)}`).join('')}`;
        try {
          await emailService.send({
            to, subject: `Sales alert: ${total} lead${total === 1 ? '' : 's'} — ${rule.name}`, template: 'salesAlertAdmin',
            html: wrap(rule.name, `<b>${total}</b> lead${total === 1 ? '' : 's'} with ${esc(what)}${rule.includeMyBase ? ' (including My Base)' : ''}.`, inner),
          });
          emails++;
        } catch (e) { console.error('Sales alert admin email failed:', e); }
      }
    }
    return { matched: total, emails };
  },

  /** Hourly tick: run every active rule whose send hour (IST) is now and which has not run today. */
  async runDue(): Promise<{ rules: number; emails: number }> {
    const hour = istNow().getUTCHours();
    const today = istDate();
    const due = await prisma.salesAlertRule.findMany({ where: { active: true, sendHour: hour, OR: [{ lastSentOn: null }, { lastSentOn: { not: today } }] } });
    let emails = 0;
    for (const rule of due) {
      try {
        const r = await salesAlertsService.runRule(rule);
        emails += r.emails;
        await prisma.salesAlertRule.update({ where: { id: rule.id }, data: { lastSentOn: today, lastSentCount: r.matched } });
      } catch (e) { console.error(`Sales alert rule "${rule.name}" failed:`, e); }
    }
    return { rules: due.length, emails };
  },
};
