// node prisma/seed_reset_users.js
// Deletes ALL existing users/employees and creates only Pooranam Annamalai as SUPER_ADMIN
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient();

async function main() {
  console.log('🔄 Resetting all users...');

  // Delete in dependency order
  await p.session?.deleteMany({}).catch(() => {});
  await p.notification?.deleteMany({}).catch(() => {});
  await p.leaveRequest?.deleteMany({}).catch(() => {});
  await p.leaveBalance?.deleteMany({}).catch(() => {});
  await p.attendance?.deleteMany({}).catch(() => {});
  await p.payroll?.deleteMany({}).catch(() => {});
  await p.helpDeskTicket?.deleteMany({}).catch(() => {});
  await p.onboardingRequest?.deleteMany({}).catch(() => {});
  await p.userModuleAccess?.deleteMany({}).catch(() => {});
  await p.employee?.deleteMany({});
  await p.user?.deleteMany({});

  console.log('✅ All users deleted');

  // Find the company
  const company = await p.company.findFirst({ where: { code: 'DEMO' } });
  if (!company) { console.error('❌ Company not found — run db:seed first'); process.exit(1); }

  const branch = await p.branch.findFirst({ where: { companyId: company.id } });
  const dept   = await p.department.findFirst({ where: { companyId: company.id, isActive: true } });
  const desig  = await p.designation.findFirst();

  const password = await bcrypt.hash('Vinsup@2025', 10);

  const user = await p.user.create({
    data: {
      email:    'pooranam.a@vinsupskillacademy.com',
      password: password,
      role:     'SUPER_ADMIN',
    },
  });

  await p.employee.create({
    data: {
      userId:        user.id,
      companyId:     company.id,
      branchId:      branch.id,
      departmentId:  dept.id,
      designationId: desig.id,
      employeeCode:  'VSA001',
      firstName:     'Pooranam',
      lastName:      'Annamalai',
      email:         'pooranam.a@vinsupskillacademy.com',
      joiningDate:   new Date('2024-01-01'),
      status:        'ACTIVE',
    },
  });

  console.log('\n✅ Super Admin created:');
  console.log('   Email    : pooranam.a@vinsupskillacademy.com');
  console.log('   Password : Vinsup@2025');
  console.log('   Role     : SUPER_ADMIN\n');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => p.$disconnect());
