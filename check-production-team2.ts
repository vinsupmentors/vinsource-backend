/**
 * Follow-up diagnostic: the frontend fetch was fixed to include ON_PROBATION
 * staff and fetch up to 500 records, but the dropdown still only shows 3
 * people instead of the 8 found by check-production-team.ts. This checks
 * whether company scoping is the culprit — /api/employees filters by
 * req.user.companyId, so if these employees sit under a different company
 * than the logged-in user, they'd be silently excluded no matter what the
 * frontend filter does.
 *
 * USAGE (read-only)
 *   cd backend
 *   npx ts-node check-production-team2.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const CODES = ['V7032', 'EMP0026', 'EMP0027', 'V7057', 'V7060', 'V7056', 'V7058', 'V7052'];

async function main() {
  console.log('\n=== companyId for each known Production employee ===\n');
  const emps = await prisma.employee.findMany({
    where: { employeeCode: { in: CODES } },
    select: { employeeCode: true, firstName: true, lastName: true, companyId: true, status: true, departmentId: true },
  });
  for (const e of emps) {
    console.log(`  ${e.employeeCode}  ${e.firstName} ${e.lastName}  companyId=${e.companyId}  status=${e.status}  deptId=${e.departmentId}`);
  }

  console.log('\n=== companyId for Gaurav\'s login user (gaurav.kumar@vinsupskillacademy.com) ===\n');
  const loginUser = await prisma.user.findUnique({
    where: { email: 'gaurav.kumar@vinsupskillacademy.com' },
    include: { employee: true },
  });
  console.log(`  login user.id     = ${loginUser?.id}`);
  console.log(`  linked employee   = ${loginUser?.employee ? `${loginUser.employee.employeeCode} companyId=${loginUser.employee.companyId}` : 'NONE'}`);

  console.log('\n=== All distinct companyIds in the Employee table ===\n');
  const companies = await prisma.employee.groupBy({ by: ['companyId'], _count: { _all: true } });
  for (const c of companies) console.log(`  companyId=${c.companyId}  employeeCount=${c._count._all}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
