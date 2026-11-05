import prisma from '../config/database';
import { config } from '../config/env';
import { emailService } from '../services/email.service';
import { notificationService } from '../services/notification.service';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const base = () => config.FRONTEND_URL.replace(/\/$/, '');

/**
 * Tell an advisor by email when lead(s) are assigned to them (one lead → full details, several → a short list).
 * Best effort: never throws, never blocks the assignment. Skips the case where someone assigns a lead to themselves.
 */
export async function emailAdvisorNewLeads(employeeId: string | null | undefined, leadIds: string[], opts: { actorEmployeeId?: string | null; batchLabel?: string | null; via?: string } = {}) {
  try {
    if (!employeeId || !leadIds.length || employeeId === opts.actorEmployeeId) return;
    const emp = await prisma.employee.findUnique({ where: { id: employeeId }, select: { firstName: true, userId: true, email: true, user: { select: { email: true } } } });
    const to = emp?.email || emp?.user?.email;
    if (!emp) return;
    const total = leadIds.length;
    const leads = await prisma.lead.findMany({ where: { id: { in: leadIds.slice(0, 15) } }, select: { id: true, name: true, phone: true, courseInterest: true, source: true, city: true, nextFollowUpAt: true } });
    const via = opts.via ? ` (${opts.via})` : '';
    const subject = total === 1 ? `New lead assigned to you: ${leads[0]?.name || ''}` : `${total} new leads assigned to you`;
    const rows = leads.map((l) => `<tr><td style="padding:6px 10px;border-bottom:1px solid #eee"><a href="${base()}/sales?tab=leads&lead=${l.id}" style="color:#2563eb;text-decoration:none;font-weight:600">${esc(l.name)}</a></td><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(l.phone)}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(l.courseInterest || '—')}</td><td style="padding:6px 10px;border-bottom:1px solid #eee">${esc(l.source || '—')}</td></tr>`).join('');
    const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#111">
<p>Hi ${esc(emp.firstName)},</p>
<p>${total === 1 ? 'A new lead has been assigned to you' : `<b>${total}</b> new leads have been assigned to you`}${via}${opts.batchLabel ? ` — batch <b>${esc(opts.batchLabel)}</b>` : ''}. Please call ${total === 1 ? 'them' : 'them'} as soon as possible.</p>
<table style="border-collapse:collapse;width:100%;font-size:14px"><thead><tr style="text-align:left;background:#f3f4f6"><th style="padding:6px 10px">Name</th><th style="padding:6px 10px">Phone</th><th style="padding:6px 10px">Course</th><th style="padding:6px 10px">Source</th></tr></thead><tbody>${rows}</tbody></table>
${total > leads.length ? `<p style="color:#6b7280;font-size:13px">…and ${total - leads.length} more in your Leads list.</p>` : ''}
<p style="margin-top:16px"><a href="${base()}/sales?tab=leads" style="background:#2563eb;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;font-weight:600">Open my leads</a></p>
<p style="color:#6b7280;font-size:12px">Vin-Source Portal</p></div>`;
    if (to) await emailService.send({ to, subject, template: 'sales-lead-assigned', html }).catch(() => {});
    // Single assignments get a bell notification too (bulk assignment already sends its own).
    if (total === 1 && emp.userId) await notificationService.create({ userId: emp.userId, type: 'SYSTEM', title: 'New lead assigned', message: `${leads[0]?.name || 'A lead'} was assigned to you`, data: { leadId: leadIds[0] } }).catch(() => {});
  } catch (e) { console.error('Lead assignment email failed:', e); }
}
