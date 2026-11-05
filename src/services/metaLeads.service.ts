import crypto from 'crypto';
import prisma from '../config/database';
import { config } from '../config/env';
import { leadPhoneKey, findDuplicateLead } from '../utils/leadPhone';
import { ensureSource } from '../utils/leadConfig';
import { emailAdvisorNewLeads } from '../utils/leadAssignEmail';

/**
 * Meta Lead Ads → portal.
 * Meta POSTs a tiny notification (leadgen_id) to /api/public/meta-webhook; we then fetch the lead's answers from the
 * Graph API with the Page token and create the lead. Every notification is logged in MetaLeadEvent (leadgen_id is unique),
 * so a retried notification is never processed twice and a failed one can be retried from Sales → Meta Leads.
 */

const GRAPH = () => `https://graph.facebook.com/${config.META_GRAPH_VERSION}`;
export const MAX_ATTEMPTS = 5;

export const metaReady = () => ({
  appSecret: !!config.META_APP_SECRET,
  verifyToken: !!config.META_VERIFY_TOKEN,
  pageToken: !!config.META_PAGE_TOKEN,
  graphVersion: config.META_GRAPH_VERSION,
});

/** X-Hub-Signature-256 = "sha256=" + HMAC-SHA256(rawBody, appSecret). */
export function verifySignature(raw: Buffer | undefined, header: string | undefined): boolean {
  if (!config.META_APP_SECRET || !raw || !header) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', config.META_APP_SECRET).update(raw).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function graphGet(path: string, params: Record<string, string> = {}): Promise<any> {
  const qs = new URLSearchParams({ ...params, access_token: config.META_PAGE_TOKEN });
  const res = await fetch(`${GRAPH()}/${path}?${qs.toString()}`);
  const body: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error?.message ? `Meta: ${body.error.message}` : `Meta request failed (${res.status})`);
  return body;
}

/** Checks the Page token works; returns the Page name. */
export async function checkToken(): Promise<{ ok: boolean; name?: string; id?: string; error?: string }> {
  if (!config.META_PAGE_TOKEN) return { ok: false, error: 'META_PAGE_TOKEN is not set on the server' };
  try { const r = await graphGet('me', { fields: 'id,name' }); return { ok: true, name: r.name, id: r.id }; }
  catch (e) { return { ok: false, error: (e as Error).message }; }
}

type Answers = Record<string, string>;
const norm = (k: string) => k.toLowerCase().replace(/[^a-z0-9]+/g, '_');
function answersOf(fieldData: { name: string; values?: string[] }[] | undefined): Answers {
  const out: Answers = {};
  for (const f of fieldData || []) out[norm(f.name)] = (f.values || []).join(', ').trim();
  return out;
}
const pick = (a: Answers, ...keys: string[]) => { for (const k of keys) if (a[k]) return a[k]; return ''; };

export interface ParsedLead { name: string; phone: string; email: string; city: string; course: string; extra: [string, string][] }
export function parseAnswers(fieldData: { name: string; values?: string[] }[] | undefined): ParsedLead {
  const a = answersOf(fieldData);
  const name = pick(a, 'full_name', 'name') || [a.first_name, a.last_name].filter(Boolean).join(' ');
  const phone = pick(a, 'phone_number', 'phone', 'mobile_number', 'mobile', 'whatsapp_number');
  const email = pick(a, 'email', 'email_address');
  const city = pick(a, 'city', 'location', 'town');
  const courseKey = Object.keys(a).find((k) => k.includes('course') || k.includes('interested_in') || k.includes('program'));
  const used = new Set(['full_name', 'name', 'first_name', 'last_name', 'phone_number', 'phone', 'mobile_number', 'mobile', 'whatsapp_number', 'email', 'email_address', 'city', 'location', 'town']);
  const extra = Object.entries(a).filter(([k, v]) => v && !used.has(k)).map(([k, v]) => [k.replace(/_/g, ' '), v] as [string, string]);
  return { name, phone, email, city, course: courseKey ? a[courseKey] : '', extra };
}

async function getConfig() {
  return prisma.metaLeadConfig.upsert({ where: { id: 'default' }, create: { id: 'default' }, update: {} });
}

/** Owner for a new lead per the Sales → Meta Leads settings (undefined = My Base). */
async function pickOwner(cfg: Awaited<ReturnType<typeof getConfig>>): Promise<string | undefined> {
  if (cfg.assignMode === 'FIXED' && cfg.fixedOwnerId) return cfg.fixedOwnerId;
  if (cfg.assignMode === 'ROUND_ROBIN') {
    const ids = (cfg.roundRobinIds || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (!ids.length) return undefined;
    const bumped = await prisma.metaLeadConfig.update({ where: { id: 'default' }, data: { rrCursor: { increment: 1 } }, select: { rrCursor: true } });
    return ids[(bumped.rrCursor - 1) % ids.length];
  }
  return undefined;
}

/** "formId or form name = Course" lines → course for this form. */
function courseFor(cfg: { defaultCourse: string | null; formCourseMap: string | null }, formId: string, formName: string, fromAnswer: string): string {
  for (const line of (cfg.formCourseMap || '').split('\n')) {
    const i = line.indexOf('=');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase(), v = line.slice(i + 1).trim();
    if (k && v && (k === formId.toLowerCase() || (formName && k === formName.toLowerCase()))) return v;
  }
  return fromAnswer || cfg.defaultCourse || '';
}

/** Process one leadgen notification. Safe to call repeatedly — a PROCESSED/DUPLICATE event is returned untouched. */
export async function processLeadgen(leadgenId: string, hint: { formId?: string; pageId?: string } = {}) {
  let ev = await prisma.metaLeadEvent.upsert({
    where: { leadgenId }, update: {},
    create: { leadgenId, formId: hint.formId || null, pageId: hint.pageId || null },
  });
  if (ev.status === 'PROCESSED' || ev.status === 'DUPLICATE') return ev;
  const cfg = await getConfig();
  try {
    ev = await prisma.metaLeadEvent.update({ where: { id: ev.id }, data: { attempts: { increment: 1 } } });
    const lead = await graphGet(leadgenId, { fields: 'id,created_time,field_data,form_id,ad_id,ad_name,adset_name,campaign_name,platform,is_organic' });
    const formId = String(lead.form_id || hint.formId || '');
    let formName = '';
    if (formId) { try { formName = (await graphGet(formId, { fields: 'name' })).name || ''; } catch { /* optional */ } }
    const p = parseAnswers(lead.field_data);
    if (!p.phone) throw new Error('The form has no phone number answer — nothing to call the lead on');
    const name = p.name || 'Meta lead';
    const course = courseFor(cfg, formId, formName, p.course);
    const campaign = String(lead.campaign_name || '');

    const noteLines = [
      `Meta Lead Ad${lead.platform ? ` (${lead.platform === 'ig' ? 'Instagram' : lead.platform === 'fb' ? 'Facebook' : lead.platform})` : ''}`,
      campaign && `Campaign: ${campaign}`, lead.adset_name && `Ad set: ${lead.adset_name}`, lead.ad_name && `Ad: ${lead.ad_name}`, formName && `Form: ${formName}`,
      ...p.extra.map(([k, v]) => `${k}: ${v}`),
    ].filter(Boolean) as string[];
    const note = noteLines.join(' · ');

    const dup = await findDuplicateLead(p.phone);
    if (dup) {
      await prisma.leadNote.create({ data: { leadId: dup.id, authorId: null, body: `Enquired again via Meta Lead Ad — ${note}` } }).catch(() => {});
      await prisma.leadHistory.create({ data: { leadId: dup.id, actorId: null, type: 'NOTE', summary: `Enquired again via Meta Lead Ad${campaign ? ` (${campaign})` : ''}` } }).catch(() => {});
      return prisma.metaLeadEvent.update({ where: { id: ev.id }, data: { status: 'DUPLICATE', leadId: dup.id, name, phone: p.phone, campaign, formId: formId || null, error: null } });
    }

    await ensureSource('Meta');
    const assignedToId = await pickOwner(cfg);
    const created = await prisma.lead.create({
      data: {
        name, phone: p.phone, phoneKey: leadPhoneKey(p.phone), email: p.email || null, city: p.city || null, source: 'Meta',
        courseInterest: course || null, notes: note, assignedToId, assignedAt: assignedToId ? new Date() : undefined,
      },
    });
    await prisma.leadHistory.create({ data: { leadId: created.id, actorId: null, type: 'CREATED', summary: `Lead created from Meta Lead Ads${campaign ? ` (campaign: ${campaign})` : ''}${assignedToId ? '' : ', placed in My Base'}`, toValue: 'Meta' } }).catch(() => {});
    await prisma.metaLeadEvent.update({ where: { id: ev.id }, data: { status: 'PROCESSED', leadId: created.id, name, phone: p.phone, campaign, formId: formId || null, error: null } });
    await prisma.metaLeadConfig.update({ where: { id: 'default' }, data: { lastLeadAt: new Date(), lastError: null } });
    if (assignedToId) emailAdvisorNewLeads(assignedToId, [created.id], { via: 'Meta lead ad' });
    return ev;
  } catch (e) {
    const msg = (e as Error).message || 'Failed';
    await prisma.metaLeadConfig.update({ where: { id: 'default' }, data: { lastError: msg.slice(0, 500) } }).catch(() => {});
    return prisma.metaLeadEvent.update({ where: { id: ev.id }, data: { status: 'FAILED', error: msg.slice(0, 1000) } });
  }
}

/** Cron: retry notifications that failed (Meta hiccup, token problem) up to MAX_ATTEMPTS times. */
export async function retryFailedMetaLeads(): Promise<number> {
  const cfg = await getConfig();
  if (!cfg.enabled) return 0;
  const due = await prisma.metaLeadEvent.findMany({ where: { status: 'FAILED', attempts: { lt: MAX_ATTEMPTS } }, orderBy: { createdAt: 'asc' }, take: 20 });
  for (const e of due) await processLeadgen(e.leadgenId, { formId: e.formId || undefined, pageId: e.pageId || undefined });
  return due.length;
}

export { getConfig as getMetaConfig };
