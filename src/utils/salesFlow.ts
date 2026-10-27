import { LeadStatus, LeadLostReason, LeadActivityStatus } from '@prisma/client';
import prisma from '../config/database';
import { resolveStage } from './leadConfig';
import { closeRoom } from '../services/liveKit.service';

/**
 * Shared rules that keep leads, demos and tasks in step:
 *  - every open follow-up is a task (kind FOLLOW_UP) and every booked demo is a task (kind DEMO);
 *  - finishing a demo (ending the room, "Mark conducted", or moving the lead to Demo over) completes the demo task;
 *  - a recorded demo outcome moves the lead stage (OUTCOME_PLAN below).
 */

const IST = 'Asia/Kolkata';
export const fmtIST = (d: Date | null | undefined) => (d ? d.toLocaleString('en-IN', { timeZone: IST, dateStyle: 'medium', timeStyle: 'short' }) : 'none');

async function history(leadId: string, actorId: string | null | undefined, type: string, summary: string, from?: string | null, to?: string | null) {
  try { await prisma.leadHistory.create({ data: { leadId, actorId: actorId || null, type, summary, fromValue: from ?? null, toValue: to ?? null } }); }
  catch (e) { console.error('Lead history write failed', e); }
}

// ── Follow-up tasks ───────────────────────────────────────────────────────────

/**
 * Makes the lead's follow-up date a task for its owner. Any earlier open follow-up task is
 * marked done (it was superseded by this contact); `dueAt = null` just closes them.
 */
export async function syncFollowUpTask(leadId: string, assigneeId: string | null | undefined, dueAt: Date | null, actorId?: string | null, hint?: string) {
  await prisma.salesTask.updateMany({ where: { leadId, kind: 'FOLLOW_UP', status: 'OPEN' }, data: { status: 'DONE', completedAt: new Date() } });
  if (!dueAt || !assigneeId) return null;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { name: true } });
  return prisma.salesTask.create({
    data: {
      title: `Follow up with ${lead?.name ?? 'lead'}`, description: hint || null, leadId, assignedToId: assigneeId,
      createdById: actorId || null, dueAt, kind: 'FOLLOW_UP',
    },
  });
}

/** Lead changed hands: every open task on it moves to the new owner. */
export async function moveOpenTasks(leadId: string, newAssigneeId: string | null) {
  if (!newAssigneeId) return;
  await prisma.salesTask.updateMany({ where: { leadId, status: 'OPEN', kind: { in: ['FOLLOW_UP', 'DEMO'] } }, data: { assignedToId: newAssigneeId } });
}

// ── Demo tasks ────────────────────────────────────────────────────────────────

export async function upsertDemoTask(demoId: string, actorId?: string | null) {
  const d = await prisma.demo.findUnique({ where: { id: demoId }, select: { id: true, scheduledAt: true, courseEnquired: true, conductedById: true, mode: true, lead: { select: { id: true, name: true, assignedToId: true } } } });
  if (!d) return null;
  const assignee = d.conductedById || d.lead.assignedToId;
  if (!assignee) return null;
  const title = `${d.mode === 'ONLINE' ? 'Online demo' : 'Demo'} with ${d.lead.name}${d.courseEnquired ? ` — ${d.courseEnquired}` : ''}`;
  const existing = await prisma.salesTask.findFirst({ where: { demoId, kind: 'DEMO', status: 'OPEN' } });
  if (existing) return prisma.salesTask.update({ where: { id: existing.id }, data: { title, dueAt: d.scheduledAt, assignedToId: assignee } });
  return prisma.salesTask.create({ data: { title, leadId: d.lead.id, assignedToId: assignee, createdById: actorId || null, dueAt: d.scheduledAt, kind: 'DEMO', demoId } });
}

/** DONE when the demo happened (or the prospect didn't show), CANCELLED when it was cancelled / moved. */
export async function closeDemoTask(demoId: string, outcome: 'DONE' | 'CANCELLED') {
  await prisma.salesTask.updateMany({ where: { demoId, kind: 'DEMO', status: 'OPEN' }, data: { status: outcome, completedAt: outcome === 'DONE' ? new Date() : null } });
}

// ── Demo outcome → lead stage ─────────────────────────────────────────────────

/** What each outcome does to the lead. followUpDays = default follow-up if the caller did not pick a date. */
export const OUTCOME_PLAN: Record<string, { stage: string; status: LeadActivityStatus; followUpDays: number | null; label: string }> = {
  INTERESTED:     { stage: 'CUSTOM_DEMO_OVER_POSITIVE', status: 'DEMO_OVER',      followUpDays: null, label: 'Interested' },
  FIFTY_FIFTY:    { stage: 'CUSTOM_DEMO_OVER_FOLLOW_UP', status: 'DEMO_OVER',      followUpDays: 2,    label: '50-50' },
  NEED_FOLLOWUP:  { stage: 'CUSTOM_DEMO_OVER_FOLLOW_UP', status: 'DEMO_OVER',      followUpDays: 1,    label: 'Needs follow-up' },
  NOT_INTERESTED: { stage: 'CUSTOM_NOT_INTERESTED',        status: 'NOT_INTERESTED', followUpDays: null, label: 'Not interested' },
};

/** A demo's slot doubles as the lead's reminder — keep that reminder in step when the demo moves or finishes. */
export async function moveDemoReminder(leadId: string, oldAt: Date | null | undefined, newAt: Date | null) {
  if (!oldAt) return;
  await prisma.lead.updateMany({ where: { id: leadId, nextFollowUpAt: oldAt }, data: { nextFollowUpAt: newAt } });
}

export async function applyDemoOutcome(leadId: string, outcome: string, actorId?: string | null, followUpAt?: Date | null) {
  const plan = OUTCOME_PLAN[outcome];
  if (!plan) return;
  const lead = await prisma.lead.findUnique({ where: { id: leadId }, select: { status: true, stageKey: true, assignedToId: true } });
  if (!lead) return;
  const stage = await resolveStage(plan.stage);
  const next = followUpAt ?? (plan.followUpDays ? new Date(Date.now() + plan.followUpDays * 86400000) : null);
  const lost = stage.status === 'LOST';
  if (next && !followUpAt) next.setHours(11, 0, 0, 0);
  await prisma.lead.update({
    where: { id: leadId },
    data: {
      status: stage.status as LeadStatus, stageKey: stage.stageKey, activityStatus: plan.status, statusKey: null,
      nextFollowUpAt: lost ? null : next,
      lostReason: lost ? LeadLostReason.NOT_INTERESTED : null, lostReasonKey: null,
      lastContactAt: new Date(),
    },
  });
  await syncFollowUpTask(leadId, lost ? null : lead.assignedToId, lost ? null : next, actorId, `After demo — ${plan.label}`);
  const before = lead.stageKey || lead.status;
  await history(leadId, actorId, 'DEMO', `Demo outcome: ${plan.label} → stage ${stage.label}${next && !lost ? `, follow-up ${fmtIST(next)}` : ''}`, before, stage.stageKey || stage.status);
}

/**
 * The lead was moved to "Demo over" / "Demo done" by hand: finish its scheduled demo so the demo
 * tab agrees. (Outcome stays empty — the demo card will ask for it.)
 */
export async function completeScheduledDemos(leadId: string, actorId?: string | null) {
  const open = await prisma.demo.findMany({ where: { leadId, status: 'SCHEDULED' }, select: { id: true, roomName: true, mode: true, startedAt: true, scheduledAt: true } });
  for (const d of open) {
    await moveDemoReminder(leadId, d.scheduledAt, null);
    await prisma.demo.update({ where: { id: d.id }, data: { status: 'COMPLETED', closedAt: d.roomName ? new Date() : undefined } });
    if (d.roomName) await closeRoom(d.roomName).catch(() => {});
    await closeDemoTask(d.id, 'DONE');
  }
  if (open.length) await history(leadId, actorId, 'DEMO', `Demo marked conducted (lead moved to Demo over)`);
  return open.length;
}
