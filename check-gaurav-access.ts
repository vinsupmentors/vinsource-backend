/**
 * Read-only diagnostic — prints everything related to Gaurav's account so we
 * can see exactly why the Production menu isn't showing up after
 * grant-production-access.ts --apply.
 *
 * Checks:
 *  1. Every Employee row matching code V7032 OR an email containing "gaurav"
 *     (catches duplicate-account situations findFirst() can silently pick
 *     the wrong row in).
 *  2. For each, their User row (id, email, isActive), department name, and
 *     the full effective access map (department defaults + user overrides),
 *     computed the same way the real app does.
 *  3. Every UserModuleAccess row for PRODUCTION_TRAINING in the whole system,
 *     so we can see which userId actually got the grant.
 *
 * USAGE (read-only, makes no changes)
 *   cd backend
 *   npx ts-node check-gaurav-access.ts
 */
import { PrismaClient, ModuleName, AccessLevel } from '@prisma/client';

const prisma = new PrismaClient();
const MODULE: ModuleName = 'PRODUCTION_TRAINING';

async function effectiveAccess(userId: string) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: {
      employee: { include: { department: { include: { moduleAccessDefaults: true } } } },
      moduleAccessGrants: true,
    },
  });
  if (!user) return {};
  const access: Record<string, AccessLevel> = {};
  for (const dma of user.employee?.department?.moduleAccessDefaults ?? []) access[dma.module] = dma.accessLevel;
  for (const ov of user.moduleAccessGrants) {
    if (ov.accessLevel === AccessLevel.NONE) delete access[ov.module];
    else access[ov.module] = ov.accessLevel;
  }
  return access;
}

async function main() {
  console.log('\n=== User row for gaurav.kumar@vinsupskillacademy.com (the actual login email) ===\n');
  const loginUser = await prisma.user.findUnique({
    where: { email: 'gaurav.kumar@vinsupskillacademy.com' },
    include: {
      employee: { include: { department: true } },
      moduleAccessGrants: true,
    },
  });
  if (!loginUser) {
    console.log('  NO USER FOUND with this exact email — login must be matching something else (check case/typos in the DB).');
  } else {
    console.log(`  User.id        = ${loginUser.id}`);
    console.log(`  isActive       = ${loginUser.isActive}`);
    console.log(`  role           = ${loginUser.role}`);
    console.log(`  linked employee = ${loginUser.employee ? `${loginUser.employee.firstName} ${loginUser.employee.lastName} / ${loginUser.employee.employeeCode} / dept=${loginUser.employee.department?.name ?? '(none)'}` : 'NONE — ORPHANED USER, no Employee row at all'}`);
    console.log(`  own UserModuleAccess rows = ${JSON.stringify(loginUser.moduleAccessGrants)}`);
    const access = await effectiveAccess(loginUser.id);
    console.log(`  effectiveAccess = ${JSON.stringify(access)}`);
  }

  console.log('\n=== Employee rows matching V7032 or "gaurav" ===\n');

  const candidates = await prisma.employee.findMany({
    where: {
      OR: [
        { employeeCode: 'V7032' },
        { email: { contains: 'gaurav' } },
        { firstName: { contains: 'Gaurav' } },
      ],
    },
    include: { department: true, user: true },
  });

  if (candidates.length === 0) {
    console.log('No matching Employee rows found at all — something is very wrong.');
  }
  if (candidates.length > 1) {
    console.log(`!! FOUND ${candidates.length} MATCHING EMPLOYEE ROWS — this is almost certainly the bug. !!\n`);
  }

  for (const emp of candidates) {
    console.log(`Employee.id        = ${emp.id}`);
    console.log(`employeeCode       = ${emp.employeeCode}`);
    console.log(`name               = ${emp.firstName} ${emp.lastName}`);
    console.log(`status             = ${emp.status}`);
    console.log(`department         = ${emp.department?.name ?? '(none)'} (id ${emp.department?.id ?? '-'})`);
    console.log(`userId             = ${emp.userId}`);
    console.log(`user.email         = ${emp.user.email}`);
    console.log(`user.isActive      = ${emp.user.isActive}`);

    const access = await effectiveAccess(emp.userId);
    console.log(`effectiveAccess    = ${JSON.stringify(access)}`);
    console.log(`-> has PRODUCTION_TRAINING? ${access[MODULE] ? `YES (${access[MODULE]})` : 'NO'}`);
    console.log('');
  }

  console.log('=== All UserModuleAccess rows for PRODUCTION_TRAINING (system-wide) ===\n');
  const grants = await prisma.userModuleAccess.findMany({
    where: { module: MODULE },
    include: { user: { include: { employee: true } } },
  });
  for (const g of grants) {
    console.log(`  userId=${g.userId}  level=${g.accessLevel}  -> ${g.user.email} (employee: ${g.user.employee ? `${g.user.employee.firstName} ${g.user.employee.lastName} / ${g.user.employee.employeeCode} / status=${g.user.employee.status}` : 'NONE LINKED'})`);
  }
  if (grants.length === 0) console.log('  (none found — the override never got written!)');

  console.log('\n=== Departments with "Production" in the name + their PRODUCTION_TRAINING grant ===\n');
  const depts = await prisma.department.findMany({
    where: { name: { contains: 'Production' } },
    include: { moduleAccessDefaults: { where: { module: MODULE } } },
  });
  for (const d of depts) {
    console.log(`  "${d.name}" (id ${d.id}) -> ${d.moduleAccessDefaults[0]?.accessLevel ?? 'NO GRANT ROW'}`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
