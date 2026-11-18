/**
 * Bulk-import the corrected curriculum and day-wise study material.
 *
 *   DRY RUN (default — prints what would happen, changes nothing):
 *     npx ts-node src/utils/importCurriculum.ts --dir=/opt/hrms/curriculum
 *
 *   REALLY IMPORT:
 *     npx ts-node src/utils/importCurriculum.ts --dir=/opt/hrms/curriculum --execute
 *
 * Folder layout (course names must match the portal's course names, case-insensitive):
 *
 *   <dir>/
 *     modules.csv            (optional)  columns: course,order,title,hours,dayRange,topics
 *     days.csv               (required)  columns: course,day,title,topics,module   (module = the module's order number; optional)
 *     <Course name>/
 *       Day 1/  (or Day-01, Day_1, D1 … — only the number matters)
 *         any files: .pdf .doc .docx .ppt .pptx .xls .xlsx .csv .txt .md .jpg .jpeg .png .webp .zip
 *         links.txt  (optional) one link per line, either "https://…" or "Title | https://…"  → added as LINK/VIDEO materials
 *
 * Safe to re-run: modules and days are updated in place; a file/link already on a day (same title) is skipped.
 * Nothing is released to students by this — the trainer releases each day from My Training.
 */
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import prisma from '../config/database';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const execute = process.argv.includes('--execute');
const dir = arg('dir');
const ALLOWED = ['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.csv', '.txt', '.md', '.jpg', '.jpeg', '.png', '.webp', '.zip'];
const UPLOADS = path.join(process.cwd(), 'uploads', 'materials');

/** Minimal CSV reader: quotes, escaped quotes, commas/newlines inside quotes, BOM. Returns rows keyed by the header. */
function readCsv(file: string): Record<string, string>[] {
  const text = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = []; let cell = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); cell = '';
      if (row.some((x) => x.trim() !== '')) rows.push(row);
      row = [];
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); if (row.some((x) => x.trim() !== '')) rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase());
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])));
}

const dayNumberOf = (folder: string): number | null => { const m = folder.match(/\d+/); return m ? Number(m[0]) : null; };
const prettyTitle = (file: string) => path.basename(file, path.extname(file)).replace(/[_]+/g, ' ').trim();

async function main() {
  if (!dir || !fs.existsSync(dir)) { console.error('Give the import folder:  --dir=/path/to/curriculum'); process.exit(1); }
  const daysFile = path.join(dir, 'days.csv');
  if (!fs.existsSync(daysFile)) { console.error(`days.csv not found in ${dir}`); process.exit(1); }

  const courses = await prisma.academyCourse.findMany({ select: { id: true, name: true } });
  const courseByName = new Map(courses.map((c) => [c.name.trim().toLowerCase(), c]));
  const findCourse = (name: string) => courseByName.get(name.trim().toLowerCase());
  const problems: string[] = [];
  let modUpserts = 0, dayUpserts = 0, filesAdded = 0, filesSkipped = 0, linksAdded = 0;

  // 1. Modules (corrected curriculum)
  const modFile = path.join(dir, 'modules.csv');
  if (fs.existsSync(modFile)) {
    for (const r of readCsv(modFile)) {
      const course = findCourse(r.course || '');
      const order = Number(r.order);
      if (!course) { problems.push(`modules.csv: unknown course "${r.course}"`); continue; }
      if (!Number.isInteger(order) || order < 1 || !r.title) { problems.push(`modules.csv: bad row for ${r.course} (order "${r.order}", title "${r.title}")`); continue; }
      modUpserts++;
      if (execute) {
        const data = { title: r.title, hours: r.hours ? Number(r.hours) : null, dayRange: r.dayrange || null, topics: r.topics || null };
        // eslint-disable-next-line no-await-in-loop
        await prisma.academyModule.upsert({ where: { courseId_order: { courseId: course.id, order } }, update: data, create: { courseId: course.id, order, ...data } });
      }
    }
  }

  // 2. Days + their files
  for (const r of readCsv(daysFile)) {
    const course = findCourse(r.course || '');
    const dayNo = Number(r.day);
    if (!course) { problems.push(`days.csv: unknown course "${r.course}"`); continue; }
    if (!Number.isInteger(dayNo) || dayNo < 1 || !r.title) { problems.push(`days.csv: bad row for ${r.course} (day "${r.day}", title "${r.title}")`); continue; }

    let moduleId: string | null = null;
    if (r.module) {
      // eslint-disable-next-line no-await-in-loop
      const mod = await prisma.academyModule.findUnique({ where: { courseId_order: { courseId: course.id, order: Number(r.module) } }, select: { id: true } });
      if (mod) moduleId = mod.id; else if (execute || !fs.existsSync(modFile)) problems.push(`days.csv: ${course.name} day ${dayNo} points to module ${r.module}, which doesn't exist`);
    }
    dayUpserts++;
    let dayId: string | null = null;
    if (execute) {
      // eslint-disable-next-line no-await-in-loop
      const d = await prisma.curriculumDay.upsert({
        where: { courseId_dayNumber: { courseId: course.id, dayNumber: dayNo } },
        update: { title: r.title, topics: r.topics || null, moduleId },
        create: { courseId: course.id, dayNumber: dayNo, title: r.title, topics: r.topics || null, moduleId },
      });
      dayId = d.id;
    } else {
      // eslint-disable-next-line no-await-in-loop
      dayId = (await prisma.curriculumDay.findUnique({ where: { courseId_dayNumber: { courseId: course.id, dayNumber: dayNo } }, select: { id: true } }))?.id ?? null;
    }

    // Files for this day: <dir>/<Course name>/<folder whose number == day>/
    const courseDir = fs.readdirSync(dir, { withFileTypes: true }).find((e) => e.isDirectory() && e.name.trim().toLowerCase() === course.name.trim().toLowerCase());
    if (!courseDir) continue;
    const dayDir = fs.readdirSync(path.join(dir, courseDir.name), { withFileTypes: true }).find((e) => e.isDirectory() && dayNumberOf(e.name) === dayNo);
    if (!dayDir) continue;
    const full = path.join(dir, courseDir.name, dayDir.name);
    const existing = dayId ? await prisma.courseMaterial.findMany({ where: { dayId }, select: { title: true } }) : [];
    const have = new Set(existing.map((m) => m.title));

    for (const f of fs.readdirSync(full, { withFileTypes: true })) {
      if (!f.isFile()) continue;
      const ext = path.extname(f.name).toLowerCase();
      if (f.name.toLowerCase() === 'links.txt') {
        for (const line of fs.readFileSync(path.join(full, f.name), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
          const [a, b] = line.includes('|') ? line.split('|').map((x) => x.trim()) : [line, line];
          const url = /^https?:\/\//i.test(b) ? b : /^https?:\/\//i.test(a) ? a : '';
          if (!url) { problems.push(`${course.name} day ${dayNo}: links.txt line not a link: "${line.slice(0, 60)}"`); continue; }
          const title = b === url && a !== url ? a : url.replace(/^https?:\/\/(www\.)?/i, '').slice(0, 80);
          if (have.has(title)) { filesSkipped++; continue; }
          linksAdded++;
          if (execute && dayId) {
            // eslint-disable-next-line no-await-in-loop
            await prisma.courseMaterial.create({ data: { courseId: course.id, moduleId, dayId, title, type: /youtu|vimeo|\.mp4/i.test(url) ? 'VIDEO' : 'LINK', url } });
            have.add(title);
          }
        }
        continue;
      }
      if (!ALLOWED.includes(ext)) { problems.push(`${course.name} day ${dayNo}: skipped "${f.name}" (type ${ext || 'none'} not allowed)`); continue; }
      const title = prettyTitle(f.name);
      if (have.has(title)) { filesSkipped++; continue; }
      filesAdded++;
      if (execute && dayId) {
        const stored = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}${ext}`;
        fs.mkdirSync(UPLOADS, { recursive: true });
        fs.copyFileSync(path.join(full, f.name), path.join(UPLOADS, stored));
        // eslint-disable-next-line no-await-in-loop
        await prisma.courseMaterial.create({ data: { courseId: course.id, moduleId, dayId, title, type: 'FILE', url: `/uploads/materials/${stored}` } });
        have.add(title);
      }
    }
  }

  console.log(`${execute ? 'IMPORTED' : 'DRY RUN — would import'}: ${modUpserts} module(s), ${dayUpserts} day(s), ${filesAdded} file(s), ${linksAdded} link(s); ${filesSkipped} already present.`);
  if (problems.length) { console.log(`\n${problems.length} thing(s) to check:`); problems.slice(0, 60).forEach((p) => console.log('  - ' + p)); }
  if (!execute) console.log('\nNothing was changed. Re-run with --execute to import. Days are NOT released to students — trainers release them from My Training.');
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
