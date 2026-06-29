/**
 * Locks down Production module EDIT access to the manager only (Gaurav).
 *
 * Root cause (confirmed via check-production-dept-access.ts):
 *   - DepartmentModuleAccess for dept-real-prod (the real "Production" dept)
 *     has PRODUCTION_TRAINING = EDIT as the DEPARTMENT DEFAULT, so every
 *     employee in that department inherits EDIT automatically — that's why
 *     Dhivya, Selvam, Shrihari, Prakalya, and Athithyan all have full manager
 *     rights on Production right now.
 *   - There are also 3 leftover personal UserModuleAccess EDIT overrides
 *     (Devi Shree x2, Jayasoorya Subramanian) unrelated to that department
 *     default, left over from earlier debugging/seed data.
 *
 * FIX:
 *   1. Remove the dept-real-prod department-wide EDIT default (delete the
 *      row) — so nobody gets Production access just by being in the
 *      department. Gaurav keeps his EDIT via his own existing
 *      UserModuleAccess override (untouched).
 *   2. Delete the 3 stray personal EDIT overrides for Devi Shree (EMP0026 +
 *      EMP0027) and Jayasoorya Subramanian — so they no longer have
 *      Production edit rights either.
 *
 * After this, only Gaurav (gaurav.kumar@vinsupskillacademy.com) has EDIT
 * on PRODUCTION_TRAINING. Everyone else loses the Production sidebar entry
 * entirely (no department default, no override) and falls back to
 * whatever "My Training" access they have via their TrainerAssignment
 * records — untouched by this script.
 *
 * SAFETY: dry run by default — prints what it would do. Pass --apply to write.
 *
 * USAGE
 *   cd backend
 *   npx ts-node fix-production-access.ts
 *   npx ts-node fix-production-access.ts --apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const MODULE = 'PRODUCTION_TRAINING';
const DEPT_ID = 'dept-real-prod';
const STRAY_USER_IDS = [
  'ed56c1d2-4f33-4a6f-8dee-56b09f4e4749', // gksuresh141299@gmail.com - Devi Shree / EMP0027
  'b4a22ec5-7f28-4a6f-96fe-05dfa5438dd8', // gksuresh1412@gmail.com - Devi Shree / EMP0026
  '2550820f-b9cb-49f2-8161-5377379ba39b', // jayasoorya.subramanian@hrms.com - Jayasoorya Subramanian M / TMP-JAYA
];

async function main() {
  console.log(`\n=== Lock down Production EDIT to the manager only — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'} ===\n`);

  const deptDefault = await prisma.departmentModuleAccess.findUnique({
    where: { departmentId_module: { departmentId: DEPT_ID, module: MODULE } },
  });
  if (!deptDefault) {
    console.log(`No DepartmentModuleAccess row found for ${DEPT_ID}/${MODULE} — nothing to remove there (already fixed?).`);
  } else {
    console.log(`Will delete DepartmentModuleAccess: dept=${DEPT_ID} module=${MODULE} level=${deptDefault.accessLevel}`);
  }

  const strayGrants = await prisma.userModuleAccess.findMany({
    where: { userId: { in: STRAY_USER_IDS }, module: MODULE },
    include: { user: { include: { employee: true } } },
  });
  for (const g of strayGrants) {
    console.log(`Will delete UserModuleAccess: user=${g.user.email} (${g.user.employee ? `${g.user.employee.firstName} ${g.user.employee.lastName}` : 'no employee'}) level=${g.accessLevel}`);
  }

  if (!APPLY) {
    console.log('\nDry run only — nothing was written. Re-run with --apply once this looks right.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    if (deptDefault) {
      await tx.departmentModuleAccess.delete({
        where: { departmentId_module: { departmentId: DEPT_ID, module: MODULE } },
      });
    }
    await tx.userModuleAccess.deleteMany({
      where: { userId: { in: STRAY_USER_IDS }, module: MODULE },
    });
  });

  console.log('\nDone. Everyone affected must log out and log back in to pick up the change.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
