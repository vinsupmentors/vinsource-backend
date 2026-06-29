/**
 * Diagnostic: confirm whether this is a genuine two-company setup or
 * duplicate/seed-data debris. Lists both Company rows, which companyId the
 * "Production" departments belong to, and how many employees per company
 * sit in a Production-named department.
 *
 * USAGE (read-only)
 *   cd backend
 *   npx ts-node check-company-split.ts
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('\n=== Company rows ===\n');
  const companies = await prisma.company.findMany();
  for (const c of companies) console.log(`  ${c.id}  name="${c.name}"`);

  console.log('\n=== Department rows named "Production" (with their companyId) ===\n');
  const depts = await prisma.department.findMany({ where: { name: { contains: 'Production' } } });
  for (const d of depts) console.log(`  ${d.id}  companyId=${d.companyId}  name="${d.name}"`);

  console.log('\n=== Employee counts by companyId + department name ===\n');
  const emps = await prisma.employee.findMany({
    select: { companyId: true, department: { select: { name: true } } },
  });
  const counts: Record<string, number> = {};
  for (const e of emps) {
    const key = `${e.companyId} | ${e.department?.name ?? '(none)'}`;
    counts[key] = (counts[key] || 0) + 1;
  }
  for (const [k, v] of Object.entries(counts)) console.log(`  ${k}  ->  ${v}`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
