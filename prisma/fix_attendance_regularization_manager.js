// node prisma/fix_attendance_regularization_manager.js
//
// Backfill fix: AttendanceRegularization.managerId is captured once, at the
// moment an employee raises the query, from whatever Employee.managerId was
// at that instant. If an employee's "Reporting Manager" was blank/wrong when
// they submitted a request, fixing their manager afterward does NOT update
// the already-submitted request — it stays stuck and never shows up in the
// manager's "Leave Requests > Attendance" inbox.
//
// This script re-syncs every still-PENDING attendance regularization request
// to match the employee's CURRENT manager, so nothing stays orphaned.
const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient();

async function main() {
  const pending = await p.attendanceRegularization.findMany({
    where: { status: 'PENDING' },
    include: { employee: { select: { id: true, firstName: true, lastName: true, employeeCode: true, managerId: true } } },
  });

  if (pending.length === 0) {
    console.log('No PENDING attendance regularization requests found.');
    return;
  }

  let fixed = 0;
  let alreadyOk = 0;
  let stillUnassigned = 0;

  for (const req of pending) {
    const currentManagerId = req.employee.managerId;

    if (!currentManagerId) {
      stillUnassigned++;
      console.log(`  ⚠ ${req.employee.employeeCode} ${req.employee.firstName} ${req.employee.lastName} has NO reporting manager set — assign one in Employees before this request can be approved.`);
      continue;
    }

    if (req.managerId === currentManagerId) {
      alreadyOk++;
      continue;
    }

    await p.attendanceRegularization.update({
      where: { id: req.id },
      data: { managerId: currentManagerId },
    });
    fixed++;
    console.log(`  ✓ ${req.employee.employeeCode} ${req.employee.firstName} ${req.employee.lastName} → request re-routed to current manager`);
  }

  console.log(`\nDone. ${fixed} request(s) re-routed, ${alreadyOk} already correct, ${stillUnassigned} still missing a manager assignment.`);
}

main().catch(console.error).finally(() => p.$disconnect());
