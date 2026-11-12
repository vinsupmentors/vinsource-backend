/**
 * Inspect recording files in R2 that have NO matching database row ("orphans"), and optionally re-link the good ones.
 *
 *   REPORT (read-only):
 *     npx ts-node src/utils/inspectOrphanRecordings.ts
 *
 *   See what re-linking WOULD do (still read-only):
 *     npx ts-node src/utils/inspectOrphanRecordings.ts --relink
 *
 *   Re-link for real (creates READY rows so the recordings play; deletes nothing in R2):
 *     npx ts-node src/utils/inspectOrphanRecordings.ts --relink --execute
 *
 * File keys look like recordings/<liveClassId>/<timestamp>.mp4, so every file can be traced to its class.
 * Categories:
 *   RECOVERABLE  – class exists and has NO playable (READY) recording  → safe to re-link
 *   EXTRA        – class already has a READY recording                 → probably a duplicate/rejoin; review before deleting
 *   TINY         – under 20 MB                                         → almost certainly a test / aborted recording
 *   NO CLASS     – the class no longer exists                          → safe to delete
 */
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';
import prisma from '../config/database';
import { config } from '../config/env';

const relink = process.argv.includes('--relink');
const execute = process.argv.includes('--execute');
const TINY = 20 * 1024 * 1024;
const mb = (b: number) => `${(b / 1024 / 1024).toFixed(0)} MB`;
const gb = (b: number) => (b / 1024 / 1024 / 1024).toFixed(2);

async function main() {
  const bucket = config.R2_RECORDINGS_BUCKET;
  if (!bucket || !config.R2_ENDPOINT) { console.error('R2 is not configured in .env'); process.exit(1); }
  const s3 = new S3Client({
    region: 'auto',
    endpoint: config.R2_ENDPOINT,
    credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY },
  });

  const files: { key: string; size: number; modified: Date }[] = [];
  let token: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'recordings/', ContinuationToken: token }));
    for (const o of r.Contents || []) if (o.Key && o.LastModified) files.push({ key: o.Key, size: o.Size || 0, modified: o.LastModified });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);

  const rows = await prisma.liveClassRecording.findMany({ select: { id: true, liveClassId: true, storageKey: true, status: true } });
  const linked = new Set(rows.map((r) => r.storageKey).filter(Boolean) as string[]);
  const orphans = files.filter((f) => !linked.has(f.key));

  const classIds = Array.from(new Set(orphans.map((f) => f.key.split('/')[1]).filter(Boolean)));
  const classes = await prisma.liveClass.findMany({
    where: { id: { in: classIds } },
    select: { id: true, classCode: true, title: true, scheduledDate: true, status: true },
  });
  const classMap = new Map(classes.map((c) => [c.id, c]));

  type Cat = 'RECOVERABLE' | 'EXTRA' | 'TINY' | 'NO CLASS';
  const result = orphans.map((f) => {
    const classId = f.key.split('/')[1];
    const cls = classMap.get(classId);
    const ready = rows.filter((r) => r.liveClassId === classId && r.status === 'READY').length;
    const failed = rows.filter((r) => r.liveClassId === classId && r.status === 'FAILED').length;
    let cat: Cat;
    if (!cls) cat = 'NO CLASS';
    else if (f.size < TINY) cat = 'TINY';
    else if (ready > 0) cat = 'EXTRA';
    else cat = 'RECOVERABLE';
    return { ...f, classId, cls, ready, failed, cat };
  });

  console.log(`Files in bucket: ${files.length}   linked to a row: ${files.length - orphans.length}   orphans: ${orphans.length}\n`);
  (['RECOVERABLE', 'EXTRA', 'TINY', 'NO CLASS'] as Cat[]).forEach((c) => {
    const g = result.filter((x) => x.cat === c);
    console.log(`${c.padEnd(12)} ${String(g.length).padStart(4)} files   ${gb(g.reduce((s, x) => s + x.size, 0))} GB`);
  });
  console.log('\n--- details ---');
  result
    .sort((a, b) => a.cat.localeCompare(b.cat) || a.modified.getTime() - b.modified.getTime())
    .forEach((x) => {
      const label = x.cls ? `${x.cls.classCode} · ${x.cls.title} · ${x.cls.scheduledDate.toISOString().slice(0, 10)} · ${x.cls.status}` : '(class not found)';
      console.log(`${x.cat.padEnd(12)} ${mb(x.size).padStart(8)}  ${x.modified.toISOString().slice(0, 16)}  ${label}  [READY rows: ${x.ready}, FAILED rows: ${x.failed}]  ${x.key}`);
    });

  if (!relink) { console.log('\nREPORT ONLY. Add --relink to preview re-linking the RECOVERABLE files.'); return; }

  const todo = result.filter((x) => x.cat === 'RECOVERABLE');
  console.log(`\n${execute ? 'RE-LINKING' : 'WOULD RE-LINK'} ${todo.length} file(s) (${gb(todo.reduce((s, x) => s + x.size, 0))} GB) — each gets a READY row and the class's stale FAILED rows are removed.`);
  if (!execute) { console.log('Nothing changed. Add --execute to apply.'); return; }

  let made = 0;
  for (const x of todo) {
    // eslint-disable-next-line no-await-in-loop
    await prisma.liveClassRecording.create({
      data: {
        liveClassId: x.classId,
        egressId: `relinked-${x.key.replace(/[^a-zA-Z0-9]/g, '-')}`.slice(0, 190),
        status: 'READY',
        storageKey: x.key,
        fileSizeBytes: BigInt(x.size),
        startedAt: x.modified,
        endedAt: x.modified,
      },
    });
    made++;
  }
  const classesFixed = Array.from(new Set(todo.map((x) => x.classId)));
  const cleared = classesFixed.length
    ? await prisma.liveClassRecording.deleteMany({ where: { liveClassId: { in: classesFixed }, status: 'FAILED' } })
    : { count: 0 };
  console.log(`DONE: ${made} recordings re-linked, ${cleared.count} stale FAILED rows removed. Duration shows as "—" for these (not stored).`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
