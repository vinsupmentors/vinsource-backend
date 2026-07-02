/**
 * create_super_admin.js
 * ─────────────────────
 * Creates a hidden SUPER_ADMIN control account (full portal control like
 * Pooranam Annamalai, but excluded from employee lists and counts via
 * Employee.isSystemAccount = true).
 *
 * Usage (on the VPS, from /opt/hrms/vinsource-backend):
 *   node prisma/create_super_admin.js "Full Name" email@domain.com [password]
 *
 * If password is omitted, a random one is generated and printed once.
 */
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const prisma = new PrismaClient();

const [, , name, email, passwordArg] = process.argv;

function randomPassword() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789@#!';
  return Array.from({ length: 12 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

async function main() {
  if (!name || !email) {
    console.log('Usage: node prisma/create_super_admin.js "Full Name" email@domain.com [password]');
    process.exit(1);
  }

  const existing = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    console.error(`✗ A user already exists with email ${email}`);
    process.exit(1);
  }

  const company = await prisma.company.findFirst();
  if (!company) {
    console.error('✗ No company found — seed the database first.');
    process.exit(1);
  }
  const branch = await prisma.branch.findFirst({ where: { companyId: company.id } });

  const password = passwordArg || randomPassword();
  const hashed = await bcrypt.hash(password, 12);

  const parts = name.trim().split(/\s+/);
  const firstName = parts[0];
  const lastName = parts.slice(1).join(' ') || '-';

  // Unique system code (SYS1, SYS2, …) — outside the V-series so it never
  // interferes with V7066+ auto-generation for real employees.
  let n = 1;
  while (await prisma.employee.findUnique({ where: { employeeCode: `SYS${n}` } })) n++;
  const employeeCode = `SYS${n}`;

  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: email.toLowerCase(),
        password: hashed,
        role: 'SUPER_ADMIN',
        canManageAccess: true,
        isActive: true,
      },
    });
    const employee = await tx.employee.create({
      data: {
        userId: user.id,
        companyId: company.id,
        branchId: branch ? branch.id : undefined,
        employeeCode,
        firstName,
        lastName,
        email: email.toLowerCase(),
        joiningDate: new Date(),
        status: 'ACTIVE',
        isSystemAccount: true, // hidden from employee lists & counts
      },
    });
    return { user, employee };
  });

  console.log('✓ Hidden SUPER_ADMIN control account created');
  console.log('  Name    :', name);
  console.log('  Email   :', result.user.email);
  console.log('  Password:', password, passwordArg ? '' : '(generated — save it now, it is not stored in plain text)');
  console.log('  Code    :', employeeCode, '(system account — not shown in employee count)');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
