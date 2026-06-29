/**
 * Grants PRODUCTION_TRAINING module access to the Production team so the
 * "Production" sidebar item actually shows up for them.
 *
 * Why this was missing: module visibility is driven entirely by
 * DepartmentModuleAccess (department default) + UserModuleAccess (per-user
 * override) rows — it is NOT inferred from a department's name. After the
 * employee roster reset, the "Production" and "Production & Admin & Finance"
 * departments exist but have no DepartmentModuleAccess row for
 * PRODUCTION_TRAINING, so nobody in them sees the Production menu yet.
 *
 * What this does:
 *  1. For every Department whose name contains "Production" (case-insensitive),
 *     upserts a DepartmentModuleAccess row granting VIEW on PRODUCTION_TRAINING.
 *  2. Grants Gaurav Kumar M S (V7032, the production manager) an EDIT-level
 *     UserModuleAccess override on PRODUCTION_TRAINING, since VIEW alone
 *     wouldn't let a manager actually manage batches/courses/students.
 *
 * SAFETY: dry run by default — prints what it would do. Pass --apply to write.
 *
 * USAGE
 *   cd backend
 *   npx ts-node grant-production-access.ts
 *   npx ts-node grant-production-access.ts --apply
 */
import { PrismaClient, ModuleName, AccessLevel } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const MODULE: ModuleName = 'PRODUCTION_TRAINING';

async function main() {
  console.log(`\n=== Grant Production module access — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'} ===\n`);

  const departments = await prisma.department.findMany({
    where: { name: { contains: 'Production' } },
  });

  if (departments.length === 0) {
    console.log('No department with "Production" in its name was found — nothing to do.');
  }

  for (const dept of departments) {
    const existing = await prisma.departmentModuleAccess.findUnique({
      where: { departmentId_module: { departmentId: dept.id, module: MODULE } },
    });
    if (existing) {
      console.log(`  [skip] "${dept.name}" already has ${existing.accessLevel} on PRODUCTION_TRAINING`);
      continue;
    }
    console.log(`  [grant] "${dept.name}" -> VIEW on PRODUCTION_TRAINING`);
    if (APPLY) {
      await prisma.departmentModuleAccess.create({
        data: { departmentId: dept.id, module: MODULE, accessLevel: AccessLevel.VIEW },
      });
    }
  }

  const gaurav = await prisma.employee.findFirst({
    where: { employeeCode: 'V7032' },
    include: { user: true },
  });

  if (!gaurav) {
    console.log('\n[!] Could not find employee V7032 (Gaurav Kumar M S) — skipping his EDIT override.');
  } else {
    const existingOverride = await prisma.userModuleAccess.findUnique({
      where: { userId_module: { userId: gaurav.userId, module: MODULE } },
    });
    if (existingOverride) {
      console.log(`\n  [skip] Gaurav already has a ${existingOverride.accessLevel} override on PRODUCTION_TRAINING`);
    } else {
      console.log('\n  [grant] Gaurav Kumar M S (V7032) -> EDIT override on PRODUCTION_TRAINING');
      if (APPLY) {
        await prisma.userModuleAccess.create({
          data: { userId: gaurav.userId, module: MODULE, accessLevel: AccessLevel.EDIT, note: 'Production manager — granted by reset script' },
        });
      }
    }
  }

  console.log(APPLY ? '\nDone — changes applied.' : '\nDry run only — nothing was written. Re-run with --apply.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
