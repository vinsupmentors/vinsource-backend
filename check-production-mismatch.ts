
/**
 * Cross-checks each known Production employee's companyId against the
 * companyId actually owning their department (dept-real-prod belongs to
 * "Vinsup Skill Academy"). If an employee's companyId field doesn't match,
 * /api/employees (which filters by req.user.companyId) will silently hide
 * them from Gaurav's dropdown even though they sit in the right department.
 *
 * USAGE (read-only)
 *   cd backend
 *   npx ts-node check-production-mismatch.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const vinsup = await prisma.company.findFirst({ where: { name: 'Vinsup Skill Academy' } });
  if (!vinsup) throw new Error('Could not find Vinsup Skill Academy company');
  console.log(`Vinsup Skill Academy companyId = ${vinsup.id}\n`);

  const prodDepts = await prisma.department.findMany({ where: { name: 'Production' } });
  console.log('Production department rows:', prodDepts.map((d) => `${d.id} (company ${d.companyId})`).join(', '), '\n');

  const all = await prisma.employee.findMany({
    where: { departmentId: { in: prodDepts.map((d) => d.id) } },
    select: { employeeCode: true, firstName: true, lastName: true, status: true, companyId: true, departmentId: true },
  });

  console.log('=== Every employee in a Production department, with mismatch flag ===\n');
  for (const e of all) {
    const dept = prodDepts.find((d) => d.id === e.departmentId);
    const mismatch = dept && dept.companyId !== e.companyId;
    console.log(
      `  ${e.employeeCode}  ${e.firstName} ${e.lastName}  status=${e.status}  ` +
        `dept=${e.departmentId} (dept company=${dept?.companyId})  employee.companyId=${e.companyId}` +
        (mismatch ? '   <-- MISMATCH' : '')
    );
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
