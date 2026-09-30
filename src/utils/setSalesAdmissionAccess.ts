/**
 * One-off: gives the whole Sales department EDIT access to the Admission
 * module by default (per Gaurav, 2026-09-30) — so every current and future
 * Sales employee sees the Admission menu and can create admissions,
 * calculate fees, and request seats, without needing a per-user override.
 * Coupons / Course Fees / Config stay admin-only regardless, since those
 * screens are separately gated on ADMIN-level access inside the Admission
 * module, not just any access to it.
 *
 * This only touches DepartmentModuleAccess (the department-wide default) —
 * it does NOT touch any individual UserModuleAccess override already set on
 * a specific Sales employee (e.g. someone previously granted ADMIN-level
 * Admission access keeps that; this only raises the floor for everyone else
 * in the department up to EDIT).
 *
 * SAFE BY DEFAULT: this only PRINTS what it would do. Nothing is written
 * until you re-run it with --apply. The Sales department is matched
 * case-insensitively by name/code containing "sales" — if that matches 0 or
 * more than 1 department, it stops and tells you rather than guessing.
 *
 * Run from backend/:
 *   npx ts-node src/utils/setSalesAdmissionAccess.ts            (dry run)
 *   npx ts-node src/utils/setSalesAdmissionAccess.ts --apply    (writes)
 */
import prisma from '../config/database';

const APPLY = process.argv.includes('--apply');

async function main() {
  const candidates = await prisma.department.findMany({
    where: {
      isActive: true,
      OR: [{ name: { contains: 'sales' } }, { code: { contains: 'sales' } }],
    },
    include: { moduleAccessDefaults: { where: { module: 'ADMISSION' } } },
  });

  if (candidates.length === 0) {
    console.log('No active department matching "sales" was found by name/code — nothing to do. Check the department name and adjust the match if needed.');
    return;
  }
  if (candidates.length > 1) {
    console.log('More than one department matched "sales" — resolve this manually instead of guessing:');
    candidates.forEach((d: (typeof candidates)[number]) => console.log(`  - ${d.name} (${d.code || 'no code'}, id ${d.id})`));
    return;
  }

  const dept = candidates[0];
  const current = dept.moduleAccessDefaults[0];
  const currentLevel = current?.accessLevel ?? 'NONE';

  if (currentLevel === 'ADMIN' || currentLevel === 'EDIT') {
    console.log(`${dept.name} already has ${currentLevel}-level Admission access (>= EDIT) — nothing to change.`);
    return;
  }

  console.log(`${APPLY ? 'Applying' : 'Would set'}: ${dept.name} → Admission module: ${currentLevel} → EDIT`);

  if (!APPLY) {
    console.log('\nDry run only — re-run with --apply to write this change.');
    return;
  }

  await prisma.departmentModuleAccess.upsert({
    where: { departmentId_module: { departmentId: dept.id, module: 'ADMISSION' } },
    update: { accessLevel: 'EDIT' },
    create: { departmentId: dept.id, module: 'ADMISSION', accessLevel: 'EDIT' },
  });

  console.log(`Done — every ${dept.name} employee now defaults to EDIT-level Admission access.`);
}

main()
  .catch((err) => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
