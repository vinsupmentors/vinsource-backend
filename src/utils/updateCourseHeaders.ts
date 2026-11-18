/**
 * Sets each course's headline hours + "— N hours, N days" text to the Vinsup 2.0 figures
 * (from the "Vinsup 2.0 – Course Plans" workbook). Display fields only — modules, KRA and feedback are not touched.
 *
 *   DRY RUN: npx ts-node src/utils/updateCourseHeaders.ts
 *   APPLY:   npx ts-node src/utils/updateCourseHeaders.ts --execute
 */
import prisma from '../config/database';

const execute = process.argv.includes('--execute');
const TARGET: Record<string, { hours: number; label: string }> = {
  'MERN Stack': { hours: 125, label: '125' },
  'Digital Marketing': { hours: 116, label: '115.5' }, // totalHours is a whole number; the text keeps 115.5
  'Data Analytics': { hours: 100, label: '100' },
  'UX UI & Graphic Design': { hours: 100, label: '100' },
};

async function main() {
  console.log(execute ? '=== APPLYING ===' : '=== DRY RUN (add --execute to apply) ===');
  const rows = await prisma.academyCourse.findMany({ where: { name: { in: Object.keys(TARGET) } }, select: { id: true, name: true, description: true, totalHours: true } });
  for (const c of rows) {
    const t = TARGET[c.name];
    const tail = `— ${t.label} hours, 50 days.`;
    const re = /—\s*[\d.]+\s*hours?,\s*\d+\s*days\.?/i;
    const base = c.description || '';
    const desc = re.test(base) ? base.replace(re, tail) : (base ? `${base} ${tail}` : tail.replace('— ', ''));
    console.log(`${c.name}: ${c.totalHours}h → ${t.hours}h | "${desc}"`);
    if (execute) await prisma.academyCourse.update({ where: { id: c.id }, data: { totalHours: t.hours, description: desc } });
  }
  if (!execute) console.log('\nNothing was changed.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
