// node prisma/fix_hierarchy.js
// 1. Add Pooranam Annamalai as SUPER_ADMIN (the sole Owner — full access)
// 2. Clement → MANAGER, reports to Pooranam
// 3. Gaurav (LDM) → does NOT report to Clement; reports to Pooranam directly
// 4. Gokul (VP Sales) → reports to Pooranam
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient();

async function main() {
  const company = await p.company.findFirst({ where: { code: 'DEMO' } });
  const cid = company.id;
  const hash = await bcrypt.hash('Employee@1234', 10);

  // ── 1. Add Pooranam Annamalai as SUPER_ADMIN (Owner) ────────────────────────
  const pooranamUser = await p.user.upsert({
    where: { email: 'pooranam.annamalai@hrms.com' },
    update: { role: 'SUPER_ADMIN', isActive: true, canManageAccess: true },
    create: { email: 'pooranam.annamalai@hrms.com', password: hash, role: 'SUPER_ADMIN', isActive: true, canManageAccess: true },
  });

  // Ensure a designation exists for the Owner
  await p.designation.upsert({
    where: { id: 'desig-sm-gen' },
    update: { name: 'General Manager', code: 'GM', level: 10, isActive: true },
    create: { id: 'desig-sm-gen', name: 'General Manager', code: 'GM', level: 10 },
  });

  const pooranam = await p.employee.upsert({
    where: { employeeCode: 'V7001' },
    update: { firstName: 'Pooranam', lastName: 'Annamalai', email: 'pooranam.annamalai@hrms.com', departmentId: 'dept-admin', designationId: 'desig-sm-gen', status: 'ACTIVE', companyId: cid, managerId: null },
    create: {
      userId: pooranamUser.id, companyId: cid, employeeCode: 'V7001',
      firstName: 'Pooranam', lastName: 'Annamalai',
      email: 'pooranam.annamalai@hrms.com',
      departmentId: 'dept-admin', designationId: 'desig-sm-gen',
      joiningDate: new Date('2024-01-01'), status: 'ACTIVE',
    },
  });
  console.log('✅ Pooranam Annamalai added as SUPER_ADMIN / Owner (V7001)');

  // ── 2. Clement → MANAGER role, reports to Pooranam ─────────────────────────
  const clement = await p.employee.findUnique({ where: { employeeCode: 'V7000' } });
  await p.user.update({ where: { email: 'clement.sudharson@hrms.com' }, data: { role: 'MANAGER' } });
  await p.employee.update({ where: { employeeCode: 'V7000' }, data: { managerId: pooranam.id } });
  console.log('✅ Clement → MANAGER, reports to Pooranam');

  // ── 3. Gaurav (LDM) → reports to Pooranam (not Clement) ───────────────────
  await p.employee.update({ where: { employeeCode: 'V7032' }, data: { managerId: pooranam.id } });
  console.log('✅ Gaurav (LDM) → reports to Pooranam directly');

  // ── 4. Gokul (VP Sales) → reports to Pooranam ──────────────────────────────
  await p.employee.update({ where: { employeeCode: 'V7003' }, data: { managerId: pooranam.id } });
  console.log('✅ Gokul (VP Sales) → reports to Pooranam');

  // ── 5. Steffi (HR) → reports to Pooranam ───────────────────────────────────
  await p.employee.update({ where: { employeeCode: 'V7044' }, data: { managerId: pooranam.id } });
  console.log('✅ Steffi (HR) → reports to Pooranam');

  // ── 6. B2B employees → reports to Gaurav (LDM) ─────────────────────────────
  // Selvakumar is already set to Gaurav — just confirm
  const gaurav = await p.employee.findUnique({ where: { employeeCode: 'V7032' } });
  const b2bEmp = await p.employee.findMany({ where: { companyId: cid, departmentId: 'dept-b2b' } });
  for (const e of b2bEmp) {
    await p.employee.update({ where: { id: e.id }, data: { managerId: gaurav.id } });
    console.log(`  ✓ B2B employee ${e.employeeCode} ${e.firstName} → reports to Gaurav (LDM)`);
  }

  console.log('\n📋 Final reporting hierarchy:');
  console.log('  Pooranam Annamalai (SUPER_ADMIN / Owner / GM)');
  console.log('  ├── Clement V7000 (CGO / MANAGER)');
  console.log('  │     ├── Sri Sashmitha V7004 (Admin)');
  console.log('  │     ├── Muneeswari V7017 (Housekeeping)');
  console.log('  │     └── Dhanush V7049 (Digital Marketing)');
  console.log('  ├── Gokul V7003 (VP Sales / MANAGER)');
  console.log('  │     ├── Kumaresan V7006 (Team Lead)');
  console.log('  │     ├── Hariharan V7011 (Team Lead)');
  console.log('  │     ├── Pradhap V7040 (Team Lead)');
  console.log('  │     └── BDA team: V7012, V7016, V7020, V7029, V7030, V7045, V7046');
  console.log('  ├── Gaurav V7032 (LDM / MANAGER)');
  console.log('  │     ├── [Production team]');
  console.log('  │     └── Selvakumar V7037 (B2B)');
  console.log('  └── Steffi V7044 (HR)');
  console.log('\n🔑 Password for all: Employee@1234');
}

main().catch(console.error).finally(() => p.$disconnect());
