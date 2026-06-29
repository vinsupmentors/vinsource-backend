/**
 * Employee/User reset script — deactivates everyone NOT in the new roster,
 * and reconciles (or creates) the 32 people from Employee_Login_Credentials.docx.
 *
 * WHY NOT A HARD DELETE:
 * Dozens of tables hold REQUIRED foreign keys to Employee (trainer assignments,
 * project releases, finance records, CRM leads, online-test activations, etc.).
 * A real DELETE on Employee/User would hit FK constraint errors and abort
 * partway through. Deactivating preserves history and is what the schema is
 * built for (Employee.status has TERMINATED/INACTIVE, User.isActive exists).
 *
 * WHAT IT DOES
 *  1. Loads every existing Employee (+ User + Department).
 *  2. For each of the 32 people below: tries to match an existing Employee by
 *     employeeCode, then by exact first+last name. If found, REPAIRS it in
 *     place (fixes email, department, employeeCode, resets password,
 *     re-activates, forces a password change) — this also fixes duplicate-
 *     account messes like the Gaurav/V7032 issue, because the existing
 *     correct Employee row gets kept and just corrected rather than orphaned.
 *     If no match, creates a brand new User+Employee pair.
 *  3. Every Employee NOT matched to anyone in the list gets deactivated:
 *     User.isActive = false, Employee.status = 'TERMINATED', and their
 *     UserSession rows (refresh tokens) are deleted so they can't silently
 *     stay logged in. (Already-issued JWT access tokens remain valid until
 *     they naturally expire — that's a separate, pre-existing limitation of
 *     this app's stateless-JWT auth, not something this script can fix.)
 *
 * SAFETY
 *  - Defaults to DRY RUN: prints exactly what it would do, changes nothing.
 *  - Run with --apply to actually write changes.
 *  - Wrapped in a single Prisma transaction — if anything fails, nothing
 *    is committed.
 *
 * USAGE
 *   cd backend
 *   npx ts-node reset-employees.ts             # dry run — review first
 *   npx ts-node reset-employees.ts --apply      # actually applies changes
 */
import { PrismaClient, Role, EmployeeStatus } from '@prisma/client';
import bcrypt from 'bcryptjs';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');
const DEFAULT_PASSWORD = 'Vinsup@123';

type Roster = { code: string; name: string; department: string; email: string };

// ── The new roster, straight from Employee_Login_Credentials.docx ──────────
const ROSTER: Roster[] = [
  { code: 'V7000', name: 'Clement Sudharson', department: 'Digital Marketing & Placements', email: 'clement.sudharson@vinsupskillacademy.com' },
  { code: 'V7007', name: 'Pooranam Annamalai', department: 'Super Admin', email: 'pooranam.annamalai@vinsupskillacademy.com' },
  { code: 'V7003', name: 'Gokul S', department: 'Sales', email: 'gokul.s@vinsupskillacademy.com' },
  { code: 'V7006', name: 'Kumaresan R', department: 'Sales', email: 'kumaresan.r@vinsupskillacademy.com' },
  { code: 'V7011', name: 'Hariharan', department: 'Sales', email: 'hariharan@vinsupskillacademy.com' },
  { code: 'V7012', name: 'Muhammad Ramees J', department: 'Sales', email: 'muhammad.ramees@vinsupskillacademy.com' },
  { code: 'V7016', name: 'Shabir Ahmed S', department: 'Sales', email: 'shabir.ahmed@vinsupskillacademy.com' },
  { code: 'V7017', name: 'Muneeswari', department: 'Housekeeping', email: 'muneeswari@vinsupskillacademy.com' },
  { code: 'V7020', name: 'Jothimalar S', department: 'Sales', email: 'jothimalar.s@vinsupskillacademy.com' },
  { code: 'V7029', name: 'Nishanthini S', department: 'Sales', email: 'nishanthini.s@vinsupskillacademy.com' },
  { code: 'V7030', name: 'Midhun K', department: 'Operations', email: 'midhun.k@vinsupskillacademy.com' },
  { code: 'V7032', name: 'Gaurav Kumar M S', department: 'Production & Admin & Finance', email: 'gaurav.kumar@vinsupskillacademy.com' },
  { code: 'V7037', name: 'Selvakumar Santhanam', department: 'B2B', email: 'selvakumar.santhanam@vinsupskillacademy.com' },
  { code: 'V7040', name: 'Pradhap M', department: 'Sales', email: 'pradhap.m@vinsupskillacademy.com' },
  { code: 'V7044', name: 'Steffi S', department: 'Admin & Receiption', email: 'steffi.s@vinsupskillacademy.com' },
  { code: 'V7045', name: 'Ranjith S', department: 'Sales', email: 'ranjith.s@vinsupskillacademy.com' },
  { code: 'V7046', name: 'Hariharashuthan A', department: 'Sales', email: 'hariharashuthan.a@vinsupskillacademy.com' },
  { code: 'V7048', name: 'Jayasoorya Subramanian M', department: 'Admin & Sales', email: 'jayasoorya.subramanian@vinsupskillacademy.com' },
  { code: 'V7049', name: 'Danush V K', department: 'Digital Marketing', email: 'danush.v@vinsupskillacademy.com' },
  { code: 'V7051', name: 'Ramya', department: 'Sales', email: 'ramya@vinsupskillacademy.com' },
  { code: 'V7052', name: 'Athithyan J', department: 'Production', email: 'athithyan.j@vinsupskillacademy.com' },
  { code: 'V7053', name: 'Sneha M', department: 'Digital Marketing', email: 'sneha.m@vinsupskillacademy.com' },
  { code: 'V7054', name: 'Vishmitha V', department: 'Sales', email: 'vishmitha.v@vinsupskillacademy.com' },
  { code: 'V7055', name: 'Micheal Steafun Babu D', department: 'Sales', email: 'micheal.steafun@vinsupskillacademy.com' },
  { code: 'V7056', name: 'Shrihari BH', department: 'Production', email: 'shrihari.bh@vinsupskillacademy.com' },
  { code: 'V7057', name: 'Dhivya V', department: 'Production', email: 'dhivya.v@vinsupskillacademy.com' },
  { code: 'V7058', name: 'Prakalya P', department: 'Production', email: 'prakalya.p@vinsupskillacademy.com' },
  { code: 'V7059', name: 'Samjebadurai Govindaraj', department: 'Placements', email: 'samjebadurai.govindaraj@vinsupskillacademy.com' },
  { code: 'V7060', name: 'Selvam T', department: 'Production', email: 'selvam.t@vinsupskillacademy.com' },
  { code: 'V7061', name: 'Nancy', department: 'Production', email: 'nancy@vinsupskillacademy.com' },
  { code: 'V7062', name: 'Kalaivani Ramesh', department: 'Production', email: 'kalaivani.ramesh@vinsupskillacademy.com' },
  { code: 'V7063', name: 'Varththini V', department: 'Production', email: 'varththini.v@vinsupskillacademy.com' },
];

function splitName(full: string): { firstName: string; lastName: string } {
  const parts = full.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: parts[0] };
  return { firstName: parts.slice(0, -1).join(' '), lastName: parts[parts.length - 1] };
}

function slugCode(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 8) || 'DEPT';
}

async function main() {
  console.log(`\n=== Employee roster reset — ${APPLY ? 'APPLYING CHANGES' : 'DRY RUN (pass --apply to write)'} ===\n`);

  const company = await prisma.company.findFirst();
  if (!company) throw new Error('No Company record found — create one before running this script.');
  console.log(`Using company: ${company.name} (${company.id})`);

  const allEmployees = await prisma.employee.findMany({
    include: { user: true, department: true },
  });

  const rosterCodes = new Set(ROSTER.map((r) => r.code));
  const rosterEmails = new Set(ROSTER.map((r) => r.email.toLowerCase()));

  // ── Department cache: name -> Department row (existing or to-be-created) ──
  const deptCache = new Map<string, { id: string; name: string }>();
  for (const e of allEmployees) {
    if (e.department) deptCache.set(e.department.name.toLowerCase(), e.department);
  }

  async function resolveDepartment(name: string, tx: any): Promise<string> {
    const key = name.toLowerCase();
    const cached = deptCache.get(key);
    if (cached) return cached.id;
    const existing = await tx.department.findFirst({ where: { companyId: company!.id, name } });
    if (existing) { deptCache.set(key, existing); return existing.id; }
    let code = slugCode(name);
    let suffix = 0;
    while (await tx.department.findFirst({ where: { companyId: company!.id, code: suffix ? `${code}${suffix}` : code } })) suffix++;
    const created = await tx.department.create({
      data: { companyId: company!.id, name, code: suffix ? `${code}${suffix}` : code },
    });
    deptCache.set(key, created);
    console.log(`  [dept] creating new Department "${name}" (code ${created.code})`);
    return created.id;
  }

  // ── Match each roster entry to an existing Employee, by code then by name ──
  const matched = new Map<string, (typeof allEmployees)[number]>(); // roster code -> existing Employee
  const usedEmployeeIds = new Set<string>();

  for (const r of ROSTER) {
    let hit = allEmployees.find((e) => e.employeeCode === r.code);
    if (!hit) {
      const { firstName, lastName } = splitName(r.name);
      const nameMatches = allEmployees.filter(
        (e) =>
          !usedEmployeeIds.has(e.id) &&
          e.firstName.trim().toLowerCase() === firstName.toLowerCase() &&
          e.lastName.trim().toLowerCase() === lastName.toLowerCase()
      );
      if (nameMatches.length === 1) hit = nameMatches[0];
      else if (nameMatches.length > 1) {
        console.log(`  [!] AMBIGUOUS: ${nameMatches.length} existing employees named "${r.name}" — skipping auto-match for ${r.code}, will create a new record. Resolve duplicates manually afterward if that's wrong.`);
      }
    }
    if (hit) { matched.set(r.code, hit); usedEmployeeIds.add(hit.id); }
  }

  console.log(`\nMatched ${matched.size}/${ROSTER.length} roster entries to existing Employee records. ${ROSTER.length - matched.size} will be created fresh.\n`);

  const toDeactivate = allEmployees.filter((e) => !usedEmployeeIds.has(e.id) && e.status !== 'TERMINATED');
  console.log(`Will deactivate ${toDeactivate.length} existing employee(s) not in the new roster:`);
  for (const e of toDeactivate) console.log(`  - ${e.employeeCode}  ${e.firstName} ${e.lastName}  <${e.user.email}>`);
  console.log('');

  if (!APPLY) {
    console.log('Roster actions that WOULD happen:');
    for (const r of ROSTER) {
      const hit = matched.get(r.code);
      console.log(hit
        ? `  [update] ${r.code} ${r.name} -> reusing existing Employee ${hit.id} (was ${hit.employeeCode} / ${hit.email}), resetting password, dept="${r.department}"`
        : `  [create] ${r.code} ${r.name} -> new Employee+User, email=${r.email}, dept="${r.department}"`);
    }
    console.log('\nDry run only — nothing was written. Re-run with --apply once this looks right.');
    return;
  }

  const hashedDefault = await bcrypt.hash(DEFAULT_PASSWORD, 12);

  await prisma.$transaction(async (tx) => {
    // 1. Deactivate everyone not in the roster.
    for (const e of toDeactivate) {
      await tx.user.update({ where: { id: e.userId }, data: { isActive: false } });
      await tx.employee.update({ where: { id: e.id }, data: { status: EmployeeStatus.TERMINATED } });
      await tx.userSession.deleteMany({ where: { userId: e.userId } });
    }

    // 2. Reconcile or create each roster entry.
    for (const r of ROSTER) {
      const departmentId = await resolveDepartment(r.department, tx);
      const role: Role = r.name === 'Pooranam Annamalai' ? Role.SUPER_ADMIN : Role.EMPLOYEE;
      const { firstName, lastName } = splitName(r.name);
      const hit = matched.get(r.code);

      if (hit) {
        await tx.user.update({
          where: { id: hit.userId },
          data: {
            email: r.email,
            password: hashedDefault,
            role,
            isActive: true,
            mustChangePassword: true,
          },
        });
        await tx.employee.update({
          where: { id: hit.id },
          data: {
            employeeCode: r.code,
            firstName,
            lastName,
            email: r.email,
            departmentId,
            status: EmployeeStatus.ACTIVE,
          },
        });
        await tx.userSession.deleteMany({ where: { userId: hit.userId } });
      } else {
        const user = await tx.user.create({
          data: { email: r.email, password: hashedDefault, role, mustChangePassword: true },
        });
        await tx.employee.create({
          data: {
            userId: user.id,
            companyId: company!.id,
            departmentId,
            employeeCode: r.code,
            firstName,
            lastName,
            email: r.email,
            joiningDate: new Date(),
            status: EmployeeStatus.ACTIVE,
          },
        });
      }
    }
  });

  console.log('Done. All 32 roster accounts are active with the default password (forced change on next login);');
  console.log('everyone else has been marked TERMINATED/inactive and had their sessions revoked.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
