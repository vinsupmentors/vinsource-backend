/**
 * Read-only diagnostic — lists every Employee whose name matches one of the
 * expected Production-team members, showing their actual department name,
 * department id, and status. Use this to see why some of them aren't
 * showing up in the "Assign Trainer" dropdown (which filters by
 * department.name containing "production" AND status = ACTIVE).
 *
 * USAGE (read-only, makes no changes)
 *   cd backend
 *   npx ts-node check-production-team.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const NAMES = ['Selvam', 'Nancy', 'Prakalaya', 'Athithiyan', 'Athitiyan', 'Varthini', 'Divya', 'Kalaivani'];

async function main() {
  console.log('\n=== All Department rows (id, name, accessLevel-bearing children) ===\n');
  const depts = await prisma.department.findMany({ select: { id: true, name: true } });
  for (const d of depts) console.log(`  ${d.id}  ->  "${d.name}"`);

  console.log('\n=== Employees matching expected Production-team names ===\n');
  const matches = await prisma.employee.findMany({
    where: { OR: NAMES.map((n) => ({ firstName: { contains: n } })) },
    include: { department: true },
  });

  if (matches.length === 0) {
    console.log('  No Employee rows matched any of these first names at all.');
  }

  for (const e of matches) {
    console.log(`  ${e.firstName} ${e.lastName}  (code ${e.employeeCode})`);
    console.log(`    status      = ${e.status}`);
    console.log(`    department  = "${e.department?.name ?? '(none)'}" (id ${e.department?.id ?? '-'})`);
    console.log('');
  }

  console.log('=== Every ACTIVE employee currently in any "Production"-named department ===\n');
  const prodDeptIds = depts.filter((d) => d.name.toLowerCase().includes('production')).map((d) => d.id);
  const inProd = await prisma.employee.findMany({
    where: { departmentId: { in: prodDeptIds } },
    include: { department: true },
  });
  for (const e of inProd) {
    console.log(`  ${e.firstName} ${e.lastName} (${e.employeeCode}) - status=${e.status} - dept="${e.department?.name}"`);
  }
  if (inProd.length === 0) console.log('  (none found)');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
