/**
 * Clean up old Live Class recordings (R2 files + their database rows).
 *
 *   DRY RUN (default, deletes nothing):
 *     npx ts-node src/utils/cleanupRecordings.ts --before=2026-09-01
 *
 *   REALLY DELETE (permanent — R2 has no recycle bin):
 *     npx ts-node src/utils/cleanupRecordings.ts --before=2026-09-01 --execute
 *
 * --before=YYYY-MM-DD  : only recordings whose file was written before this date are touched.
 * Removes: recordings/... files older than the cutoff, the READY rows pointing at them, and FAILED rows
 * older than the cutoff (they have no file). Files in the bucket with no database row ("orphans") older
 * than the cutoff are deleted too.
 */
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import prisma from '../config/database';
import { config } from '../config/env';

const arg = (name: string) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=')[1];
const execute = process.argv.includes('--execute');
const gb = (b: number) => (b / 1024 / 1024 / 1024).toFixed(2);

async function main() {
  const before = arg('before');
  if (!before || isNaN(new Date(before).getTime())) {
    console.error('Give a cutoff date, e.g.  --before=2026-09-01');
    process.exit(1);
  }
  const cutoff = new Date(before);
  const bucket = config.R2_RECORDINGS_BUCKET;
  if (!bucket || !config.R2_ENDPOINT) { console.error('R2 is not configured in .env'); process.exit(1); }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: config.R2_ENDPOINT,
    credentials: { accessKeyId: config.R2_ACCESS_KEY_ID, secretAccessKey: config.R2_SECRET_ACCESS_KEY },
  });

  // 1. List every recording file in the bucket.
  const files: { key: string; size: number; modified: Date }[] = [];
  let token: string | undefined;
  do {
    // eslint-disable-next-line no-await-in-loop
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'recordings/', ContinuationToken: token }));
    for (const o of r.Contents || []) if (o.Key && o.LastModified) files.push({ key: o.Key, size: o.Size || 0, modified: o.LastModified });
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);

  const old = files.filter((f) => f.modified < cutoff);
  const keep = files.filter((f) => f.modified >= cutoff);
  const oldKeys = new Set(old.map((f) => f.key));

  // 2. Which database rows go with them.
  const rows = await prisma.liveClassRecording.findMany({ select: { id: true, storageKey: true, status: true, startedAt: true } });
  const rowsForFiles = rows.filter((r) => r.storageKey && oldKeys.has(r.storageKey));
  const orphanFiles = old.filter((f) => !rows.some((r) => r.storageKey === f.key));
  const oldFailed = rows.filter((r) => r.status === 'FAILED' && r.startedAt < cutoff);

  // 3. Report.
  const total = files.reduce((s, f) => s + f.size, 0);
  const oldSize = old.reduce((s, f) => s + f.size, 0);
  console.log(`Bucket ${bucket}: ${files.length} recording files, ${gb(total)} GB`);
  console.log(`Cutoff ${before}: ${old.length} files (${gb(oldSize)} GB) are older and will be removed; ${keep.length} files (${gb(total - oldSize)} GB) are kept.`);
  console.log(`  Database rows removed with them: ${rowsForFiles.length}   |   old FAILED rows (no file): ${oldFailed.length}   |   orphan files (no row): ${orphanFiles.length}`);
  const byMonth = new Map<string, { n: number; size: number }>();
  for (const f of old) { const m = f.modified.toISOString().slice(0, 7); const v = byMonth.get(m) || { n: 0, size: 0 }; v.n++; v.size += f.size; byMonth.set(m, v); }
  [...byMonth.entries()].sort().forEach(([m, v]) => console.log(`  ${m}: ${v.n} files, ${gb(v.size)} GB`));

  if (!execute) {
    console.log('\nDRY RUN — nothing deleted. Re-run with --execute to delete permanently.');
    return;
  }

  // 4. Delete files in batches of 1000, then the rows.
  let deleted = 0;
  for (let i = 0; i < old.length; i += 1000) {
    const batch = old.slice(i, i + 1000);
    // eslint-disable-next-line no-await-in-loop
    const r = await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: batch.map((f) => ({ Key: f.key })), Quiet: true } }));
    deleted += batch.length - (r.Errors?.length || 0);
    if (r.Errors?.length) console.error('Some files failed to delete:', r.Errors.slice(0, 5));
  }
  const rowIds = [...rowsForFiles, ...oldFailed].map((r) => r.id);
  const removedRows = rowIds.length ? await prisma.liveClassRecording.deleteMany({ where: { id: { in: rowIds } } }) : { count: 0 };
  console.log(`\nDONE: deleted ${deleted} files and ${removedRows.count} database rows.`);
}

main().catch((e) => { console.error(e); process.exit(1); }).finally(() => prisma.$disconnect());
