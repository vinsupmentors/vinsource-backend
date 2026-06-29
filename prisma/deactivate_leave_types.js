// Run: node prisma/deactivate_leave_types.js
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();
async function main() {
  // Deactivate Earned, Paternity, Sick leave
  const res = await p.companyLeaveType.updateMany({
    where: { type: { in: ['EARNED', 'PATERNITY', 'SICK'] } },
    data: { isActive: false },
  });
  console.log(`Deactivated ${res.count} leave types`);
}
main().catch(console.error).finally(() => p.$disconnect());
