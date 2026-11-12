/**
 * Delete recordings of OLD batches (R2 files + database rows), keeping Batch N and newer.
 *
 *   DRY RUN (default — deletes nothing, prints a per-batch table):
 *     npx ts-node src/utils/cleanupOldBatchRecordings.ts --keep-from=19
 *
 *   REALLY DELETE (permanent — R2 has no recycle bin):
 *     npx ts-node src/utils/cleanupOldBatchRecordings.ts --keep-from=19 --execute
 *
 * A file's batch comes from its class (recordings/<liveClassId>/...). Batch.code is free text like "Batch 17",
 * so the first number in it is the batch number. A class whose batch number can't be read is KEPT.
 * A combined (Soft Skills) class is kept if ANY of its batches is >= keep-from.
 * Files whose class no longer exists are listed as "no class" and deleted too (nothing can play them).
 * Also removes FAILED rows (no file) belonging to old-batch classes.
 */
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import prisma from '../config/database';
import { config } from '../config/env';

const arg = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.split('=')[1];
const execute = process.argv.includes('--execute');
const keepFrom = Number(arg('keep-from'));
const gb = (b: number) => (b / 1024 / 1024 / 1024).toFixed(2);
const num = (code?: string | null) => { const m = (code || '').match(/\d+/); return m ? Number(m[0]) : null; };

async function main() {
  if (!keepFrom || keepFrom < 1) { console.error('Give the first batch number to KEEP, e.g.  --keep-from=19'); process.exit(1); }
  const bucket = config.R2_RECORDINGS_BUCKET;
  if (!bucket || !config.R2_ENDPOINT) { console.error('R2 is not configured in .env'); process.exit(1); }
  const s3 = new S3Client({ region: 'auto', endpoint: config.R2_ENDPOINT, credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY } });

  const files: { key: string; size: number }[] = [];
  let token: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'recordings/', ContinuationToken: token }));
    for (const o of r.Contents || []) if (o.Key) files.push({ key: o.Key, size: o.Size || 0 });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);

  // Map every class that has a file OR a recording row to its batch number(s).
  const rows = await prisma.liveClassRecording.findMany({ select: { id: true, liveClassId: true, storageKey: true, status: true } });
  const classIds = Array.from(new Set([...files.map((f) => f.key.split('/')[1]), ...rows.map((r) => r.liveClassId)].filter(Boolean)));
  const classes = await prisma.liveClass.findMany({
    where: { id: { in: classIds } },
    select: { id: true, schedule: { select: { batch: { select: { code: true } } } }, extraSchedules: { select: { schedule: { select: { batch: { select: { code: true } } } } } } },
  });
  const nums = new Map<string, (number | null)[]>();
  const label = new Map<string, string>();
  for (const c of classes) {
    nums.set(c.id, [c.schedule?.batch?.code, ...c.extraSchedules.map((e) => e.schedule?.batch?.code)].map(num));
    label.set(c.id, c.schedule?.batch?.code || '(no batch)');
  }
  // verdict: 'keep' | 'delete' | 'nocls'
  const verdict = (classId: string): 'keep' | 'delete' | 'nocls' => {
    const n = nums.get(classId);
    if (!n) return 'nocls';
    const known = n.filter((x): x is number => x !== null);
    if (!known.length || known.some((x) => x >= keepFrom)) return 'keep';
    return 'delete';
  };

  const del = files.filter((f) => verdict(f.key.split('/')[1]) !== 'keep');
  const keep = files.filter((f) => verdict(f.key.split('/')[1]) === 'keep');
  const byBatch = new Map<string, { n: number; size: number }>();
  for (const f of files) {
    const id = f.key.split('/')[1];
    const v = verdict(id);
    const k = `${v === 'nocls' ? '(class deleted)' : label.get(id)}  ${v === 'keep' ? 'KEEP' : 'DELETE'}`;
    const e = byBatch.get(k) || { n: 0, size: 0 }; e.n++; e.size += f.size; byBatch.set(k, e);
  }
  console.log(`Keeping Batch ${keepFrom} and newer.\n`);
  [...byBatch.entries()].sort().forEach(([k, v]) => console.log(`  ${k.padEnd(34)} ${String(v.n).padStart(4)} files  ${gb(v.size).padStart(7)} GB`));
  const delKeys = new Set(del.map((f) => f.key));
  const delRows = rows.filter((r) => (r.storageKey && delKeys.has(r.storageKey)) || (r.status === 'FAILED' && verdict(r.liveClassId) === 'delete'));
  console.log(`\nTO DELETE: ${del.length} files (${gb(del.reduce((s, f) => s + f.size, 0))} GB) + ${delRows.length} database rows`);
  console.log(`KEPT:      ${keep.length} files (${gb(keep.reduce((s, f) => s + f.size, 0))} GB)`);

  if (!execute) { console.log('\nDRY RUN — nothing deleted. Re-run with --execute to delete permanently.'); return; }

  let deleted = 0;
  for (let i = 0; i < del.length; i += 1000) {
    const batch = del.slice(i, i + 1000);
    // eslint-disable-next-line no-await-in-loop
    const r = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((f) => ({ Key: f.key })), Quiet: true } }));
    deleted += batch.length - (r.Errors?.length || 0);
    if (r.Errors?.length) console.error('Some files failed to delete:', r.Errors.slice(0, 5));
  }
  const rm = delRows.length ? await prisma.liveClassRecording.deleteMany({ where: { id: { in: delRows.map((r) => r.id) } } }) : { count: 0 };
  console.log(`\nDONE: deleted ${deleted} files and ${rm.count} database rows.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
