/**
 * Folds the retired "[Old] …" modules into the new curriculum modules and removes them,
 * so each course shows only its new modules.  Everything that pointed at an old module
 * (KRA entries, module tests, module feedback, projects, feedback forms, online tests,
 * course materials) is re-pointed at the mapped new module first — nothing is lost.
 * A row that can't move (it would duplicate one already on the new module) stays, and its
 * old module is kept and reported.
 *
 *   DRY RUN (default):  npx ts-node src/utils/mergeOldModules.ts
 *   APPLY:              npx ts-node src/utils/mergeOldModules.ts --execute
 *
 * Also refreshes each course's totalHours (sum of its modules) and the "— N hours, N days" tail of its description.
 */
import prisma from '../config/database';

const execute = process.argv.includes('--execute');

// old module title (without the "[Old] " prefix) -> NEW module order in the same course
const MAP: Record<string, Record<string, number>> = {
  'MERN Stack': {
    'React.js': 3,
    'Node.js & Express.js': 3,
    'MongoDB & Mongoose': 3,
    'Full Stack Integration, Deployment': 3,
  },
  'Digital Marketing': {
    'Google My Business': 2,                                   // SEO & Website Optimization
    'Search Engine Marketing (SEM) & Google Ads': 8,           // SEO Tools & Google Ads
    'Web Analytics, Performance Tracking & AI Tools': 11,      // Analytics, Tracking & Automation
    'Capstone Project & Career Readiness': 12,                 // Career Readiness & ORM
  },
};

const norm = (s: string) => s.replace(/^\s*\[Old\]\s*/i, '').trim();

async function repoint(model: string, oldId: string, newId: string): Promise<{ moved: number; stuck: number }> {
  const db = prisma as any;
  const rows: { id: string }[] = await db[model].findMany({ where: { moduleId: oldId }, select: { id: true } });
  let moved = 0, stuck = 0;
  for (const r of rows) {
    try { await db[model].update({ where: { id: r.id }, data: { moduleId: newId } }); moved++; }
    catch { stuck++; } // unique clash with a row already on the new module
  }
  return { moved, stuck };
}

async function main() {
  console.log(execute ? '=== APPLYING ===' : '=== DRY RUN (add --execute to apply) ===');
  const MODELS = ['kRAEntry', 'moduleTest', 'moduleFeedback', 'project', 'feedbackForm', 'onlineTest', 'courseMaterial'];

  for (const [courseName, rules] of Object.entries(MAP)) {
    const course = await prisma.academyCourse.findFirst({ where: { name: courseName }, select: { id: true } });
    if (!course) { console.log(`! course "${courseName}" not found`); continue; }
    const mods = await prisma.academyModule.findMany({ where: { courseId: course.id } });
    const olds = mods.filter((m) => /^\s*\[Old\]/i.test(m.title));
    for (const old of olds) {
      const targetOrder = rules[norm(old.title)];
      const target = targetOrder ? mods.find((m) => m.order === targetOrder && !/^\s*\[Old\]/i.test(m.title)) : undefined;
      if (!target) { console.log(`- ${courseName}: no mapping for "${old.title.trim()}" — left alone`); continue; }
      console.log(`${courseName}: "${old.title.trim()}"  →  module ${target.order} "${target.title}"`);
      let stuckTotal = 0;
      for (const model of MODELS) {
        const db = prisma as any;
        const n: number = await db[model].count({ where: { moduleId: old.id } });
        if (!n) continue;
        if (!execute) { console.log(`    would move ${n} ${model}`); continue; }
        const { moved, stuck } = await repoint(model, old.id, target.id);
        stuckTotal += stuck;
        console.log(`    moved ${moved} ${model}${stuck ? `, ${stuck} could not move (duplicate)` : ''}`);
      }
      if (!execute) { console.log('    would delete the old module'); continue; }
      if (stuckTotal) { console.log('    KEPT (some rows could not move)'); continue; }
      await prisma.academyModule.delete({ where: { id: old.id } });
      console.log('    deleted old module');
    }
  }

  // refresh course totals / description tail
  for (const c of await prisma.academyCourse.findMany({ select: { id: true, name: true, description: true, totalHours: true, modules: { select: { hours: true, title: true } } } })) {
    const live = c.modules.filter((m) => !/^\s*\[Old\]/i.test(m.title));
    if (!['MERN Stack', 'Digital Marketing', 'Data Analytics', 'UX UI & Graphic Design'].includes(c.name) || !live.length) continue;
    const hours = live.reduce((s, m) => s + (m.hours || 0), 0);
    const desc = c.description ? c.description.replace(/—\s*[\d.]+\s*hours?,\s*\d+\s*days\.?/i, `— ${hours} hours, 50 days.`) : c.description;
    console.log(`${c.name}: totalHours ${c.totalHours} → ${hours}${desc !== c.description ? '; description tail updated' : ''}`);
    if (execute) await prisma.academyCourse.update({ where: { id: c.id }, data: { totalHours: hours, description: desc } });
  }
  if (!execute) console.log('\nNothing was changed.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
