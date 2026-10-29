import prisma from '../config/database';
import { AppError } from '../middleware/errorHandler';
import { leadPhoneKey } from './leadPhone';
import { loadAdvisors } from './reportSheetsLive';

const IST_MS = 5.5 * 3600 * 1000;
const DAY = 86400000;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayStart = (s: string) => new Date(`${s}T00:00:00+05:30`);
const label = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();
const istParts = (d: Date) => { const t = new Date(d.getTime() + IST_MS); return { m: t.getUTCMonth(), y: t.getUTCFullYear() }; };

/** Optional date range: no from/to means "all time". */
function optRange(q: { from?: unknown; to?: unknown }) {
  const ok = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);
  const from = ok(q.from), to = ok(q.to);
  if (!from && !to) return { gte: undefined as Date | undefined, lt: undefined as Date | undefined, all: true };
  const f = from || to!, t = to || from!;
  const [a, b] = f <= t ? [f, t] : [t, f];
  const gte = dayStart(a), lt = new Date(dayStart(b).getTime() + DAY);
  if ((lt.getTime() - gte.getTime()) / DAY > 800) throw new AppError('Choose a shorter range', 400);
  return { gte, lt, all: false };
}
const between = (r: { gte?: Date; lt?: Date }) => (r.gte && r.lt ? { gte: r.gte, lt: r.lt } : undefined);

const courseType = (o: { mode: string; daysType: string } | null | undefined) => (o ? `${label(o.mode)} - ${label(o.daysType)}${o.daysType === 'WEEKDAY' ? ' (Mon - Fri)' : ' (Sat & Sun)'}` : '');

// ── Approval: every payment sales has put through, and what Finance did with it ──
export async function approval(q: { from?: unknown; to?: unknown }) {
  const r = optRange(q);
  const rows = await prisma.feeInstallment.findMany({
    where: { OR: [{ status: { in: ['PENDING_APPROVAL', 'PAID'] } }, { rejectedAt: { not: null } }], paidAt: between(r) ?? { not: null } },
    include: {
      approvedBy: { select: { firstName: true, lastName: true } },
      plan: { select: { id: true, courseName: true, totalFee: true, planType: true, lead: { select: { id: true, name: true, phone: true, email: true, source: true, assignedToId: true, onboarding: { select: { daysType: true, timing: true, mode: true } } } }, installments: { select: { id: true, paidAt: true } } } },
    },
    orderBy: { paidAt: 'desc' },
    take: 3000,
  });
  const owners = rows.map((x) => x.plan.lead.assignedToId || x.receivedById || '').filter(Boolean);
  const advisors = await loadAdvisors(owners);
  const out = rows.map((x) => {
    const lead = x.plan.lead;
    const a = advisors.get(lead.assignedToId || x.receivedById || '');
    const first = x.plan.installments.filter((i) => i.paidAt).sort((p, q2) => p.paidAt!.getTime() - q2.paidAt!.getTime())[0];
    const p = istParts(x.paidAt || x.createdAt);
    const status = x.rejectedAt ? 'Rejected' : x.status === 'PAID' ? 'Approved' : 'With Finance';
    const kind = x.kind === 'EMI' ? `EMI ${x.emiMonthNumber ?? ''}`.trim() : x.kind === 'DOWN_PAYMENT' ? 'Down payment' : x.kind === 'REGISTRATION_FEE' ? 'Registration' : '';
    return {
      id: x.id, at: x.paidAt || x.createdAt, advisor: a?.name || '—', tl: a?.tl || '—',
      selection: first && first.id === x.id ? 'New Student' : 'Existing Student', student: lead.name, email: lead.email || '', phone: lead.phone,
      course: x.plan.courseName, courseFees: x.plan.totalFee, slot: lead.onboarding ? label(lead.onboarding.timing) : '', courseType: courseType(lead.onboarding), source: lead.source || '',
      amount: x.amount, mode: x.mode ? x.mode.replace('_', ' ') : '', reference: x.reference || '', hasProof: !!x.proofFile, amountMatched: x.amountMatched, ocrAmount: x.ocrAmount,
      kind, status, approvedBy: x.approvedBy ? `${x.approvedBy.firstName} ${x.approvedBy.lastName}`.trim() : '', approvedAt: x.approvedAt, rejectReason: x.rejectReason || '',
      month: `${MONTHS[p.m]} ${String(p.y).slice(2)}`, onboarded: lead.onboarding ? 'Yes' : 'No',
    };
  });
  const sum = (f: (x: (typeof out)[number]) => boolean) => out.filter(f).reduce((n, x) => n + x.amount, 0);
  return { rows: out, totals: { count: out.length, amount: sum(() => true), approved: sum((x) => x.status === 'Approved'), withFinance: sum((x) => x.status === 'With Finance'), rejected: sum((x) => x.status === 'Rejected') } };
}

// ── Payment Details: one line per student fee plan ──
export async function paymentDetails(q: { from?: unknown; to?: unknown }) {
  const r = optRange(q);
  const plans = await prisma.feePaymentPlan.findMany({
    where: { createdAt: between(r), lead: { deletedAt: null } },
    include: {
      installments: { select: { amount: true, status: true } },
      lead: { select: { id: true, name: true, phone: true, email: true, source: true, assignedToId: true, onboarding: { select: { daysType: true, timing: true, mode: true } } } },
    },
    orderBy: { createdAt: 'desc' },
    take: 3000,
  });
  const leadIds = plans.map((p) => p.leadId);
  const [students, schedules, advisors] = await Promise.all([
    prisma.student.findMany({ where: { leadId: { in: leadIds } }, select: { leadId: true, studentCode: true, track: true } }),
    prisma.batchCourseSchedule.findMany({ where: { id: { in: plans.map((p) => p.scheduleId).filter(Boolean) as string[] } }, select: { id: true, startDate: true } }),
    loadAdvisors(plans.map((p) => p.lead.assignedToId || p.createdById || '').filter(Boolean)),
  ]);
  const stu = new Map(students.map((s) => [s.leadId as string, s]));
  const sch = new Map(schedules.map((s) => [s.id, s.startDate]));
  const rows = plans.map((p) => {
    const live = p.installments.filter((i) => i.status !== 'WAIVED');
    const planSum = live.reduce((n, i) => n + i.amount, 0);
    const total = p.totalFee > 0 ? Math.max(p.totalFee, planSum) : planSum;
    const paid = live.filter((i) => i.status === 'PAID').reduce((n, i) => n + i.amount, 0);
    const awaiting = live.filter((i) => i.status === 'PENDING_APPROVAL').reduce((n, i) => n + i.amount, 0);
    const a = advisors.get(p.lead.assignedToId || p.createdById || '');
    const s = stu.get(p.leadId);
    const cd = istParts(p.createdAt);
    const start = p.scheduleId ? sch.get(p.scheduleId) : null;
    const bm = start ? istParts(start) : null;
    return {
      planId: p.id, leadId: p.leadId, date: p.createdAt, month: MONTHS[cd.m], year: cd.y, totalFees: total, paid, awaiting, balance: Math.max(0, total - paid),
      discontinued: p.status === 'CANCELLED' ? 'Yes' : 'No', refund: p.status === 'REFUNDED' || p.refundCompletedAt ? 'Yes' : 'No',
      advisor: a?.name || '—', tl: a?.tl || '—', student: p.lead.name, email: p.lead.email || '', phone: p.lead.phone, course: p.courseName, courseFees: p.totalFee,
      batchMonth: bm ? `${MONTHS[bm.m]} ${String(bm.y).slice(2)}` : '', courseType: courseType(p.lead.onboarding), slot: p.lead.onboarding ? label(p.lead.onboarding.timing) : '',
      batchConfirmation: s ? 'Confirmed' : '', studentId: s?.studentCode || '', emi: p.planType === 'EMI' ? 'EMI' : 'Non EMI', program: s ? String(s.track).replace(/_/g, '-') : '', source: p.lead.source || '',
    };
  });
  const t = rows.reduce((n, x) => ({ total: n.total + x.totalFees, paid: n.paid + x.paid, balance: n.balance + x.balance }), { total: 0, paid: 0, balance: 0 });
  return { rows, totals: { count: rows.length, ...t } };
}

// ── Loan: payments made through a lender ──
export async function loan(q: { from?: unknown; to?: unknown }) {
  const r = optRange(q);
  const rows = await prisma.loanEntry.findMany({ where: { paidOn: between(r) }, orderBy: { paidOn: 'desc' }, take: 3000 });
  const sum = (f: (x: (typeof rows)[number]) => number) => rows.reduce((n, x) => n + f(x), 0);
  return { rows, totals: { count: rows.length, emi: sum((x) => x.emiAmount), interest: sum((x) => x.interestAmount), vinsup: sum((x) => x.vinsupAmount), verified: rows.filter((x) => x.verified).length } };
}

export async function addLoan(b: Record<string, unknown>, userId?: string | null) {
  const studentName = String(b.studentName || '').trim();
  const paymentFor = String(b.paymentFor || '').trim();
  const emi = Number(b.emiAmount);
  const interest = b.interestAmount === undefined || b.interestAmount === '' ? 0 : Number(b.interestAmount);
  if (!studentName) throw new AppError('Enter the student name', 400);
  if (!paymentFor) throw new AppError('Enter what the payment is for (e.g. EMI - 1)', 400);
  if (!Number.isFinite(emi) || emi <= 0) throw new AppError('Enter the EMI amount', 400);
  if (!Number.isFinite(interest) || interest < 0) throw new AppError('Enter a valid interest amount', 400);
  const paidOn = b.paidOn ? new Date(String(b.paidOn)) : new Date();
  if (isNaN(paidOn.getTime())) throw new AppError('Enter a valid payment date', 400);
  const phone = b.phone ? String(b.phone).trim() : null;
  const key = leadPhoneKey(phone);
  const lead = key ? await prisma.lead.findFirst({ where: { phoneKey: key, deletedAt: null }, select: { id: true } }) : null;
  const txn = b.transactionId ? String(b.transactionId).trim().slice(0, 190) : null;
  if (txn && (await prisma.loanEntry.findFirst({ where: { transactionId: txn }, select: { id: true } }))) throw new AppError(`Transaction ID ${txn} is already entered`, 409);
  return prisma.loanEntry.create({
    data: {
      leadId: lead?.id || null, studentName, phone, email: b.email ? String(b.email).trim() : null, paymentFor, paidOn, emiAmount: emi, interestAmount: interest,
      vinsupAmount: b.vinsupAmount !== undefined && b.vinsupAmount !== '' ? Number(b.vinsupAmount) : Math.max(0, emi - interest), transactionId: txn,
      lender: b.lender ? String(b.lender).trim() : null, batch: b.batch ? String(b.batch).trim() : null, mode: b.mode ? String(b.mode).trim() : null,
      comments: b.comments ? String(b.comments).trim() : null, createdById: userId || null,
    },
  });
}

export async function editLoan(id: string, b: Record<string, unknown>) {
  const cur = await prisma.loanEntry.findUnique({ where: { id } });
  if (!cur) throw new AppError('Entry not found', 404);
  const data: Record<string, unknown> = {};
  const str = (k: string, max = 190) => { if (b[k] !== undefined) data[k] = String(b[k] ?? '').trim().slice(0, max) || null; };
  ['phone', 'email', 'lender', 'batch', 'mode'].forEach((k) => str(k));
  str('comments', 2000); str('transactionId');
  if (b.studentName !== undefined) { const n = String(b.studentName).trim(); if (!n) throw new AppError('Student name is required', 400); data.studentName = n; }
  if (b.paymentFor !== undefined) { const n = String(b.paymentFor).trim(); if (!n) throw new AppError('Payment for is required', 400); data.paymentFor = n; }
  for (const k of ['emiAmount', 'interestAmount', 'vinsupAmount']) if (b[k] !== undefined && b[k] !== '') { const n = Number(b[k]); if (!Number.isFinite(n) || n < 0) throw new AppError('Enter a valid amount', 400); data[k] = n; }
  if (b.paidOn) { const d = new Date(String(b.paidOn)); if (isNaN(d.getTime())) throw new AppError('Enter a valid payment date', 400); data.paidOn = d; }
  if (data.transactionId && data.transactionId !== cur.transactionId && (await prisma.loanEntry.findFirst({ where: { transactionId: data.transactionId as string, id: { not: id } }, select: { id: true } }))) throw new AppError('That transaction ID is already entered', 409);
  return prisma.loanEntry.update({ where: { id }, data });
}

export async function verifyLoan(id: string, verified: boolean, userId?: string | null) {
  return prisma.loanEntry.update({ where: { id }, data: { verified, verifiedById: verified ? userId || null : null, verifiedAt: verified ? new Date() : null } });
}

// ── Jodo: settlement export lines, matched to students ──
export async function jodo(q: { from?: unknown; to?: unknown }) {
  const r = optRange(q);
  const rows = await prisma.jodoSettlement.findMany({ where: { paidDate: between(r) }, orderBy: { paidDate: 'desc' }, take: 5000 });
  const leadIds = [...new Set(rows.map((x) => x.leadId).filter(Boolean) as string[])];
  const [leads, ours] = await Promise.all([
    prisma.lead.findMany({ where: { id: { in: leadIds } }, select: { id: true, name: true, assignedTo: { select: { firstName: true, lastName: true } } } }),
    prisma.feeInstallment.findMany({ where: { mode: 'JODO', reference: { in: rows.map((x) => x.paymentRef) } }, select: { reference: true, status: true } }),
  ]);
  const lm = new Map(leads.map((l) => [l.id, l]));
  const om = new Map(ours.map((o) => [o.reference as string, o.status]));
  const out = rows.map((x) => {
    const l = x.leadId ? lm.get(x.leadId) : undefined;
    const inPortal = om.get(x.paymentRef);
    return { ...x, matchedStudent: l?.name || '', advisor: l?.assignedTo ? `${l.assignedTo.firstName} ${l.assignedTo.lastName}`.trim() : '', portalPayment: inPortal ? (inPortal === 'PAID' ? 'Approved' : 'With Finance') : '' };
  });
  const sum = (f: (x: (typeof out)[number]) => number) => out.reduce((n, x) => n + f(x), 0);
  return { rows: out, totals: { count: out.length, amount: sum((x) => x.amount), fee: sum((x) => x.feeAmount || 0), unmatched: out.filter((x) => !x.leadId).length } };
}

const num = (v: unknown) => { const n = Number(String(v ?? '').replace(/[^0-9.\-]/g, '')); return Number.isFinite(n) ? n : 0; };
const dt = (v: unknown) => { if (!v) return null; const d = new Date(String(v)); return isNaN(d.getTime()) ? null : d; };
const txt = (v: unknown) => { const s = String(v ?? '').trim(); return s ? s.slice(0, 190) : null; };

export async function importJodo(rows: Record<string, unknown>[], userId?: string | null) {
  if (!Array.isArray(rows) || rows.length === 0) throw new AppError('The file has no rows', 400);
  if (rows.length > 5000) throw new AppError('Import up to 5000 rows at a time', 400);
  const refs = rows.map((r) => txt(r.paymentRef)).filter(Boolean) as string[];
  const existing = new Set((await prisma.jodoSettlement.findMany({ where: { paymentRef: { in: refs } }, select: { paymentRef: true } })).map((x) => x.paymentRef));
  const keys = [...new Set(rows.map((r) => leadPhoneKey(txt(r.phone))).filter(Boolean) as string[])];
  const leads = await prisma.lead.findMany({ where: { phoneKey: { in: keys }, deletedAt: null }, select: { id: true, phoneKey: true } });
  const byKey = new Map(leads.map((l) => [l.phoneKey as string, l.id]));
  let added = 0, skipped = 0, matched = 0;
  const seen = new Set<string>();
  const data = [];
  for (const r of rows) {
    const ref = txt(r.paymentRef);
    if (!ref || existing.has(ref) || seen.has(ref)) { skipped++; continue; }
    seen.add(ref);
    const leadId = byKey.get(leadPhoneKey(txt(r.phone)) || '') || null;
    if (leadId) matched++;
    data.push({
      paymentRef: ref, leadId, jodoStudentId: txt(r.jodoStudentId), studentName: txt(r.studentName) || 'Unknown', rollNumber: txt(r.rollNumber), instituteName: txt(r.instituteName),
      stream: txt(r.stream), grade: txt(r.grade), product: txt(r.product), payMode: txt(r.payMode), amount: num(r.amount), feeAmount: r.feeAmount === undefined || r.feeAmount === '' ? null : num(r.feeAmount),
      paidDate: dt(r.paidDate), settlementUtr: txt(r.settlementUtr), settlementBank: txt(r.settlementBank), settlementDate: dt(r.settlementDate), phone: txt(r.phone), importedById: userId || null,
    });
    added++;
  }
  if (data.length) await prisma.jodoSettlement.createMany({ data, skipDuplicates: true });
  return { added, skipped, matched };
}
