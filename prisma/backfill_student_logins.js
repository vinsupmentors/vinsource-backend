// node prisma/backfill_student_logins.js
//
// One-off fix for students created before auto-login-provisioning existed
// (see buildStudentUserCreate in src/controllers/production.controller.ts).
// Finds every Student with userId = NULL and creates a matching User row:
//   email    = student.email (lowercased) — or a synthetic placeholder if blank
//   password = hash(studentCode)   <-- same convention as new students
//   role     = STUDENT
//   mustChangePassword = true (forces password change + MIS wizard on first login)
//
// If a User with that email already exists (e.g. duplicate/leftover row),
// the student is skipped and reported so you can resolve it by hand.

const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient();

async function main() {
  const orphans = await p.student.findMany({
    where: { userId: null },
    select: { id: true, studentCode: true, email: true, firstName: true, lastName: true },
  });

  console.log(`Found ${orphans.length} student(s) without a login account.\n`);

  let created = 0;
  let skipped = 0;

  for (const s of orphans) {
    const loginEmail = ((s.email && s.email.trim()) || `${s.studentCode.toLowerCase()}@students.vinsupacademy.local`).toLowerCase();

    const existing = await p.user.findUnique({ where: { email: loginEmail } });
    if (existing) {
      console.log(`SKIP  ${s.studentCode} (${s.firstName} ${s.lastName}) — a User with email "${loginEmail}" already exists (id ${existing.id}). Link or rename manually.`);
      skipped++;
      continue;
    }

    const password = await bcrypt.hash(s.studentCode, 12);
    const user = await p.user.create({
      data: {
        email: loginEmail,
        password,
        role: 'STUDENT',
        mustChangePassword: true,
      },
    });

    await p.student.update({
      where: { id: s.id },
      data: { userId: user.id },
    });

    console.log(`OK    ${s.studentCode} (${s.firstName} ${s.lastName}) -> login: ${loginEmail}  password: ${s.studentCode}`);
    created++;
  }

  console.log(`\nDone. Created ${created} login(s), skipped ${skipped}.`);
}

main().catch(console.error).finally(() => p.$disconnect());
