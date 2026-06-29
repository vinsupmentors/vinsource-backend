import prisma from '../config/database';
import { hashPassword } from './helpers';

async function seed() {
  console.log('🌱 Seeding database...');

  // Company
  const company = await prisma.company.upsert({
    where: { code: 'DEMO' },
    update: {},
    create: {
      name: 'Demo Corporation Ltd',
      code: 'DEMO',
      email: 'admin@demo.com',
      phone: '+91 9876543210',
      address: '123 Business Park, Mumbai',
    },
  });

  // Branch
  const branch = await prisma.branch.upsert({
    where: { id: 'branch-hq' },
    update: {},
    create: {
      id: 'branch-hq',
      companyId: company.id,
      name: 'Headquarters',
      code: 'HQ',
      city: 'Mumbai',
      state: 'Maharashtra',
      country: 'India',
    },
  });

  // Departments
  const depts = await Promise.all([
    prisma.department.upsert({ where: { id: 'dept-eng' }, update: {}, create: { id: 'dept-eng', companyId: company.id, name: 'Engineering', code: 'ENG' } }),
    prisma.department.upsert({ where: { id: 'dept-hr' }, update: {}, create: { id: 'dept-hr', companyId: company.id, name: 'Human Resources', code: 'HR' } }),
    prisma.department.upsert({ where: { id: 'dept-fin' }, update: {}, create: { id: 'dept-fin', companyId: company.id, name: 'Finance', code: 'FIN' } }),
  ]);

  // Designations
  const designations = await Promise.all([
    prisma.designation.upsert({ where: { id: 'desig-admin' }, update: {}, create: { id: 'desig-admin', name: 'Administrator', code: 'ADMIN', level: 10 } }),
    prisma.designation.upsert({ where: { id: 'desig-hr' }, update: {}, create: { id: 'desig-hr', name: 'HR Manager', code: 'HRM', level: 5 } }),
    prisma.designation.upsert({ where: { id: 'desig-mgr' }, update: {}, create: { id: 'desig-mgr', name: 'Engineering Manager', code: 'EM', level: 6 } }),
    prisma.designation.upsert({ where: { id: 'desig-swe' }, update: {}, create: { id: 'desig-swe', name: 'Software Engineer', code: 'SWE', level: 3 } }),
  ]);

  const adminPwd = await hashPassword('Admin@123');
  const hrPwd    = await hashPassword('HR@1234');
  const mgrPwd   = await hashPassword('Mgr@1234');
  const empPwd   = await hashPassword('Emp@1234');

  // Super Admin
  const adminUser = await prisma.user.upsert({
    where: { email: 'superadmin@hrms.com' },
    update: { password: adminPwd },
    create: { email: 'superadmin@hrms.com', password: adminPwd, role: 'SUPER_ADMIN' },
  });

  await prisma.employee.upsert({
    where: { userId: adminUser.id },
    update: {},
    create: {
      userId: adminUser.id, companyId: company.id, branchId: branch.id,
      departmentId: depts[0].id, designationId: designations[0].id,
      employeeCode: 'EMP00001', firstName: 'Super', lastName: 'Admin',
      email: 'superadmin@hrms.com', joiningDate: new Date('2020-01-01'), status: 'ACTIVE',
    },
  });

  // HR
  const hrUser = await prisma.user.upsert({
    where: { email: 'hr@hrms.com' },
    update: { password: hrPwd },
    create: { email: 'hr@hrms.com', password: hrPwd, role: 'HR' },
  });

  await prisma.employee.upsert({
    where: { userId: hrUser.id },
    update: {},
    create: {
      userId: hrUser.id, companyId: company.id, branchId: branch.id,
      departmentId: depts[1].id, designationId: designations[1].id,
      employeeCode: 'EMP00002', firstName: 'Priya', lastName: 'Sharma',
      email: 'hr@hrms.com', joiningDate: new Date('2021-03-15'), status: 'ACTIVE',
    },
  });

  // Manager
  const mgrUser = await prisma.user.upsert({
    where: { email: 'manager@hrms.com' },
    update: { password: mgrPwd },
    create: { email: 'manager@hrms.com', password: mgrPwd, role: 'MANAGER' },
  });

  const mgrEmp = await prisma.employee.upsert({
    where: { userId: mgrUser.id },
    update: {},
    create: {
      userId: mgrUser.id, companyId: company.id, branchId: branch.id,
      departmentId: depts[0].id, designationId: designations[2].id,
      employeeCode: 'EMP00003', firstName: 'Rahul', lastName: 'Kumar',
      email: 'manager@hrms.com', joiningDate: new Date('2019-06-01'), status: 'ACTIVE',
    },
  });

  // Employee
  const empUser = await prisma.user.upsert({
    where: { email: 'employee@hrms.com' },
    update: { password: empPwd },
    create: { email: 'employee@hrms.com', password: empPwd, role: 'EMPLOYEE' },
  });

  await prisma.employee.upsert({
    where: { userId: empUser.id },
    update: {},
    create: {
      userId: empUser.id, companyId: company.id, branchId: branch.id,
      departmentId: depts[0].id, designationId: designations[3].id,
      managerId: mgrEmp.id, employeeCode: 'EMP00004',
      firstName: 'Ankit', lastName: 'Verma',
      email: 'employee@hrms.com', joiningDate: new Date('2023-01-10'), status: 'ACTIVE',
    },
  });

  // Leave types (Sick, Earned, Paternity inactive per policy)
  const leaveTypes = [
    { type: 'CASUAL' as const,    name: 'Casual Leave',    maxDaysPerYear: 12,  isPaid: true,  isActive: true  },
    { type: 'MATERNITY' as const, name: 'Maternity Leave', maxDaysPerYear: 180, isPaid: true,  isActive: true  },
    { type: 'LOSS_OF_PAY' as const, name: 'Loss of Pay',  maxDaysPerYear: 365, isPaid: false, isActive: true  },
    { type: 'SICK' as const,      name: 'Sick Leave',      maxDaysPerYear: 10,  isPaid: true,  isActive: false },
    { type: 'EARNED' as const,    name: 'Earned Leave',    maxDaysPerYear: 15,  isPaid: true,  isActive: false, carryForward: true, encashable: true },
    { type: 'PATERNITY' as const, name: 'Paternity Leave', maxDaysPerYear: 15,  isPaid: true,  isActive: false },
  ];

  await Promise.all(
    leaveTypes.map((lt) =>
      prisma.companyLeaveType.upsert({
        where: { id: `lt-${lt.type.toLowerCase()}` },
        update: {},
        create: { id: `lt-${lt.type.toLowerCase()}`, companyId: company.id, ...lt },
      })
    )
  );

  console.log('✅ Seed complete!');
  console.log('');
  console.log('Demo credentials:');
  console.log('  Super Admin : superadmin@hrms.com / Admin@123');
  console.log('  HR          : hr@hrms.com         / HR@1234');
  console.log('  Manager     : manager@hrms.com    / Mgr@1234');
  console.log('  Employee    : employee@hrms.com   / Emp@1234');
}

seed()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
