/**
 * Removes SALES test data: leads and everything hanging off them (calls, notes, history, tasks,
 * demos + student reviews, onboarding, fee plans/instalments/collections, transcripts, loan/jodo rows).
 *
 * KEEPS: employees, users, Sales config (stages/sources/scouts), course fees, team mapping, targets,
 *        devices, report-sheet layouts, and any lead that already became a real Student record.
 *
 * Usage (from the backend folder on the server):
 *   npx ts-node scripts/clear-sales-test-data.ts                       -> DRY RUN, only prints counts
 *   npx ts-node scripts/clear-sales-test-data.ts --confirm             -> actually deletes everything
 *   npx ts-node scripts/clear-sales-test-data.ts --before=2026-11-01 --confirm
 *                                                                      -> only leads created BEFORE that date (go-live date)
 *   add --include-students to also delete leads that have a Student record (normally protected)
 */
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';

const prisma = new PrismaClient();
const args = process.argv.slice(2);
const confirm = args.includes('--confirm');
const includeStudents = args.includes('--include-students');
const before = args.find((a) => a.startsWith('--before='))?.split('=')[1];

async function main() {
  const where: any = {};
  if (before) {
    const d = new Date(`${before}T00:00:00+05:30`);
    if (isNaN(d.getTime())) throw new Error('--before must be YYYY-MM-DD');
    where.createdAt = { lt: d };
  }
  const all = await prisma.lead.findMany({ where, select: { id: true } });
  let ids = all.map((l) => l.id);
  if (!includeStudents) {
    const linked = await prisma.student.findMany({ where: { leadId: { in: ids } }, select: { leadId: true } });
    const protectedIds = new Set(linked.map((s) => s.leadId as string));
    ids = ids.filter((i) => !protectedIds.has(i));
    console.log(`Protected (already real students): ${protectedIds.size}`);
  }
  console.log(`Leads to delete: ${ids.length}${before ? ` (created before ${before})` : ' (all)'}`);

  const inLead = { leadId: { in: ids } };
  const demos = await prisma.demo.findMany({ where: inLead, select: { id: true } });
  const demoIds = demos.map((d) => d.id);
  const plans = await prisma.feePaymentPlan.findMany({ where: inLead, select: { id: true } });
  const planIds = plans.map((p) => p.id);
  const insts = await prisma.feeInstallment.findMany({ where: { planId: { in: planIds } }, select: { id: true, proofFile: true } });
  const instIds = insts.map((i) => i.id);

  const counts: Record<string, number> = {
    demos: demoIds.length, feePlans: planIds.length, installments: instIds.length,
    callLogs: await prisma.leadCallLog.count({ where: inLead }), notes: await prisma.leadNote.count({ where: inLead }),
    history: await prisma.leadHistory.count({ where: inLead }), tasks: await prisma.salesTask.count({ where: inLead }),
    collections: await prisma.feeCollection.count({ where: inLead }), transcripts: await prisma.callTranscript.count({ where: inLead }),
    demoRequests: await prisma.demoSessionRequest.count({ where: inLead }),
    loanEntries: await prisma.loanEntry.count({ where: before ? inLead : {} }), jodoRows: await prisma.jodoSettlement.count({ where: before ? inLead : {} }),
  };
  console.table(counts);
  if (!confirm) { console.log('\nDRY RUN — nothing deleted. Re-run with --confirm to delete.'); return; }
  if (!ids.length) { console.log('Nothing to delete.'); return; }

  await prisma.$transaction(async (tx) => {
    await tx.salesTask.deleteMany({ where: { OR: [inLead, { demoId: { in: demoIds } }, { installmentId: { in: instIds } }] } });
    await tx.feeReminderLog.deleteMany({ where: { installmentId: { in: instIds } } });
    await tx.feeInstallment.deleteMany({ where: { id: { in: instIds } } });
    await tx.feePaymentPlan.deleteMany({ where: { id: { in: planIds } } });
    await tx.feeCollection.deleteMany({ where: inLead });
    await tx.leadOnboarding.deleteMany({ where: inLead });
    await tx.demoFeedback.deleteMany({ where: { demoId: { in: demoIds } } });
    await tx.demo.updateMany({ where: { id: { in: demoIds } }, data: { rescheduledFromId: null } });
    await tx.demo.deleteMany({ where: { id: { in: demoIds } } });
    await tx.demoSessionRequest.deleteMany({ where: inLead });
    await tx.callTranscript.deleteMany({ where: inLead });
    await tx.leadCallLog.deleteMany({ where: inLead });
    await tx.leadNote.deleteMany({ where: inLead });
    await tx.leadHistory.deleteMany({ where: inLead });
    await tx.loanEntry.deleteMany({ where: before ? inLead : {} });
    await tx.jodoSettlement.deleteMany({ where: before ? inLead : {} });
    await tx.lead.deleteMany({ where: { id: { in: ids } } });
  }, { timeout: 300000, maxWait: 30000 });

  // Payment screenshots are stored as files; remove the ones that belonged to the deleted instalments.
  const dir = path.join(process.cwd(), 'private-uploads', 'payment-proofs');
  let files = 0;
  for (const i of insts) if (i.proofFile) { try { fs.unlinkSync(path.join(dir, i.proofFile)); files++; } catch { /* already gone */ } }
  console.log(`\nDONE. Deleted ${ids.length} leads and their related data; removed ${files} screenshot files.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
