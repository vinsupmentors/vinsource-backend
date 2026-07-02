/**
 * sync_employee_database.js
 * ─────────────────────
 * Aligns the live DB with the official "Employee database" sheet (July 2026):
 *   • employeeCode  → official V-code
 *   • managerId     → official reporting manager
 *   • designation   → official designation (kept if current one is more specific)
 *   • status        → ACTIVE / ON_PROBATION (never touches RESIGNED/TERMINATED)
 *
 * ONLY fields that differ are written. Nothing else is modified.
 * Matching: exact code → exact normalized name → fuzzy name (trailing initials).
 *
 * Usage (on the VPS, from /opt/hrms/vinsource-backend):
 *   node prisma/sync_employee_database.js           # DRY RUN — prints the plan only
 *   node prisma/sync_employee_database.js --apply   # write the planned changes
 *   add --dates to also align joiningDate with the sheet (off by default)
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const APPLY = process.argv.includes('--apply');
const SYNC_DATES = process.argv.includes('--dates');

// [name, code, managerCode|null, confirmed?, joiningDate, designation|null]
const DATASET = [
  ['Pooranam Annamalai',       'V7007', null,    true,  null,         null],
  ['Clement Sudharson',        'V7000', 'V7007', true,  '2024-10-01', 'CGO'],
  ['Gokul S',                  'V7003', 'V7007', true,  '2025-03-17', 'VP - Sales'],
  ['Kumaresan R',              'V7006', 'V7003', true,  '2025-03-17', 'Team Lead - Sales'],
  ['Hariharan',                'V7011', 'V7003', true,  '2025-04-21', 'Team Lead - Sales'],
  ['Muhammad Ramees J',        'V7012', 'V7003', true,  '2025-04-21', 'Business Development Associate'],
  ['Shabir Ahmed S',           'V7016', 'V7003', true,  '2025-04-21', 'Business Development Associate'],
  ['Muneeswari',               'V7017', 'V7048', true,  '2025-04-22', 'Janitor'],
  ['Jothimalar S',             'V7020', 'V7003', true,  '2025-04-21', 'Business Development Associate'],
  ['Nishanthini S',            'V7029', 'V7003', true,  '2025-07-02', 'Business Development Associate'],
  ['Midhun K',                 'V7030', 'V7003', true,  '2025-07-02', 'Student Success Advisor'],
  ['Gaurav Kumar M S',         'V7032', 'V7007', true,  '2025-07-03', 'Learning Delivery Manager'],
  ['Selvakumar Santhanam',     'V7037', 'V7007', true,  '2025-10-03', 'Senior Business Development Manager - B2B'],
  ['Pradhap M',                'V7040', 'V7003', true,  '2025-12-15', 'Team Lead - Sales'],
  ['Steffi S',                 'V7044', 'V7048', true,  '2026-01-19', 'Receptionist - Ops'],
  ['Ranjith S',                'V7045', 'V7003', true,  '2026-02-01', 'Business Development Associate'],
  ['Hariharashuthan A',        'V7046', 'V7003', true,  '2026-02-01', 'Business Development Associate'],
  ['Jayasoorya Subramanian M', 'V7048', 'V7007', true,  '2026-04-01', 'Operation Manager - AGM'],
  ['Danush V K',               'V7049', 'V7000', false, '2026-03-02', 'Video Editor'],
  ['Ramya',                    'V7051', 'V7003', false, '2026-04-01', 'Business Development Associate'],
  ['Athithyan J',              'V7052', 'V7032', false, '2026-04-01', 'Skill Mentor'],
  ['Sneha M',                  'V7053', 'V7000', false, '2026-04-06', 'Marketing'],
  ['Vishmitha V',              'V7054', 'V7003', false, '2026-04-06', 'Business Development Associate'],
  ['Micheal Steafun Babu D',   'V7055', 'V7003', false, '2026-04-06', 'Business Development Associate'],
  ['Shrihari BH',              'V7056', 'V7032', false, '2026-04-13', 'Skill Mentor'],
  ['Dhivya V',                 'V7057', 'V7032', false, '2026-04-27', 'Skill Mentor'],
  ['Prakalya P',               'V7058', 'V7032', false, '2026-05-06', 'Skill Mentor'],
  ['Samjebadurai Govindaraj',  'V7059', 'V7000', false, '2026-05-16', 'Placement Officer'],
  ['Selvam T',                 'V7060', 'V7032', false, '2026-05-25', 'Skill Mentor'],
  ['Nancy',                    'V7061', 'V7032', false, '2026-06-01', 'Skill Mentor'],
  ['Kalaivani Ramesh',         'V7062', 'V7032', false, '2026-06-03', 'Skill Mentor'],
  ['Varththini V',             'V7063', 'V7032', false, '2026-06-03', 'Skill Mentor'],
  ['Yureka',                   'V7064', 'V7048', false, '2026-07-01', 'Admin and Ops Executive'],
  ['Raj Prasanth',             'V7065', 'V7048', false, '2026-07-01', 'Admin Executive - Intern'],
];

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');

function fuzzyMatches(dsName, emp) {
  const full = norm(emp.firstName + emp.lastName);
  const target = norm(dsName);
  if (!full || !target || full === target) return full === target;
  // Tolerate trailing initials: "yureka e" vs "yureka"
  if (full.startsWith(target) || target.startsWith(full)) {
    return Math.abs(full.length - target.length) <= 3;
  }
  return false;
}

async function main() {
  console.log(APPLY ? '=== APPLY MODE ===' : '=== DRY RUN (pass --apply to write) ===');
  if (!SYNC_DATES) console.log('(joining dates are NOT synced — add --dates to include them)\n');

  const employees = await prisma.employee.findMany({
    select: {
      id: true, firstName: true, lastName: true, employeeCode: true, status: true,
      managerId: true, joiningDate: true, designationId: true,
      designation: { select: { id: true, name: true } },
    },
  });
  const designations = await prisma.designation.findMany({ select: { id: true, name: true } });
  console.log(`DB employees: ${employees.length} | dataset rows: ${DATASET.length}\n`);

  // ── Match dataset rows to DB employees (exact code → exact name → fuzzy) ──
  const byRowCode = {};
  const matchedIds = new Set();
  const missing = [];

  // Pass 1: exact employeeCode
  for (const [name, code] of DATASET) {
    const emp = employees.find((e) => e.employeeCode.toUpperCase() === code && !matchedIds.has(e.id));
    if (emp) { byRowCode[code] = emp; matchedIds.add(emp.id); }
  }
  // Pass 2: exact normalized full name
  for (const [name, code] of DATASET) {
    if (byRowCode[code]) continue;
    const target = norm(name);
    const emp = employees.find((e) => norm(e.firstName + e.lastName) === target && !matchedIds.has(e.id));
    if (emp) { byRowCode[code] = emp; matchedIds.add(emp.id); }
  }
  // Pass 3: fuzzy (trailing initials)
  for (const [name, code] of DATASET) {
    if (byRowCode[code]) continue;
    const emp = employees.find((e) => fuzzyMatches(name, e) && !matchedIds.has(e.id));
    if (emp) { byRowCode[code] = emp; matchedIds.add(emp.id); }
    else missing.push(`${name} (${code})`);
  }

  const extras = employees.filter((e) => !matchedIds.has(e.id));

  if (missing.length) {
    console.log('⚠ In the sheet but NOT matched in DB — no changes made for these, tell me who they are:');
    missing.forEach((m) => console.log('   -', m));
    console.log();
  }
  if (extras.length) {
    console.log('⚠ In DB but NOT matched to the sheet — left completely untouched, tell me who they are:');
    extras.forEach((e) => console.log(`   - ${e.firstName} ${e.lastName} [${e.employeeCode}] status=${e.status} desig=${e.designation?.name || '—'}`));
    console.log();
  }

  // ── Designation helpers ──────────────────────────────────────────────────
  const desigByNorm = {};
  for (const d of designations) desigByNorm[norm(d.name)] = d;

  // Current designation counts as already-correct when it equals the sheet value
  // OR is a more specific version of it (e.g. "Skill Mentor - MERN Stack" ⊇ "Skill Mentor").
  const desigSatisfied = (currentName, sheetName) => {
    if (!sheetName) return true;
    if (!currentName) return false;
    const cur = norm(currentName), want = norm(sheetName);
    return cur === want || cur.startsWith(want);
  };

  // ── Plan changes (only fields that actually differ) ─────────────────────
  const plan = [];
  for (const [name, code, mgrCode, confirmed, doj, desigName] of DATASET) {
    const emp = byRowCode[code];
    if (!emp) continue;
    const changes = {};
    const data = {};

    if (emp.employeeCode.toUpperCase() !== code) {
      changes.employeeCode = `${emp.employeeCode} → ${code}`;
    }

    const mgr = mgrCode ? byRowCode[mgrCode] : null;
    if (mgrCode && !mgr) {
      console.log(`⚠ Manager ${mgrCode} for ${name} not matched — manager left unchanged`);
    } else {
      const wantMgrId = mgr ? mgr.id : null;
      if (mgrCode !== null && emp.managerId !== wantMgrId) {
        changes.manager = `→ ${mgrCode}`;
        data.managerId = wantMgrId;
      }
    }

    if (!desigSatisfied(emp.designation?.name, desigName)) {
      changes.designation = `${emp.designation?.name || '—'} → ${desigName}`;
      data.__desigName = desigName;
    }

    const wantStatus = confirmed ? 'ACTIVE' : 'ON_PROBATION';
    if (!['RESIGNED', 'TERMINATED'].includes(emp.status) && emp.status !== wantStatus) {
      changes.status = `${emp.status} → ${wantStatus}`;
      data.status = wantStatus;
    }
    if (['RESIGNED', 'TERMINATED'].includes(emp.status)) {
      console.log(`ℹ ${name} is ${emp.status} in DB — status left unchanged (confirm if that's correct)`);
    }

    if (SYNC_DATES && doj) {
      const want = new Date(doj + 'T00:00:00Z');
      if (Math.abs(new Date(emp.joiningDate).getTime() - want.getTime()) > 86400000 * 2) {
        changes.joiningDate = `${new Date(emp.joiningDate).toISOString().slice(0, 10)} → ${doj}`;
        data.joiningDate = want;
      }
    }

    if (Object.keys(changes).length) plan.push({ name, code, emp, changes, data });
  }

  if (!plan.length) { console.log('✓ Everything already in sync — nothing to change.'); return; }

  console.log(`\nPlanned updates (${plan.length} employee(s), only the fields shown are touched):`);
  for (const p of plan) {
    console.log(`   ${p.name.padEnd(28)} ${Object.entries(p.changes).map(([k, v]) => `${k}: ${v}`).join(' | ')}`);
  }

  if (!APPLY) { console.log('\nDry run complete — review above, then re-run with --apply.'); return; }

  // ── Phase 1: temp codes (avoids unique-constraint collisions on swaps) ──
  const codeChanges = plan.filter((p) => p.changes.employeeCode);
  for (const p of codeChanges) {
    await prisma.employee.update({ where: { id: p.emp.id }, data: { employeeCode: `TMP_${p.emp.id.slice(0, 12)}` } });
  }
  // ── Phase 2: final codes ─────────────────────────────────────────────────
  for (const p of codeChanges) {
    await prisma.employee.update({ where: { id: p.emp.id }, data: { employeeCode: p.code } });
  }
  // ── Phase 3: manager / designation / status / dates ─────────────────────
  for (const p of plan) {
    const data = { ...p.data };
    if (data.__desigName) {
      const dn = data.__desigName; delete data.__desigName;
      let desig = desigByNorm[norm(dn)];
      if (!desig) {
        desig = await prisma.designation.create({
          data: { name: dn, code: `${norm(dn).toUpperCase().slice(0, 10)}_${Date.now().toString(36).toUpperCase()}` },
        });
        desigByNorm[norm(dn)] = desig;
        console.log(`   + created designation "${dn}"`);
      }
      data.designationId = desig.id;
    }
    if (Object.keys(data).length) await prisma.employee.update({ where: { id: p.emp.id }, data });
  }

  console.log(`\n✓ Applied updates to ${plan.length} employee(s). Untouched: everything else.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
