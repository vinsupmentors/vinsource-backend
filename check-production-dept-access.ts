/**
 * Read-only diagnostic: shows why every Production employee (not just the
 * manager) currently has EDIT rights on the Production module. Almost
 * certainly the DepartmentModuleAccess default for the Production
 * department(s) is set to EDIT, which grants EDIT to everyone in that
 * department, not just the manager.
 *
 * USAGE (read-only)
 *   cd backend
 *   npx ts-node check-production-dept-access.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const MODULE = 'PRODUCTION_TRAINING';

async function main() {
  console.log('\n=== DepartmentModuleAccess for PRODUCTION_TRAINING, all "Production" depts ===\n');
  const depts = await prisma.department.findMany({
    where: { name: { contains: 'Production' } },
    include: { moduleAccessDefaults: { where: { module: MODULE } } },
  });
  for (const d of depts) {
    console.log(`  "${d.name}" (${d.id}, company=${d.companyId}) -> ${d.moduleAccessDefaults[0]?.accessLevel ?? 'NO DEFAULT ROW'}`);
  }

  console.log('\n=== UserModuleAccess overrides for PRODUCTION_TRAINING (system-wide) ===\n');
  const grants = await prisma.userModuleAccess.findMany({
    where: { module: MODULE },
    include: { user: { include: { employee: true } } },
  });
  for (const g of grants) {
    console.log(`  userId=${g.userId}  level=${g.accessLevel}  -> ${g.user.email} (employee: ${g.user.employee ? `${g.user.employee.firstName} ${g.user.employee.lastName} / ${g.user.employee.employeeCode}` : 'NONE'})`);
  }
  if (grants.length === 0) console.log('  (none)');

  console.log('\n=== Every employee in dept-real-prod, with effective PRODUCTION_TRAINING access ===\n');
  const emps = await prisma.employee.findMany({
    where: { departmentId: 'dept-real-prod' },
    include: { user: { include: { moduleAccessGrants: { where: { module: MODULE } } } } },
  });
  const realProdDept = depts.find((d) => d.id === 'dept-real-prod');
  const deptDefault = realProdDept?.moduleAccessDefaults[0]?.accessLevel;
  for (const e of emps) {
    const override = e.user.moduleAccessGrants[0]?.accessLevel;
    const effective = override ?? deptDefault ?? 'NONE';
    console.log(`  ${e.firstName} ${e.lastName} (${e.employeeCode})  override=${override ?? '-'}  deptDefault=${deptDefault ?? '-'}  effective=${effective}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
