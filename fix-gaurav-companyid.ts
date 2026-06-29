/**
 * Fixes the actual root cause of "only 3 trainers show up": Gaurav's own
 * Employee record (V7032) is filed under companyId
 * 1eb5ae91-3c0a-4c94-9c1b-9ba036eccd17 (a stale/duplicate company), even
 * though its department (dept-real-prod) belongs to the real company
 * faad5ec0-4e45-43e4-a47b-771cc6de60f7 ("Vinsup Skill Academy").
 *
 * Every API call scopes by req.user.companyId, which is read straight from
 * employee.companyId at login (see auth.controller.ts). So Gaurav's session
 * is scoped to the WRONG company, and can only ever see the handful of
 * other records (Devi Shree x2) that share that same wrong companyId.
 * Selvam, Dhivya, Shrihari, Prakalya, Athithyan, etc. are correctly filed
 * under the real company and are invisible to him no matter what.
 *
 * FIX: set Employee V7032's companyId to the real company id, matching its
 * department.
 *
 * SAFETY: dry run by default — prints what it would do. Pass --apply to write.
 *
 * USAGE
 *   cd backend
 *   npx ts-node fix-gaurav-companyid.ts
 *   npx ts-node fix-gaurav-companyid.ts --apply
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

const REAL_CODE = 'V7032';
const STALE_COMPANY_ID = '1eb5ae91-3c0a-4c94-9c1b-9ba036eccd17';
const REAL_COMPANY_ID = 'faad5ec0-4e45-43e4-a47b-771cc6de60f7';

async function main() {
  console.log(`\n=== Fix Gaurav's companyId — ${APPLY ? 'APPLYING' : 'DRY RUN (pass --apply to write)'} ===\n`);

  const emp = await prisma.employee.findUnique({
    where: { employeeCode: REAL_CODE },
    include: { department: true },
  });
  if (!emp) throw new Error(`Could not find Employee ${REAL_CODE} — aborting.`);
  if (emp.companyId !== STALE_COMPANY_ID) {
    throw new Error(`Expected ${REAL_CODE}'s companyId to be ${STALE_COMPANY_ID}, found ${emp.companyId} instead — data has changed since diagnosis, aborting.`);
  }
  if (emp.department?.companyId !== REAL_COMPANY_ID) {
    throw new Error(`Expected ${REAL_CODE}'s department companyId to be ${REAL_COMPANY_ID}, found ${emp.department?.companyId} instead — aborting.`);
  }

  console.log(`Employee ${REAL_CODE} (${emp.firstName} ${emp.lastName}), id=${emp.id}`);
  console.log(`  current companyId = ${emp.companyId}  (stale/duplicate company)`);
  console.log(`  department         = "${emp.department?.name}" (${emp.departmentId}), real companyId = ${emp.department?.companyId}`);
  console.log(`\nWill update companyId: ${STALE_COMPANY_ID} -> ${REAL_COMPANY_ID}`);

  if (!APPLY) {
    console.log('\nDry run only — nothing was written. Re-run with --apply once this looks right.');
    return;
  }

  await prisma.employee.update({ where: { id: emp.id }, data: { companyId: REAL_COMPANY_ID } });
  console.log('\nDone. Gaurav must log out and log back in (new JWT picks up the corrected companyId).');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
