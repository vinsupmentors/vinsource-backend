/**
 * One-off: applies the Sept 2026 pricing sheet Gaurav sent —
 *
 *   Data Analytics / Digital Marketing / UX UI / MERN Stack:
 *     JRP: base 50,000 (final 35,000 via FLAT15K coupon)
 *     IOP: base 65,000 (final 50,000 via FLAT15K coupon)
 *   Dataverse:
 *     JRP: base 65,000 (final 50,000 via FLAT15K coupon)
 *     IOP: base 80,000 (final 65,000 via FLAT15K coupon), EMI up to 6 months
 *          (every other course's IOP stays on the global 5-month limit)
 *   No spot payments (handled separately — SPOT removed from the Admission
 *   form; this script only touches fees/coupon/EMI limits).
 *
 * Design notes (see conversation with Gaurav, 2026-09-25):
 *  - CourseTrackFee is append-only (never edit in place), so this ADDS new
 *    rows rather than touching existing ones. The engine always picks the
 *    latest effectiveDate <= today, so these become active immediately.
 *  - The flat ₹15,000 gap in every row becomes a single reusable coupon
 *    (FLAT15K) rather than baking the discount into baseFee, per Gaurav's
 *    choice — sales reps apply it at admission time like any other coupon.
 *  - Dataverse's IOP 6-month EMI cap is set via AcademyCourse.emiMonthLimits
 *    (new per-course override field), leaving the global config (IOP: 5)
 *    untouched for every other course.
 *
 * SAFE BY DEFAULT: this only PRINTS what it would do. Nothing is written
 * until you re-run it with --apply. Course names are matched loosely
 * (case-insensitive substring) since we don't have a live read on exact
 * names as stored — review the dry-run matches carefully before applying.
 *
 * Run from backend/:
 *   npx ts-node src/utils/updateCoursePricing2026.ts            (dry run)
 *   npx ts-node src/utils/updateCoursePricing2026.ts --apply    (writes)
 */
import prisma from '../config/database';

const APPLY = process.argv.includes('--apply');

// name-match keywords -> fee config. Loose/case-insensitive `contains` match
// against AcademyCourse.name so small naming differences ("UX/UI" vs "UX UI")
// still resolve — but if a keyword matches 0 or >1 course, we skip it and
// tell you rather than guessing.
const SHARED_FEE = { JRP: 50000, IOP: 65000 };
const COURSES: { keyword: string; fees: Record<string, number>; emiMonthLimits?: Record<string, number> }[] = [
  { keyword: 'data analytics', fees: SHARED_FEE },
  { keyword: 'digital marketing', fees: SHARED_FEE },
  { keyword: 'ux', fees: SHARED_FEE }, // matches "UX UI" / "UX/UI" / "UI UX"
  { keyword: 'mern', fees: SHARED_FEE },
  { keyword: 'dataverse', fees: { JRP: 65000, IOP: 80000 }, emiMonthLimits: { IOP: 6 } },
];

const FLAT15K = {
  code: 'FLAT15K',
  name: 'Flat ₹15,000 off (Sept 2026 pricing)',
  discountType: 'FIXED' as const,
  discountValue: 15000,
  validFrom: new Date('2026-09-25'),
  validUntil: new Date('2099-12-31'),
};

async function main() {
  console.log(APPLY ? '=== APPLYING CHANGES ===' : '=== DRY RUN (pass --apply to write) ===');

  const allCourses = await prisma.academyCourse.findMany({ where: { isActive: true }, select: { id: true, name: true } });

  for (const spec of COURSES) {
    const matches = allCourses.filter((c) => c.name.toLowerCase().includes(spec.keyword));
    if (matches.length !== 1) {
      console.log(`\n[SKIP] "${spec.keyword}" matched ${matches.length} course(s): ${matches.map((m) => m.name).join(', ') || '(none)'} — fix the keyword or course name and re-run.`);
      continue;
    }
    const course = matches[0];
    console.log(`\n[${course.name}] (id ${course.id})`);
    for (const [track, baseFee] of Object.entries(spec.fees)) {
      console.log(`  -> new CourseTrackFee: track=${track} baseFee=₹${baseFee}`);
      if (APPLY) {
        await prisma.courseTrackFee.create({ data: { courseId: course.id, track: track as any, baseFee } });
      }
    }
    if (spec.emiMonthLimits) {
      console.log(`  -> emiMonthLimits override: ${JSON.stringify(spec.emiMonthLimits)}`);
      if (APPLY) {
        await prisma.academyCourse.update({ where: { id: course.id }, data: { emiMonthLimits: spec.emiMonthLimits } });
      }
    }
  }

  console.log(`\n[Coupon] ${FLAT15K.code} — flat ₹${FLAT15K.discountValue} off, any course/track`);
  const existing = await prisma.coupon.findUnique({ where: { code: FLAT15K.code } });
  if (existing) {
    console.log('  -> already exists, skipping (edit it by hand in Admission > Coupons if the amount needs to change).');
  } else {
    console.log('  -> will create.');
    if (APPLY) {
      await prisma.coupon.create({
        data: {
          code: FLAT15K.code,
          name: FLAT15K.name,
          discountType: FLAT15K.discountType,
          discountValue: FLAT15K.discountValue,
          validFrom: FLAT15K.validFrom,
          validUntil: FLAT15K.validUntil,
          status: 'ACTIVE',
        },
      });
    }
  }

  console.log(APPLY ? '\nDone — changes written.' : '\nDry run complete — re-run with --apply to write these changes.');
}

main()
  .catch((err) => { console.error(err); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
