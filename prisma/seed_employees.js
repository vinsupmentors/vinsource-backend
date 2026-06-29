// node prisma/seed_employees.js
// Adds 18 real employees, new departments/designations, fixes B2B→LDM reporting
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');
const p = new PrismaClient();

async function main() {
  const company = await p.company.findFirst({ where: { code: 'DEMO' } });
  if (!company) { console.error('Company not found — run main seed first'); process.exit(1); }
  const cid = company.id;

  const hash = await bcrypt.hash('Employee@1234', 10);

  // ── 1. Extra departments ────────────────────────────────────────────────────
  const extraDepts = [
    { id: 'dept-house', name: 'Housekeeping', code: 'HOUSE' },
    { id: 'dept-hr',    name: 'HR',           code: 'HR'    },
  ];
  for (const d of extraDepts) {
    await p.department.upsert({
      where: { id: d.id },
      update: { name: d.name, code: d.code, isActive: true },
      create: { id: d.id, companyId: cid, name: d.name, code: d.code },
    });
  }
  console.log('✅ Extra departments upserted (Housekeeping, HR)');

  // ── 2. Extra designations ───────────────────────────────────────────────────
  const extraDesigs = [
    { id: 'desig-vps2',   name: 'VP - Sales',                          code: 'VPS2',   level: 9  },
    { id: 'desig-tls',    name: 'Team Lead - Sales',                   code: 'TLS',    level: 5  },
    { id: 'desig-bda',    name: 'Business Development Associate',       code: 'BDA',    level: 2  },
    { id: 'desig-sbdmb2b',name: 'Senior Business Development Manager - B2B', code: 'SBDMB2B', level: 7 },
    { id: 'desig-aoe',    name: 'Admin & Operations Executive',         code: 'AOE',    level: 2  },
    { id: 'desig-hradm',  name: 'HR-Admin',                            code: 'HRADM',  level: 4  },
    { id: 'desig-ve',     name: 'Video Editor',                        code: 'VE',     level: 2  },
    { id: 'desig-janitor',name: 'Janitor',                             code: 'JAN',    level: 1  },
    { id: 'desig-spark',  name: 'Spark',                               code: 'SPARK',  level: 2  },
  ];
  for (const d of extraDesigs) {
    await p.designation.upsert({
      where: { id: d.id },
      update: { name: d.name, code: d.code, level: d.level, isActive: true },
      create: { id: d.id, name: d.name, code: d.code, level: d.level },
    });
  }
  console.log('✅ Extra designations upserted');

  // ── 3. Employee definitions ─────────────────────────────────────────────────
  // role: SUPER_ADMIN | ADMIN | HR | MANAGER | EMPLOYEE
  // managerId field filled in pass-2 after all employees created
  const empDefs = [
    {
      empId: 'emp-v7000', code: 'V7000', email: 'clement.sudharson@hrms.com',
      firstName: 'Clement', lastName: 'Sudharson',
      deptId: 'dept-admin', desigId: 'desig-cgo',
      joining: new Date('2024-01-10'), role: 'MANAGER', managerKey: null,
    },
    {
      empId: 'emp-v7004', code: 'V7004', email: 'sri.sashmitha@hrms.com',
      firstName: 'Sri Sashmitha', lastName: 'C',
      deptId: 'dept-admin', desigId: 'desig-aoe',
      joining: new Date('2025-03-17'), role: 'EMPLOYEE', managerKey: 'emp-v7000',
    },
    {
      empId: 'emp-v7006', code: 'V7006', email: 'kumaresan.r@hrms.com',
      firstName: 'Kumaresan', lastName: 'R',
      deptId: 'dept-sales', desigId: 'desig-tls',
      joining: new Date('2025-03-17'), role: 'MANAGER', managerKey: 'emp-v7003',
    },
    {
      empId: 'emp-v7003', code: 'V7003', email: 'gokul.s@hrms.com',
      firstName: 'Gokul', lastName: 'S',
      deptId: 'dept-sales', desigId: 'desig-vps2',
      joining: new Date('2025-04-07'), role: 'MANAGER', managerKey: 'emp-v7000',
    },
    {
      empId: 'emp-v7011', code: 'V7011', email: 'hariharan@hrms.com',
      firstName: 'Hariharan', lastName: '',
      deptId: 'dept-sales', desigId: 'desig-tls',
      joining: new Date('2025-04-21'), role: 'MANAGER', managerKey: 'emp-v7003',
    },
    {
      empId: 'emp-v7012', code: 'V7012', email: 'muhammad.ramees@hrms.com',
      firstName: 'Muhammad Ramees', lastName: 'J',
      deptId: 'dept-sales', desigId: 'desig-bda',
      joining: new Date('2025-04-21'), role: 'EMPLOYEE', managerKey: 'emp-v7003',
    },
    {
      empId: 'emp-v7016', code: 'V7016', email: 'shabir.ahmed@hrms.com',
      firstName: 'Shabir Ahmed', lastName: 'S',
      deptId: 'dept-sales', desigId: 'desig-bda',
      joining: new Date('2025-04-21'), role: 'EMPLOYEE', managerKey: 'emp-v7003',
    },
    {
      empId: 'emp-v7017', code: 'V7017', email: 'muneeswari@hrms.com',
      firstName: 'Muneeswari', lastName: '',
      deptId: 'dept-house', desigId: 'desig-janitor',
      joining: new Date('2025-04-21'), role: 'EMPLOYEE', managerKey: 'emp-v7000',
    },
    {
      empId: 'emp-v7020', code: 'V7020', email: 'jothimalar.s@hrms.com',
      firstName: 'Jothimalar', lastName: 'S',
      deptId: 'dept-sales', desigId: 'desig-bda',
      joining: new Date('2025-04-21'), role: 'EMPLOYEE', managerKey: 'emp-v7003',
    },
    {
      empId: 'emp-v7029', code: 'V7029', email: 'nishanthini.s@hrms.com',
      firstName: 'Nishanthini', lastName: 'S',
      deptId: 'dept-sales', desigId: 'desig-bda',
      joining: new Date('2025-07-02'), role: 'EMPLOYEE', managerKey: 'emp-v7003',
    },
    {
      empId: 'emp-v7030', code: 'V7030', email: 'midhun.k@hrms.com',
      firstName: 'Midhun', lastName: 'K',
      deptId: 'dept-sales', desigId: 'desig-spark',
      joining: new Date('2025-07-02'), role: 'EMPLOYEE', managerKey: 'emp-v7003',
    },
    {
      empId: 'emp-v7032', code: 'V7032', email: 'gaurav.kumar@hrms.com',
      firstName: 'Gaurav Kumar', lastName: 'M S',
      deptId: 'dept-prod', desigId: 'desig-ldm',
      joining: new Date('2025-07-03'), role: 'MANAGER', managerKey: 'emp-v7000',
    },
    {
      empId: 'emp-v7037', code: 'V7037', email: 'selvakumar.santhanam@hrms.com',
      firstName: 'Selvakumar', lastName: 'Santhanam',
      deptId: 'dept-b2b', desigId: 'desig-sbdmb2b',
      joining: new Date('2025-10-03'), role: 'EMPLOYEE', managerKey: 'emp-v7032', // B2B→LDM
    },
    {
      empId: 'emp-v7040', code: 'V7040', email: 'pradhap.m@hrms.com',
      firstName: 'Pradhap', lastName: 'M',
      deptId: 'dept-sales', desigId: 'desig-tls',
      joining: new Date('2025-12-15'), role: 'MANAGER', managerKey: 'emp-v7003',
    },
    {
      empId: 'emp-v7044', code: 'V7044', email: 'steffi.s@hrms.com',
      firstName: 'Steffi', lastName: 'S',
      deptId: 'dept-hr', desigId: 'desig-hradm',
      joining: new Date('2026-01-19'), role: 'HR', managerKey: 'emp-v7000',
    },
    {
      empId: 'emp-v7045', code: 'V7045', email: 'ranjith.s@hrms.com',
      firstName: 'Ranjith', lastName: 'S',
      deptId: 'dept-sales', desigId: 'desig-bda',
      joining: new Date('2026-02-01'), role: 'EMPLOYEE', managerKey: 'emp-v7003',
    },
    {
      empId: 'emp-v7046', code: 'V7046', email: 'hariharashuthan.a@hrms.com',
      firstName: 'Hariharashuthan', lastName: 'A',
      deptId: 'dept-sales', desigId: 'desig-bda',
      joining: new Date('2026-02-01'), role: 'EMPLOYEE', managerKey: 'emp-v7003',
    },
    {
      empId: 'emp-v7049', code: 'V7049', email: 'dhanush.vk@hrms.com',
      firstName: 'Dhanush', lastName: 'V K',
      deptId: 'dept-dm', desigId: 'desig-ve',
      joining: new Date('2026-02-03'), role: 'EMPLOYEE', managerKey: 'emp-v7000',
    },
  ];

  // ── 4. Probation logic ──────────────────────────────────────────────────────
  // Employees who joined > 3 months before today are ACTIVE, others ON_PROBATION
  const now = new Date();
  const threeMonthsAgo = new Date(now);
  threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

  function employeeStatus(joining) {
    return joining <= threeMonthsAgo ? 'ACTIVE' : 'ON_PROBATION';
  }

  // ── 5. Pass 1 — create Users + Employees (no managerId yet) ────────────────
  const empIdMap = {}; // empId key → actual DB employee.id

  for (const e of empDefs) {
    // Upsert user
    const user = await p.user.upsert({
      where: { email: e.email },
      update: { role: e.role, isActive: true },
      create: {
        email:    e.email,
        password: hash,
        role:     e.role,
        isActive: true,
      },
    });

    const status = employeeStatus(e.joining);
    const lastName = e.lastName || e.firstName; // fallback so lastName isn't empty

    const emp = await p.employee.upsert({
      where: { employeeCode: e.code },
      update: {
        firstName:    e.firstName,
        lastName:     lastName,
        email:        e.email,
        departmentId: e.deptId,
        designationId: e.desigId,
        joiningDate:  e.joining,
        status,
        companyId:    cid,
      },
      create: {
        userId:       user.id,
        companyId:    cid,
        employeeCode: e.code,
        firstName:    e.firstName,
        lastName:     lastName,
        email:        e.email,
        departmentId: e.deptId,
        designationId: e.desigId,
        joiningDate:  e.joining,
        status,
      },
    });

    empIdMap[e.empId] = emp.id;
    console.log(`  ✓ ${e.code} ${e.firstName} ${e.lastName} [${status}]`);
  }
  console.log('\n✅ All employees created');

  // ── 6. Pass 2 — wire managerId ──────────────────────────────────────────────
  for (const e of empDefs) {
    if (!e.managerKey) continue;
    const managerId = empIdMap[e.managerKey];
    if (!managerId) { console.warn(`  ⚠ No manager found for key ${e.managerKey}`); continue; }
    await p.employee.update({
      where: { id: empIdMap[e.empId] },
      data:  { managerId },
    });
  }
  console.log('✅ Manager relationships wired');

  // ── 7. Summary ──────────────────────────────────────────────────────────────
  console.log('\n📋 Reporting structure:');
  console.log('  V7000 Clement (CGO)      → V7004 Sri Sashmitha, V7017 Muneeswari, V7032 Gaurav, V7044 Steffi, V7049 Dhanush');
  console.log('  V7003 Gokul (VP Sales)   → V7006 Kumaresan, V7011 Hariharan, V7012 Ramees, V7016 Shabir,');
  console.log('                              V7020 Jothimalar, V7029 Nishanthini, V7030 Midhun,');
  console.log('                              V7040 Pradhap, V7045 Ranjith, V7046 Hariharashuthan');
  console.log('  V7032 Gaurav (LDM)       → V7037 Selvakumar [B2B → LDM as requested]');
  console.log('\n🔑 Default password for all: Employee@1234');
}

main().catch(console.error).finally(() => p.$disconnect());
