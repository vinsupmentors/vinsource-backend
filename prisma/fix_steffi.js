// node prisma/fix_steffi.js
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // Change Steffi's role to EMPLOYEE and designation to Receptionist cum Admin
  await p.designation.upsert({
    where: { id: 'desig-recep-admin' },
    update: { name: 'Receptionist cum Admin', code: 'RCADM', level: 2, isActive: true },
    create: { id: 'desig-recep-admin', name: 'Receptionist cum Admin', code: 'RCADM', level: 2 },
  });

  await p.user.update({
    where: { email: 'steffi.s@hrms.com' },
    data: { role: 'EMPLOYEE' },
  });

  await p.employee.update({
    where: { employeeCode: 'V7044' },
    data: { departmentId: 'dept-admin', designationId: 'desig-recep-admin' },
  });

  console.log('✅ Steffi V7044 → EMPLOYEE, Receptionist cum Admin, Admin dept');
}

main().catch(console.error).finally(() => p.$disconnect());
