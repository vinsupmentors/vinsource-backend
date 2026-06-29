/**
 * Read-only diagnostic: why does jayasoorya.subramanian@hrms.com have a
 * PRODUCTION_TRAINING EDIT override? Checks their Employee record (real
 * department, status, company), the User row itself (role, isActive,
 * createdAt), and the UserModuleAccess override row's metadata (note,
 * createdAt) to see when/why it was granted.
 *
 * USAGE (read-only)
 *   cd backend
 *   npx ts-node check-jayasoorya.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const user = await prisma.user.findUnique({
    where: { email: 'jayasoorya.subramanian@hrms.com' },
    include: {
      employee: { include: { department: true } },
      moduleAccessGrants: true,
    },
  });

  if (!user) {
    console.log('No user found with that email.');
    return;
  }

  console.log('=== User ===');
  console.log(`  id        = ${user.id}`);
  console.log(`  email     = ${user.email}`);
  console.log(`  role      = ${user.role}`);
  console.log(`  isActive  = ${user.isActive}`);
  console.log(`  createdAt = ${user.createdAt.toISOString()}`);

  console.log('\n=== Linked Employee ===');
  if (!user.employee) {
    console.log('  NONE — orphaned user, no Employee row.');
  } else {
    console.log(`  code        = ${user.employee.employeeCode}`);
    console.log(`  name        = ${user.employee.firstName} ${user.employee.lastName}`);
    console.log(`  status      = ${user.employee.status}`);
    console.log(`  department  = ${user.employee.department?.name ?? '(none)'} (id ${user.employee.departmentId ?? '-'})`);
    console.log(`  companyId   = ${user.employee.companyId}`);
    console.log(`  createdAt   = ${user.employee.createdAt.toISOString()}`);
  }

  console.log('\n=== All UserModuleAccess overrides for this user ===');
  for (const g of user.moduleAccessGrants) {
    console.log(`  module=${g.module}  level=${g.accessLevel}  note=${g.note ?? '(none)'}  createdAt=${g.createdAt.toISOString()}`);
  }
  if (user.moduleAccessGrants.length === 0) console.log('  (none)');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
