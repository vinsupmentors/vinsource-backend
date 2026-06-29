import prisma from '../config/database';
import { hashPassword } from './helpers';
import data from './data/realOrg.json';

const DEFAULT_PASSWORD = 'Vinsup@123';

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z\s]/g, '')
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .join('.');
}

function splitName(fullName: string): { firstName: string; lastName: string } {
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) {
    return { firstName: parts[0], lastName: '-' };
  }
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

async function seedRealOrg() {
  console.log('🌱 Seeding real organization data (Vinsup Skill Academy)...');

  // ── Company ──────────────────────────────────────────────────────────────
  const company = await prisma.company.upsert({
    where: { code: data.company.code },
    update: {},
    create: {
      name: data.company.name,
      code: data.company.code,
      email: data.company.email,
      phone: data.company.phone,
      address: data.company.address,
    },
  });

  const branch = await prisma.branch.upsert({
    where: { id: `branch-${data.company.code.toLowerCase()}-hq` },
    update: {},
    create: {
      id: `branch-${data.company.code.toLowerCase()}-hq`,
      companyId: company.id,
      name: 'Headquarters',
      code: 'HQ',
      city: 'Chennai',
      state: 'Tamil Nadu',
      country: 'India',
    },
  });

  // ── Departments ───────────────────────────────────────────────────────────
  const deptMap: Record<string, { id: string }> = {};
  for (const d of data.departments) {
    const dept = await prisma.department.upsert({
      where: { id: `dept-real-${d.code.toLowerCase()}` },
      update: { name: d.name },
      create: {
        id: `dept-real-${d.code.toLowerCase()}`,
        companyId: company.id,
        name: d.name,
        code: d.code,
      },
    });
    deptMap[d.code] = dept;
  }

  // ── Designations ──────────────────────────────────────────────────────────
  const desigMap: Record<string, { id: string }> = {};
  for (const ds of data.designations) {
    const designation = await prisma.designation.upsert({
      where: { id: `desig-real-${ds.code.toLowerCase()}` },
      update: { name: ds.name, level: ds.level },
      create: {
        id: `desig-real-${ds.code.toLowerCase()}`,
        name: ds.name,
        code: ds.code,
        level: ds.level,
      },
    });
    desigMap[ds.code] = designation;
  }

  // ── Default module access per department ────────────────────────────────
  for (const entry of data.departmentModuleAccess) {
    const dept = deptMap[entry.dept];
    if (!dept) continue;
    for (const [moduleName, accessLevel] of entry.modules) {
      await prisma.departmentModuleAccess.upsert({
        where: { id: `dma-${entry.dept.toLowerCase()}-${moduleName.toLowerCase()}` },
        update: { accessLevel: accessLevel as any },
        create: {
          id: `dma-${entry.dept.toLowerCase()}-${moduleName.toLowerCase()}`,
          departmentId: dept.id,
          module: moduleName as any,
          accessLevel: accessLevel as any,
        },
      });
    }
  }

  // ── Employees ─────────────────────────────────────────────────────────────
  const emailUsed = new Set<string>();
  const credentialsLog: { code: string; name: string; email: string }[] = [];

  for (const emp of data.employees) {
    const { firstName, lastName } = splitName(emp.name);
    const dept = deptMap[emp.dept];
    const designation = desigMap[emp.desig];

    let emailLocal = slugify(emp.name) || emp.code.toLowerCase();
    if (emailUsed.has(emailLocal)) {
      emailLocal = `${emailLocal}.${emp.code.toLowerCase()}`;
    }
    emailUsed.add(emailLocal);
    const email = `${emailLocal}@vinsupskillacademy.com`;

    const password = await hashPassword(DEFAULT_PASSWORD);
    const employeeCode = emp.code.toUpperCase();

    const status = emp.probationCompleted ? 'ACTIVE' : 'ON_PROBATION';
    const joiningDate = new Date(emp.join);
    const confirmationDate = emp.probationCompleted ? joiningDate : null;

    const user = await prisma.user.upsert({
      where: { email },
      update: {
        role: emp.role as any,
        canManageAccess: emp.canManageAccess,
      },
      create: {
        email,
        password,
        role: emp.role as any,
        canManageAccess: emp.canManageAccess,
      },
    });

    await prisma.employee.upsert({
      where: { employeeCode },
      update: {
        departmentId: dept?.id,
        designationId: designation?.id,
        status: status as any,
        confirmationDate: confirmationDate ?? undefined,
      },
      create: {
        userId: user.id,
        companyId: company.id,
        branchId: branch.id,
        departmentId: dept?.id,
        designationId: designation?.id,
        employeeCode,
        firstName,
        lastName,
        email,
        joiningDate,
        confirmationDate: confirmationDate ?? undefined,
        status: status as any,
      },
    });

    credentialsLog.push({ code: employeeCode, name: emp.name, email });

    // ── Per-user module access overrides (exceptions to the department default) ──
    const overrides = (emp as { moduleOverrides?: [string, string][] }).moduleOverrides ?? [];
    for (const [moduleName, accessLevel] of overrides) {
      await prisma.userModuleAccess.upsert({
        where: { userId_module: { userId: user.id, module: moduleName as any } },
        update: { accessLevel: accessLevel as any },
        create: { userId: user.id, module: moduleName as any, accessLevel: accessLevel as any },
      });
    }
  }

  // ── Reporting-manager chain (second pass — managerId references another Employee, ──
  // ── so this must run after every employee row above already exists) ──────────────
  for (const emp of data.employees) {
    const managerCode = (emp as { manager?: string }).manager;
    if (!managerCode) continue;

    const managerEmployee = await prisma.employee.findUnique({
      where: { employeeCode: managerCode.toUpperCase() },
    });
    if (!managerEmployee) {
      console.warn(`  ⚠️  Manager "${managerCode}" not found for ${emp.code} (${emp.name}) — skipping`);
      continue;
    }

    await prisma.employee.update({
      where: { employeeCode: emp.code.toUpperCase() },
      data: { managerId: managerEmployee.id },
    });
  }

  console.log('✅ Real org seed complete!');
  console.log('');
  console.log(`Seeded ${data.departments.length} departments, ${data.designations.length} designations, ${data.employees.length} employees.`);
  console.log(`All employees default password: ${DEFAULT_PASSWORD} (must be changed on first login)`);
  console.log('');
  console.log('Master Control users (canManageAccess = true):');
  for (const emp of data.employees.filter((e) => e.canManageAccess)) {
    console.log(`  - ${emp.name} (${emp.code})`);
  }
}

seedRealOrg()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
