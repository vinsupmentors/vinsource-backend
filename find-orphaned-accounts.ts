/**
 * One-off diagnostic script — run locally against your real DB:
 *   cd backend
 *   npx ts-node find-orphaned-accounts.ts
 *
 * Finds:
 *  1. Every User with no linked Employee (the "orphaned login" bug class).
 *  2. Employees whose firstName+lastName collide (likely duplicate profiles
 *     created for the same real person under two different logins).
 *
 * Read-only. Does not modify any data.
 */
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const orphanedUsers = await prisma.user.findMany({
    where: { employee: null, student: null },
    select: { id: true, email: true, role: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
  });

  console.log(`\n=== Users with NO linked Employee or Student (${orphanedUsers.length}) ===`);
  for (const u of orphanedUsers) {
    console.log(`  ${u.id}  ${u.email}  role=${u.role}  createdAt=${u.createdAt.toISOString()}`);
  }

  const employees = await prisma.employee.findMany({
    select: { id: true, firstName: true, lastName: true, email: true, userId: true, createdAt: true, status: true },
  });

  const byName = new Map<string, typeof employees>();
  for (const e of employees) {
    const key = `${e.firstName.trim().toLowerCase()}|${e.lastName.trim().toLowerCase()}`;
    byName.set(key, [...(byName.get(key) ?? []), e]);
  }

  const duplicates = [...byName.entries()].filter(([, list]) => list.length > 1);
  console.log(`\n=== Employees sharing the same first+last name (${duplicates.length} groups) ===`);
  for (const [name, list] of duplicates) {
    console.log(`  ${name}:`);
    for (const e of list) {
      console.log(`    Employee.id=${e.id}  email=${e.email}  userId=${e.userId}  status=${e.status}  createdAt=${e.createdAt.toISOString()}`);
    }
  }

  console.log('\nIf you recognize your own name/email in either list above, that confirms the orphan-account theory.');
  console.log('Fix options once confirmed (do NOT run blindly — pick based on what you see):');
  console.log('  A) If you have two Employee rows for the same person: keep the one the trainer assignment points at,');
  console.log('     delete/deactivate the other, and log in with the User account linked to the KEPT Employee.');
  console.log('  B) If you want to keep using your CURRENT login: update the orphaned User row to link the correct');
  console.log('     Employee (Employee.userId = <this User.id>), and remove/merge the duplicate Employee+User pair.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
