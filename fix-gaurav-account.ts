/**
 * Fixes Gaurav's account fragmentation, confirmed via check-gaurav-access.ts:
 *
 *   - You log in as:        gaurav.kumar@vinsupskillacademy.com  (User, role MANAGER,
 *                            NO Employee linked — only has FINANCE_ADMIN EDIT, hence
 *                            why only "Finance (Admin)" shows up.)
 *   - The real Employee:     V7032 "Gaurav Kumar M S", dept "Production", status ACTIVE,
 *                            already has PRODUCTION_TRAINING EDIT — but it's attached to
 *                            a stale demo User (gaurav.kumar@hrms.com) you never log into.
 *   - A stray duplicate:     EMP00025 "Gaurav Kumar", dept HR, ON_PROBATION, attached to
 *                            a personal-gmail User — leftover debris, not used for login.
 *
 * WHAT THIS DOES (only touches these 3 specific, already-confirmed records):
 *   1. Re-points the V7032 Employee row's userId to your real login User
 *      (gaurav.kumar@vinsupskillacademy.com) — so your login account finally has an
 *      Employee, a department, and inherits the Production module access.
 *   2. Moves the PRODUCTION_TRAINING EDIT override from the old demo User onto your
 *      real login User (your existing FINANCE_ADMIN EDIT grant is left untouched).
 *   3. Deactivates the two stray accounts so they stop being a source of confusion:
 *        - the old demo User (gaurav.kumar@hrms.com) — now orphaned, isActive = false
 *        - the duplicate EMP00025 Employee — status TERMINATED, its User isActive = false
 *
 * SAFETY: dry run by default — prints what it would do. Pass --apply to write.
 * Wrapped in one transaction; re-verifies all 3 records by email/code before touching
 * anything, and aborts if any of them don't match what was confirmed above.
 *
 * USAGE
 *   cd backend
 *   npx ts-node fix-gaurav-account.ts
 *   npx ts-node fix-gaurav-account.ts --apply
 */
import { PrismaClient, AccessLevel, EmployeeStatus } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const LOGIN_EMAIL = 'gaurav.kumar@vinsupskillacademy.com';
const STALE_DEMO_EMAIL = 'gaurav.kumar@hrms.com';
const STALE_DUPLICATE_CODE = 'EMP00025';
const REAL_CODE = 'V7032';

async function main() {
  console.log(`\n=== Fix Gaurav's account — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'} ===\n`);

  const loginUser = await prisma.user.findUnique({ where: { email: LOGIN_EMAIL } });
  const realEmployee = await prisma.employee.findUnique({ where: { employeeCode: REAL_CODE }, include: { user: true } });
  const dupEmployee = await prisma.employee.findUnique({ where: { employeeCode: STALE_DUPLICATE_CODE }, include: { user: true } });

  if (!loginUser) throw new Error(`Could not find User with email ${LOGIN_EMAIL} — aborting, nothing matches what was confirmed earlier.`);
  if (!realEmployee) throw new Error(`Could not find Employee ${REAL_CODE} — aborting.`);
  if (!dupEmployee) throw new Error(`Could not find Employee ${STALE_DUPLICATE_CODE} — aborting.`);
  if (realEmployee.user.email !== STALE_DEMO_EMAIL) {
    throw new Error(`Expected ${REAL_CODE}'s current user email to be ${STALE_DEMO_EMAIL}, found ${realEmployee.user.email} instead — data has changed since diagnosis, aborting to avoid touching the wrong record.`);
  }
  if (loginUser.id === realEmployee.userId) {
    console.log('Nothing to do — the login user is already linked to the real Employee record.');
    return;
  }

  console.log(`Login user (${LOGIN_EMAIL})        id = ${loginUser.id}`);
  console.log(`Real Employee ${REAL_CODE}          id = ${realEmployee.id}, currently on user ${realEmployee.userId} (${realEmployee.user.email})`);
  console.log(`Stale duplicate ${STALE_DUPLICATE_CODE}     id = ${dupEmployee.id}, user ${dupEmployee.userId} (${dupEmployee.user.email})`);

  console.log(`\n1. Re-point Employee ${REAL_CODE} (${realEmployee.id}) from userId ${realEmployee.userId} -> ${loginUser.id}`);
  console.log(`2. Move PRODUCTION_TRAINING EDIT override from ${realEmployee.userId} -> ${loginUser.id}`);
  console.log(`3. Deactivate stale demo user ${realEmployee.userId} (${STALE_DEMO_EMAIL}) — isActive = false`);
  console.log(`4. Deactivate duplicate Employee ${STALE_DUPLICATE_CODE} (${dupEmployee.id}) — status = TERMINATED, user ${dupEmployee.userId} isActive = false`);

  if (!APPLY) {
    console.log('\nDry run only — nothing was written. Re-run with --apply once this looks right.');
    return;
  }

  await prisma.$transaction(async (tx) => {
    const oldUserId = realEmployee.userId;

    // 1. Re-point the real Employee to the login user.
    await tx.employee.update({ where: { id: realEmployee.id }, data: { userId: loginUser.id } });

    // 2. Move the PRODUCTION_TRAINING grant onto the login user (delete+recreate to dodge the unique constraint).
    const existingOnLogin = await tx.userModuleAccess.findUnique({
      where: { userId_module: { userId: loginUser.id, module: 'PRODUCTION_TRAINING' } },
    });
    await tx.userModuleAccess.deleteMany({ where: { userId: oldUserId, module: 'PRODUCTION_TRAINING' } });
    if (!existingOnLogin) {
      await tx.userModuleAccess.create({
        data: { userId: loginUser.id, module: 'PRODUCTION_TRAINING', accessLevel: AccessLevel.EDIT, note: 'Production manager — moved from stale demo account' },
      });
    }

    // 3. Deactivate the now-orphaned stale demo user + kill its sessions.
    await tx.user.update({ where: { id: oldUserId }, data: { isActive: false } });
    await tx.userSession.deleteMany({ where: { userId: oldUserId } });

    // 4. Deactivate the stray duplicate Employee + its user.
    await tx.employee.update({ where: { id: dupEmployee.id }, data: { status: EmployeeStatus.TERMINATED } });
    await tx.user.update({ where: { id: dupEmployee.userId }, data: { isActive: false } });
    await tx.userSession.deleteMany({ where: { userId: dupEmployee.userId } });
  });

  console.log('\nDone. Log out and log back in as gaurav.kumar@vinsupskillacademy.com — Production should now appear.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
