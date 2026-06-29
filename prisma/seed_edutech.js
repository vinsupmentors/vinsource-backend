// node prisma/seed_edutech.js
// Seeds Edutech-specific departments and designations for the demo company
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  // Find the demo company
  const company = await p.company.findFirst({ where: { code: 'DEMO' } });
  if (!company) { console.error('Company not found — run seed first'); process.exit(1); }
  const cid = company.id;

  // ── Departments ──────────────────────────────────────────────────────────────
  const deptDefs = [
    { id: 'dept-sales',   name: 'Sales',             code: 'SALES' },
    { id: 'dept-prod',    name: 'Production',         code: 'PROD' },
    { id: 'dept-dm',      name: 'Digital Marketing',  code: 'DM' },
    { id: 'dept-place',   name: 'Placements',         code: 'PLACE' },
    { id: 'dept-fin',     name: 'Finance',            code: 'FIN' },
    { id: 'dept-admin',   name: 'Admin',              code: 'ADMIN' },
    { id: 'dept-b2b',     name: 'B2B',               code: 'B2B' },
  ];

  for (const d of deptDefs) {
    await p.department.upsert({
      where: { id: d.id },
      update: { name: d.name, code: d.code, isActive: true },
      create: { id: d.id, companyId: cid, name: d.name, code: d.code },
    });
  }
  console.log(`✅ ${deptDefs.length} departments upserted`);

  // Deactivate old demo dept
  await p.department.updateMany({
    where: { companyId: cid, id: { in: ['dept-eng', 'dept-hr'] } },
    data: { isActive: false },
  });

  // ── Designations ─────────────────────────────────────────────────────────────
  // Level scale: 10=top, 8=senior manager, 6=manager, 4=asst mgr, 3=senior IC, 2=IC, 1=junior
  const desigDefs = [
    // Manager-level (can be set as reporting managers)
    { id: 'desig-cgo',     name: 'CGO',                      code: 'CGO',   level: 9, description: 'Chief Growth Officer — leads Digital Marketing & Placements' },
    { id: 'desig-vpsales', name: 'VP Sales',                 code: 'VPS',   level: 9, description: 'Vice President Sales — leads Sales team' },
    { id: 'desig-ldm',     name: 'Learning Delivery Manager', code: 'LDM',  level: 7, description: 'Leads Production / Skill Mentors' },
    { id: 'desig-amg',     name: 'Asst Manager - General',   code: 'AMG',   level: 6, description: 'Leads Admin team' },
    { id: 'desig-sb2b',    name: 'Senior B2B Manager',       code: 'SB2B',  level: 7, description: 'Leads B2B team' },
    // Individual contributors
    { id: 'desig-se',      name: 'Sales Executive',          code: 'SE',    level: 2 },
    { id: 'desig-sse',     name: 'Senior Sales Executive',   code: 'SSE',   level: 3 },
    { id: 'desig-dme',     name: 'Digital Marketing Executive', code: 'DME', level: 2 },
    { id: 'desig-seo',     name: 'SEO Specialist',           code: 'SEO',   level: 3 },
    { id: 'desig-po',      name: 'Placement Officer',        code: 'PO',    level: 2 },
    { id: 'desig-pc',      name: 'Placement Coordinator',    code: 'PC',    level: 3 },
    { id: 'desig-sm',      name: 'Skill Mentor',             code: 'SMT',   level: 2, description: 'Production team — reports to LDM' },
    { id: 'desig-fe',      name: 'Finance Executive',        code: 'FE',    level: 2 },
    { id: 'desig-acct',    name: 'Accountant',               code: 'ACCT',  level: 3 },
    { id: 'desig-ae',      name: 'Admin Executive',          code: 'AE',    level: 2, description: 'Reports to Asst Manager - General' },
    { id: 'desig-cash',    name: 'Cashier',                  code: 'CASH',  level: 1, description: 'Reports to Asst Manager - General' },
    { id: 'desig-recep',   name: 'Receptionist',             code: 'RCPT',  level: 1, description: 'Reports to Asst Manager - General' },
    { id: 'desig-b2be',    name: 'B2B Executive',            code: 'B2BE',  level: 2 },
  ];

  for (const d of desigDefs) {
    await p.designation.upsert({
      where: { id: d.id },
      update: { name: d.name, code: d.code, level: d.level, description: d.description || null, isActive: true },
      create: { id: d.id, name: d.name, code: d.code, level: d.level, description: d.description || null },
    });
  }
  console.log(`✅ ${desigDefs.length} designations upserted`);

  // Deactivate old generic designations
  await p.designation.updateMany({
    where: { id: { in: ['desig-admin', 'desig-hr', 'desig-mgr', 'desig-swe'] } },
    data: { isActive: false },
  });

  // ── Update seed employees to reflect actual structure ─────────────────────────
  // VP Sales → Sales dept
  const vpSalesUser = await p.user.findUnique({ where: { email: 'manager@hrms.com' } });
  if (vpSalesUser) {
    await p.employee.updateMany({
      where: { userId: vpSalesUser.id },
      data: { departmentId: 'dept-sales', designationId: 'desig-vpsales' },
    });
    console.log('✅ manager@hrms.com → VP Sales / Sales');
  }

  // HR → Admin dept
  const hrUser = await p.user.findUnique({ where: { email: 'hr@hrms.com' } });
  if (hrUser) {
    await p.employee.updateMany({
      where: { userId: hrUser.id },
      data: { departmentId: 'dept-admin', designationId: 'desig-amg' },
    });
    console.log('✅ hr@hrms.com → Asst Manager - General / Admin');
  }

  // Employee → Sales dept, reports to VP Sales
  const empUser = await p.user.findUnique({ where: { email: 'employee@hrms.com' } });
  const mgrEmp = vpSalesUser ? await p.employee.findUnique({ where: { userId: vpSalesUser.id } }) : null;
  if (empUser && mgrEmp) {
    await p.employee.updateMany({
      where: { userId: empUser.id },
      data: { departmentId: 'dept-sales', designationId: 'desig-se', managerId: mgrEmp.id },
    });
    console.log('✅ employee@hrms.com → Sales Executive / Sales → reports to VP Sales');
  }

  console.log('\n📋 Reporting structure:');
  console.log('  VP Sales        → manages: Sales');
  console.log('  CGO             → manages: Digital Marketing, Placements');
  console.log('  LDM             → manages: Production (Skill Mentors)');
  console.log('  Asst Mgr General → manages: Admin (Admin Exec, Cashier, Receptionist)');
  console.log('  Senior B2B Mgr  → manages: B2B');
  console.log('\nWhen adding employees, set their Reporting Manager to assign them to a team.');
}

main().catch(console.error).finally(() => p.$disconnect());
