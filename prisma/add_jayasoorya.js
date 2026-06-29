// node prisma/add_jayasoorya.js
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient();

async function main() {
  const company = await p.company.findFirst({ where: { code: 'DEMO' } });
  const cid = company.id;
  const hash = await bcrypt.hash('Employee@1234', 10);

  // Designation
  await p.designation.upsert({
    where: { id: 'desig-asst-ops' },
    update: { name: 'Asst Manager - Operations', code: 'AMO', level: 6, isActive: true },
    create: { id: 'desig-asst-ops', name: 'Asst Manager - Operations', code: 'AMO', level: 6 },
  });

  // User
  const user = await p.user.upsert({
    where: { email: 'jayasoorya.subramanian@hrms.com' },
    update: { role: 'MANAGER', isActive: true },
    create: { email: 'jayasoorya.subramanian@hrms.com', password: hash, role: 'MANAGER', isActive: true },
  });

  // Get Pooranam as manager
  const pooranam = await p.employee.findUnique({ where: { employeeCode: 'V7001' } });

  // Employee — temp code TMP-JAYA until emp ID is decided
  const jaya = await p.employee.upsert({
    where: { employeeCode: 'TMP-JAYA' },
    update: {
      firstName: 'Jayasoorya', lastName: 'Subramanian M',
      email: 'jayasoorya.subramanian@hrms.com',
      departmentId: 'dept-admin', designationId: 'desig-asst-ops',
      status: 'ACTIVE', companyId: cid,
      managerId: pooranam?.id ?? null,
    },
    create: {
      userId: user.id, companyId: cid,
      employeeCode: 'TMP-JAYA',
      firstName: 'Jayasoorya', lastName: 'Subramanian M',
      email: 'jayasoorya.subramanian@hrms.com',
      departmentId: 'dept-admin', designationId: 'desig-asst-ops',
      joiningDate: new Date(), status: 'ACTIVE',
      managerId: pooranam?.id ?? null,
    },
  });
  console.log('✅ Jayasoorya added (TMP-JAYA) — update employeeCode once ID is confirmed');

  // Steffi → reports to Jayasoorya
  await p.employee.update({ where: { employeeCode: 'V7044' }, data: { managerId: jaya.id } });
  console.log('✅ Steffi V7044 → reports to Jayasoorya');

  // Sri Sashmitha → reports to Jayasoorya
  await p.employee.update({ where: { employeeCode: 'V7004' }, data: { managerId: jaya.id } });
  console.log('✅ Sri Sashmitha V7004 → reports to Jayasoorya');

  console.log('\n📋 Admin team under Jayasoorya:');
  console.log('  Pooranam (SUPER_ADMIN / Owner)');
  console.log('  └── Jayasoorya (Asst Manager - Operations)');
  console.log('        ├── Sri Sashmitha V7004 (Admin & Operations Executive)');
  console.log('        └── Steffi V7044 (Receptionist cum Admin)');
}

main().catch(console.error).finally(() => p.$disconnect());
