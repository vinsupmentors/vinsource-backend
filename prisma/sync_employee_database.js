/**
 * sync_employee_database.js
 * ─────────────────────────
 * Aligns the live DB with the official "Employee database" sheet (July 2026):
 *   • sets each employee's employeeCode to the official V-code
 *   • sets each employee's reporting manager
 *   • sets status (ACTIVE / ON_PROBATION) and joiningDate
 *
 * Matching: by existing employeeCode first, then by normalized name.
 * Code renumbering is two-phase (temp codes first) so swaps can't hit the
 * unique constraint.
 *
 * Usage (on the VPS, from /opt/hrms/vinsource-backend):
 *   node prisma/sync_employee_database.js           # DRY RUN — prints the plan only
 *   node prisma/sync_employee_database.js --apply   # actually writes changes
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');

// Official dataset: [name, code, managerCode|null, confirmed?, joiningDate]
const DATASET = [
  ['Pooranam Annamalai',        'V7007', null,    true,  null],
  ['Clement Sudharson',         'V7000', 'V7007', true,  '2024-10-01'],
  ['Gokul S',                   'V7003', 'V7007', true,  '2025-03-17'],
  ['Kumaresan R',               'V7006', 'V7003', true,  '2025-03-17'],
  ['Hariharan',                 'V7011', 'V7003', true,  '2025-04-21'],
  ['Muhammad Ramees J',         'V7012', 'V7003', true,  '2025-04-21'],
  ['Shabir Ahmed S',            'V7016', 'V7003', true,  '2025-04-21'],
  ['Muneeswari',                'V7017', 'V7048', true,  '2025-04-22'],
  ['Jothimalar S',              'V7020', 'V7003', true,  '2025-04-21'],
  ['Nishanthini S',             'V7029', 'V7003', true,  '2025-07-02'],
  ['Midhun K',                  'V7030', 'V7003', true,  '2025-07-02'],
  ['Gaurav Kumar M S',          'V7032', 'V7007', true,  '2025-07-03'],
  ['Selvakumar Santhanam',      'V7037', 'V7007', true,  '2025-10-03'],
  ['Pradhap M',                 'V7040', 'V7003', true,  '2025-12-15'],
  ['Steffi S',                  'V7044', 'V7048', true,  '2026-01-19'],
  ['Ranjith S',                 'V7045', 'V7003', true,  '2026-02-01'],
  ['Hariharashuthan A',         'V7046', 'V7003', true,  '2026-02-01'],
  ['Jayasoorya Subramanian M',  'V7048', 'V7007', true,  '2026-04-01'],
  ['Danush V K',                'V7049', 'V7000', false, '2026-03-02'],
  ['Ramya',                     'V7051', 'V7003', false, '2026-04-01'],
  ['Athithyan J',               'V7052', 'V7032', false, '2026-04-01'],
  ['Sneha M',                   'V7053', 'V7000', false, '2026-04-06'],
  ['Vishmitha V',               'V7054', 'V7003', false, '2026-04-06'],
  ['Micheal Steafun Babu D',    'V7055', 'V7003', false, '2026-04-06'],
  ['Shrihari BH',               'V7056', 'V7032', false, '2026-04-13'],
  ['Dhivya V',                  'V7057', 'V7032', false, '2026-04-27'],
  ['Prakalya P',                'V7058', 'V7032', false, '2026-05-06'],
  ['Samjebadurai Govindaraj',   'V7059', 'V7000', false, '2026-05-16'],
  ['Selvam T',                  'V7060', 'V7032', false, '2026-05-25'],
  ['Nancy',                     'V7061', 'V7032', false, '2026-06-01'],
  ['Kalaivani Ramesh',          'V7062', 'V7032', false, '2026-06-03'],
  ['Varththini V',              'V7063', 'V7032', false, '2026-06-03'],
  ['Yureka',                    'V7064', 'V7048', false, '2026-07-01'],
  ['Raj Prasanth',              'V7065', 'V7048', false, '2026-07-01'],
];

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');

function nameMatches(dsName, emp) {
  const full = norm(emp.firstName + emp.lastName);
  const target = norm(dsName);
  if (!full || !target) return false;
  if (full === target) return true;
  // Tolerate trailing initials on either side: "jayasoorya subramanian m" vs "jayasoorya subramanian"
  if (full.startsWith(target) || target.startsWith(full)) {
    return Math.abs(full.length - target.length) <= 3;
  }
  return false;
}

async function main() {
  console.log(APPLY ? '=== APPLY MODE ===' : '=== DRY RUN (pass --apply to write) ===');

  const employees = await prisma.employee.findMany({
    select: { id: true, firstName: true, lastName: true, employeeCode: true, status: true, managerId: true, joiningDate: true },
  });
  console.log(`DB employees: ${employees.length} | dataset rows: ${DATASET.length}\n`);

  // ── Match dataset rows to DB employees ──────────────────────────────────
  const byRowCode = {};       // official code -> db employee
  const matchedIds = new Set();
  const missing = [];

  for (const [name, code] of DATASET) {
    let emp = employees.find((e) => e.employeeCode.toUpperCase() === code && !matchedIds.has(e.id));
    if (!emp) emp = employees.find((e) => nameMatches(name, e) && !matchedIds.has(e.id));
    if (emp) { byRowCode[code] = emp; matchedIds.add(emp.id); }
    else missing.push(`${name} (${code})`);
  }

  const extras = employees.filter((e) => !matchedIds.has(e.id));

  if (missing.length) {
    console.log('⚠ Not found in DB (create via Employees → Add Employee, set the code manually):');
    missing.forEach((m) => console.log('   -', m));
    console.log();
  }
  if (extras.length) {
    console.log('⚠ In DB but NOT in the official sheet (left untouched):');
    extras.forEach((e) => console.log(`   - ${e.firstName} ${e.lastName} [${e.employeeCode}] status=${e.status}`));
    console.log();
  }

  // ── Plan changes ────────────────────────────────────────────────────────
  const plan = [];
  for (const [name, code, mgrCode, confirmed, doj] of DATASET) {
    const emp = byRowCode[code];
    if (!emp) continue;
    const changes = {};
    if (emp.employeeCode.toUpperCase() !== code) changes.employeeCode = `${emp.employeeCode} → ${code}`;
    const mgr = mgrCode ? byRowCode[mgrCode] : null;
    const wantMgrId = mgr ? mgr.id : null;
    if (mgrCode && !mgr) console.log(`⚠ Manager ${mgrCode} for ${name} not matched — skipping manager update for this row`);
    else if (emp.managerId !== wantMgrId) changes.manager = mgrCode || 'none';
    const wantStatus = confirmed ? 'ACTIVE' : 'ON_PROBATION';
    if (!['RESIGNED', 'TERMINATED'].includes(emp.status) && emp.status !== wantStatus) changes.status = `${emp.status} → ${wantStatus}`;
    if (doj) {
      const want = new Date(doj + 'T00:00:00Z');
      if (Math.abs(new Date(emp.joiningDate).getTime() - want.getTime()) > 86400000 * 2) {
        changes.joiningDate = `${new Date(emp.joiningDate).toISOString().slice(0, 10)} → ${doj}`;
      }
    }
    if (Object.keys(changes).length) plan.push({ name, code, emp, mgrId: mgrCode && byRowCode[mgrCode] ? byRowCode[mgrCode].id : (mgrCode ? undefined : null), confirmed, doj, changes });
  }

  if (!plan.length) { console.log('✓ Everything already in sync.'); return; }

  console.log(`Planned updates (${plan.length}):`);
  plan.forEach((p) => console.log(`   ${p.name.padEnd(28)} ${JSON.stringify(p.changes)}`));

  if (!APPLY) { console.log('\nDry run complete. Re-run with --apply to write.'); return; }

  // ── Phase 1: move colliding codes out of the way ────────────────────────
  const codeChanges = plan.filter((p) => p.changes.employeeCode);
  for (const p of codeChanges) {
    await prisma.employee.update({ where: { id: p.emp.id }, data: { employeeCode: `TMP_${p.emp.id.slice(0, 12)}` } });
  }
  // ── Phase 2: final codes ────────────────────────────────────────────────
  for (const p of codeChanges) {
    await prisma.employee.update({ where: { id: p.emp.id }, data: { employeeCode: p.code } });
  }
  // ── Phase 3: manager / status / joiningDate ─────────────────────────────
  for (const p of plan) {
    const data = {};
    if (p.changes.manager !== undefined && p.mgrId !== undefined) data.managerId = p.mgrId;
    if (p.changes.status) data.status = p.confirmed ? 'ACTIVE' : 'ON_PROBATION';
    if (p.changes.joiningDate && p.doj) data.joiningDate = new Date(p.doj + 'T00:00:00Z');
    if (Object.keys(data).length) await prisma.employee.update({ where: { id: p.emp.id }, data });
  }

  console.log(`\n✓ Applied ${plan.length} update(s). New joiners will now get codes from V7066 onward automatically.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
