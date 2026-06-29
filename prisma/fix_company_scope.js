// node prisma/fix_company_scope.js
//
// ROOT CAUSE of "Reports shows only 13 of 30+ employees" for Pooranam (SUPER_ADMIN):
//
// Two separate company rows exist in the DB:
//   - 'DEMO'   (from utils/seed.ts)      — the company Pooranam's real login
//                                          (pooranam.annamalai@hrms.com, code V7001)
//                                          is actually attached to.
//   - 'VINSUP' (from utils/seedRealOrg.ts, data/realOrg.json) — created later
//                                          when the full 32-person real roster
//                                          was imported.
//
// seedRealOrg.ts upserts employees by `employeeCode`. For the ~18 employees
// whose codes already existed (created earlier by seed_employees.js under
// DEMO), the upsert only touched dept/designation/status — NOT companyId — so
// those people stayed parked under DEMO. Only the codes that didn't exist yet
// (Pooranam-duplicate V7007, Jayasoorya-duplicate V7048, and 13 brand-new
// hires V7051–V7063) got created fresh under VINSUP, each as a NEW User row
// (different email domain), so Pooranam and Jayasoorya ended up with two
// separate logins/employee records apiece — one under each company.
//
// Net effect: Pooranam's actual login (V7001, DEMO) only ever sees the people
// who stayed on DEMO. The 13 brand-new hires (and the un-merged duplicate
// rows) live under VINSUP and never show up in any company-scoped query
// (Reports, dashboards, etc.) for her session.
//
// This script:
//   1. Re-points managerId references that pointed at the duplicate VINSUP
//      Pooranam (V7007) / Jayasoorya (V7048) rows back to the real, in-use
//      DEMO rows (V7001 / TMP-JAYA), so reporting lines stay intact.
//   2. Deactivates the two duplicate accounts so they don't show up as
//      phantom extra people in employee lists.
//   3. Moves every remaining VINSUP-company employee (the 13 new hires) onto
//      DEMO, so they show up everywhere Pooranam's session looks.
//
// Safe to re-run (idempotent).

const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

const DUPLICATE_PAIRS = [
  { legacyCode: 'V7001',    dupCode: 'V7007', label: 'Pooranam Annamalai' },
  { legacyCode: 'TMP-JAYA', dupCode: 'V7048', label: 'Jayasoorya Subramanian M' },
];

async function main() {
  const demo = await p.company.findFirst({ where: { code: 'DEMO' } });
  const vinsup = await p.company.findFirst({ where: { code: 'VINSUP' } });

  if (!demo) { console.error('❌ Could not find company with code DEMO — aborting.'); process.exit(1); }
  if (!vinsup) { console.error('❌ Could not find company with code VINSUP — nothing to merge, aborting.'); process.exit(1); }

  console.log(`DEMO company id:   ${demo.id}`);
  console.log(`VINSUP company id: ${vinsup.id}`);
  console.log('');

  // ── 1 & 2: merge duplicate accounts ────────────────────────────────────────
  for (const { legacyCode, dupCode, label } of DUPLICATE_PAIRS) {
    const legacy = await p.employee.findUnique({ where: { employeeCode: legacyCode } });
    const dup = await p.employee.findUnique({ where: { employeeCode: dupCode } });

    if (!legacy) { console.warn(`⚠️  ${label}: legacy record ${legacyCode} not found — skipping merge`); continue; }
    if (!dup) { console.log(`✓ ${label}: no duplicate ${dupCode} found (already cleaned up) — skipping`); continue; }

    const moved = await p.employee.updateMany({
      where: { managerId: dup.id },
      data: { managerId: legacy.id },
    });
    console.log(`✅ ${label}: re-pointed ${moved.count} direct report(s) from ${dupCode} → ${legacyCode}`);

    await p.employee.update({ where: { id: dup.id }, data: { status: 'INACTIVE' } });
    await p.user.update({ where: { id: dup.userId }, data: { isActive: false } });
    console.log(`✅ ${label}: deactivated duplicate account ${dupCode}`);
  }

  console.log('');

  // ── 3: move every remaining VINSUP employee onto DEMO ─────────────────────
  const stranded = await p.employee.findMany({
    where: { companyId: vinsup.id },
    select: { employeeCode: true, firstName: true, lastName: true },
  });
  console.log(`Found ${stranded.length} employee(s) still on VINSUP:`);
  for (const e of stranded) console.log(`  - ${e.employeeCode} ${e.firstName} ${e.lastName}`);

  const result = await p.employee.updateMany({
    where: { companyId: vinsup.id },
    data: { companyId: demo.id },
  });
  console.log(`\n✅ Moved ${result.count} employee(s) from VINSUP → DEMO`);

  const totalNow = await p.employee.count({ where: { companyId: demo.id } });
  const activeNow = await p.employee.count({ where: { companyId: demo.id, status: { not: 'INACTIVE' } } });
  console.log(`\n📋 DEMO company now has ${totalNow} employee record(s) total (${activeNow} active).`);
  console.log('Reports / Dashboard / Employees for Pooranam\'s SUPER_ADMIN login should now show everyone.');
}

main().catch(console.error).finally(() => p.$disconnect());
