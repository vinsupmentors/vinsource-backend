/**
 * One-off repair after the first curriculum import, which overwrote the ORIGINAL modules in place.
 * Separates the two curricula:
 *   V1 = original syllabus  (modules + KRA / feedback / tests / projects stay exactly where they are)
 *   V2 = Vinsup 2.0         (new modules + day-wise material; Batch 19 and later)
 *
 * What it does, per course found in modules.csv:
 *   1. Creates the V2 modules from modules.csv (the new curriculum).
 *   2. Points the day-wise material (CurriculumDay + its files) at those V2 modules.
 *   3. Restores the ORIGINAL title / hours / day-range of the V1 modules from --old=<old-modules.csv>
 *      (columns: course,order,title,hours,dayRange,topics); creates any original module that was deleted.
 *   4. Removes the "[Old] " prefix added earlier.
 * V1 modules that were overwritten and have no row in old-modules.csv are listed so you can supply them.
 *
 *   DRY RUN: npx ts-node src/utils/splitCurriculum.ts --dir=/opt/hrms/curriculum-import-v2 --old=/opt/hrms/old-modules.csv
 *   APPLY:   same command + --execute
 */
import fs from 'fs';
import path from 'path';
import prisma from '../config/database';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const execute = process.argv.includes('--execute');

function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); cell = ''; if (row.some((x) => x.trim())) rows.push(row); row = []; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((x) => x.trim())) rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

async function main() {
  const dir = arg('dir'); const oldFile = arg('old');
  if (!dir || !fs.existsSync(path.join(dir, 'modules.csv'))) { console.error('Give --dir=<import folder containing modules.csv>'); process.exit(1); }
  console.log(execute ? '=== APPLYING ===' : '=== DRY RUN (add --execute to apply) ===');

  const courses = await prisma.academyCourse.findMany({ select: { id: true, name: true } });
  const find = (name: string) => {
    const n = name.trim().toLowerCase();
    const exact = courses.filter((c) => c.name.trim().toLowerCase() === n);
    if (exact.length === 1) return exact[0];
    const loose = courses.filter((c) => c.name.toLowerCase().includes(n) || n.includes(c.name.toLowerCase()));
    return loose.length === 1 ? loose[0] : undefined;
  };
  const toData = (r: Record<string, string>) => ({ title: r.title, hours: r.hours ? Math.round(Number(r.hours)) : null, dayRange: r.dayrange || null, topics: r.topics || null });

  const v2 = readCsv(path.join(dir, 'modules.csv'));
  const old = oldFile && fs.existsSync(oldFile) ? readCsv(oldFile) : [];
  const touched = new Set<string>();

  // 1 + 2. V2 modules, and re-point day-wise material at them
  for (const r of v2) {
    const course = find(r.course || ''); const order = Number(r.order);
    if (!course || !order) { console.log(`! skipped modules.csv row: ${r.course} / ${r.order}`); continue; }
    touched.add(course.id);
    const existing = await prisma.academyModule.findUnique({ where: { courseId_curriculum_order: { courseId: course.id, curriculum: 'V2', order } } });
    console.log(`${course.name}: V2 module ${order} "${r.title}" ${existing ? '(exists)' : '(create)'}`);
    let v2Id = existing?.id;
    if (execute) {
      const m = await prisma.academyModule.upsert({
        where: { courseId_curriculum_order: { courseId: course.id, curriculum: 'V2', order } },
        update: toData(r), create: { courseId: course.id, curriculum: 'V2', order, ...toData(r) },
      });
      v2Id = m.id;
    }
    // day-wise days that the first import attached to the V1 row with this order
    const v1 = await prisma.academyModule.findUnique({ where: { courseId_curriculum_order: { courseId: course.id, curriculum: 'V1', order } }, select: { id: true } });
    if (v1 && v2Id) {
      const days = await prisma.curriculumDay.count({ where: { moduleId: v1.id } });
      const mats = await prisma.courseMaterial.count({ where: { moduleId: v1.id, dayId: { not: null } } });
      if (days || mats) {
        console.log(`    re-point ${days} day(s) and ${mats} day file(s) to the V2 module`);
        if (execute) {
          await prisma.curriculumDay.updateMany({ where: { moduleId: v1.id }, data: { moduleId: v2Id } });
          await prisma.courseMaterial.updateMany({ where: { moduleId: v1.id, dayId: { not: null } }, data: { moduleId: v2Id } });
        }
      }
    }
  }

  // 3. restore the original V1 modules
  const restored = new Set<string>();
  for (const r of old) {
    const course = find(r.course || ''); const order = Number(r.order);
    if (!course || !order) { console.log(`! skipped old-modules row: ${r.course} / ${r.order}`); continue; }
    restored.add(`${course.id}|${order}`);
    const cur = await prisma.academyModule.findUnique({ where: { courseId_curriculum_order: { courseId: course.id, curriculum: 'V1', order } } });
    console.log(`${course.name}: V1 module ${order} → "${r.title}" ${cur ? `(was "${cur.title}")` : '(re-create)'}`);
    if (execute) {
      await prisma.academyModule.upsert({
        where: { courseId_curriculum_order: { courseId: course.id, curriculum: 'V1', order } },
        update: toData(r), create: { courseId: course.id, curriculum: 'V1', order, ...toData(r) },
      });
    }
  }

  // 4. strip "[Old] " and report V1 modules that still carry new-curriculum content
  const v2Titles = new Set(v2.map((r) => `${find(r.course || '')?.id}|${r.order}|${r.title}`));
  for (const courseId of touched) {
    const v1s = await prisma.academyModule.findMany({ where: { courseId, curriculum: 'V1' }, orderBy: { order: 'asc' } });
    for (const m of v1s) {
      if (/^\s*\[Old\]/i.test(m.title) && !restored.has(`${courseId}|${m.order}`)) {
        const t = m.title.replace(/^\s*\[Old\]\s*/i, '').trim();
        console.log(`${courses.find((c) => c.id === courseId)?.name}: V1 module ${m.order} "${m.title.trim()}" → "${t}"`);
        if (execute) await prisma.academyModule.update({ where: { id: m.id }, data: { title: t } });
      }
      if (v2Titles.has(`${courseId}|${m.order}|${m.title}`) && !restored.has(`${courseId}|${m.order}`)) {
        console.log(`  ⚠ ${courses.find((c) => c.id === courseId)?.name}: V1 module ${m.order} still shows the NEW title "${m.title}" — supply its original in old-modules.csv`);
      }
    }
  }
  if (!execute) console.log('\nNothing was changed.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
