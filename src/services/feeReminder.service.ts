import prisma from '../config/database';
import { emailService } from './email.service';

function dateOnly(d: Date): Date {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, n: number): Date {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function fmtDate(d: Date): string {
  return d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

type PendingInstallment = Awaited<ReturnType<typeof loadPending>>[number];

async function loadPending() {
  return prisma.feeInstallment.findMany({
    where: { status: { in: ['PENDING', 'OVERDUE'] }, plan: { status: 'ACTIVE' } },
    include: {
      plan: {
        select: {
          courseName: true,
          lead: { select: { name: true, email: true, assignedTo: { select: { email: true } } } },
        },
      },
    },
  });
}

/** Sends (or skips, if already logged for today) one reminder — returns
 * whether it actually sent an email. Always writes the dedupe log row on
 * success, including when the lead has no email on file, so a lead that can
 * never be emailed doesn't get re-evaluated every single day forever. */
async function sendOne(inst: PendingInstallment, type: 'T5' | 'DUE' | 'OVERDUE', asOfDate: Date, daysOverdue?: number): Promise<boolean> {
  const already = await prisma.feeReminderLog.findUnique({
    where: { installmentId_type_asOfDate: { installmentId: inst.id, type, asOfDate } },
  });
  if (already) return false;

  const lead = inst.plan.lead;
  const email = (lead.email || '').trim();
  let didSend = false;
  if (email) {
    const cc: string[] = [];
    const advisorEmail = lead.assignedTo?.email?.trim();
    if (advisorEmail) cc.push(advisorEmail);
    try {
      await emailService.send({
        to: email,
        cc: cc.length ? cc : undefined,
        subject: type === 'T5' ? '⏰ Payment due in 5 days' : type === 'DUE' ? '⏰ Payment due today' : '🚨 Payment overdue',
        html: emailService.templates.feePaymentReminder({
          name: lead.name,
          courseName: inst.plan.courseName,
          amount: inst.amount,
          dueDate: fmtDate(inst.dueDate),
          kind: type,
          daysOverdue,
        }),
        template: 'fee_payment_reminder',
      });
      didSend = true;
    } catch (err) {
      console.error('Fee payment reminder email failed:', err);
    }
  }

  await prisma.feeReminderLog.create({ data: { installmentId: inst.id, type, asOfDate } });
  return didSend;
}

export const feeReminderService = {
  /**
   * Daily sweep across every PENDING/OVERDUE installment on an ACTIVE plan:
   * T-5 reminder 5 days before the due date, a DUE reminder on the due date
   * itself, and a repeating OVERDUE reminder every day thereafter until it's
   * collected (or the plan is cancelled) — per how Sales asked for this to
   * work. Flips PENDING -> OVERDUE the first day it's actually late.
   */
  async sendDueReminders(): Promise<{ sent: number; checked: number }> {
    const today = dateOnly(new Date());
    const t5Target = addDays(today, 5).getTime();

    const pending = await loadPending();
    let sent = 0;

    for (const inst of pending) {
      const due = dateOnly(inst.dueDate).getTime();
      let type: 'T5' | 'DUE' | 'OVERDUE' | null = null;
      let daysOverdue: number | undefined;

      if (due === t5Target) {
        type = 'T5';
      } else if (due === today.getTime()) {
        type = 'DUE';
      } else if (due < today.getTime()) {
        type = 'OVERDUE';
        daysOverdue = Math.round((today.getTime() - due) / 86400000);
        if (inst.status !== 'OVERDUE') {
          // eslint-disable-next-line no-await-in-loop
          await prisma.feeInstallment.update({ where: { id: inst.id }, data: { status: 'OVERDUE' } });
        }
      }
      if (!type) continue;

      // eslint-disable-next-line no-await-in-loop
      const didSend = await sendOne(inst, type, today, daysOverdue);
      if (didSend) sent++;
    }

    return { sent, checked: pending.length };
  },
};
