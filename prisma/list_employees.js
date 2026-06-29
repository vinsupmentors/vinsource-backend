// node prisma/list_employees.js
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const employees = await p.employee.findMany({
    where: { company: { code: 'DEMO' } },
    select: {
      employeeCode: true, firstName: true, lastName: true, email: true, status: true,
      department: { select: { name: true } },
      designation: { select: { name: true } },
      manager: { select: { firstName: true, lastName: true } },
      user: { select: { role: true } },
    },
    orderBy: { employeeCode: 'asc' },
  });

  console.log('\n' + '═'.repeat(120));
  console.log('EMPLOYEE LIST — Demo Corporation Ltd');
  console.log('═'.repeat(120));
  console.log(
    'S.No'.padEnd(6) +
    'Emp Code'.padEnd(12) +
    'Name'.padEnd(28) +
    'Email'.padEnd(38) +
    'Password'.padEnd(18) +
    'Role'.padEnd(16) +
    'Department'.padEnd(20) +
    'Designation'
  );
  console.log('─'.repeat(120));

  employees.forEach((e, i) => {
    const name = `${e.firstName} ${e.lastName}`.trim();
    const email = e.email;
    const password = 'Employee@1234';
    console.log(
      String(i + 1).padEnd(6) +
      e.employeeCode.padEnd(12) +
      name.substring(0, 26).padEnd(28) +
      email.substring(0, 36).padEnd(38) +
      password.padEnd(18) +
      (e.user?.role ?? '').padEnd(16) +
      (e.department?.name ?? '—').padEnd(20) +
      (e.designation?.name ?? '—')
    );
  });

  console.log('─'.repeat(120));
  console.log(`Total: ${employees.length} employees`);
  console.log('═'.repeat(120));
  console.log('\nNOTE: Demo accounts (admin/hr/manager/employee @hrms.com) may have different passwords set during initial seed.');
  console.log('      All employees added via seed_employees.js use: Employee@1234\n');
}

main().catch(console.error).finally(() => p.$disconnect());
