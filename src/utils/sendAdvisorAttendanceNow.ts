import { salesAdvisorReportService } from '../services/salesAdvisorReport.service';
import prisma from '../config/database';

// One-off manual run of the daily advisor attendance email (same as the 8:30 PM job).
salesAdvisorReportService.sendCumulativeAttendance()
  .then((r) => { console.log(r); })
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
