import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config/env';
import crypto from 'crypto';
import path from 'path';

// ── R2 client (S3-compatible) ─────────────────────────────────────────────────
let _client: S3Client | null = null;

function getClient(): S3Client {
  if (!_client) {
    _client = new S3Client({
      region: 'auto',
      endpoint: config.R2_ENDPOINT,
      credentials: {
        accessKeyId:     config.R2_ACCESS_KEY_ID,
        secretAccessKey: config.R2_SECRET_ACCESS_KEY,
      },
    });
  }
  return _client;
}

// Returns true when R2 is configured
export function isCloudStorageEnabled(): boolean {
  return !!(config.R2_ENDPOINT && config.R2_ACCESS_KEY_ID && config.R2_SECRET_ACCESS_KEY && config.R2_BUCKET);
}

export const storageService = {
  /**
   * Upload a file buffer to R2.
   * @returns { key, url } — key for deletion, url for storage in DB
   */
  async upload(
    buffer: Buffer,
    originalName: string,
    mimetype: string,
    folder = 'documents',
  ): Promise<{ key: string; url: string }> {
    const ext  = path.extname(originalName).toLowerCase() || '';
    const uuid = crypto.randomUUID().replace(/-/g, '');
    const key  = `${folder}/${uuid}${ext}`;

    await getClient().send(new PutObjectCommand({
      Bucket:      config.R2_BUCKET,
      Key:         key,
      Body:        buffer,
      ContentType: mimetype,
    }));

    const url = `${config.R2_PUBLIC_URL}/${key}`;
    return { key, url };
  },

  /** Delete a file from R2 by its key. Silently ignores missing files. */
  async delete(key: string): Promise<void> {
    if (!key || key.startsWith('/uploads/')) return; // local-disk file — skip
    try {
      await getClient().send(new DeleteObjectCommand({
        Bucket: config.R2_BUCKET,
        Key:    key,
      }));
    } catch (err) {
      console.error('[storage] delete failed for key:', key, err);
    }
  },

  /**
   * Short-lived signed GET URL for a PRIVATE bucket — used for Live Classes
   * recordings (a separate, non-public bucket from R2_BUCKET above), so
   * playback never routes through a permanent/guessable public link. Takes
   * an explicit `bucket` param (rather than always using R2_BUCKET) since
   * this is the one caller in the app reading from a different bucket.
   */
  /**
   * Preflight: write + delete a tiny object in `bucket`. Returns null when storage works, otherwise a
   * human-readable reason (e.g. R2 not enabled on the Cloudflare account, bad keys, missing bucket).
   */
  async checkBucket(bucket: string): Promise<string | null> {
    if (!config.R2_ENDPOINT || !config.R2_ACCESS_KEY_ID || !config.R2_SECRET_ACCESS_KEY) {
      return 'Recording storage is not configured (R2_ENDPOINT / R2_ACCESS_KEY_ID / R2_SECRET_ACCESS_KEY missing on the server).';
    }
    if (!bucket) return 'Recording bucket is not configured (R2_RECORDINGS_BUCKET missing on the server).';
    const key = `_healthcheck/${Date.now()}.txt`;
    try {
      await getClient().send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: 'ok', ContentType: 'text/plain' }));
      await getClient().send(new DeleteObjectCommand({ Bucket: bucket, Key: key })).catch(() => {});
      return null;
    } catch (err) {
      const e = err as { name?: string; Code?: string; message?: string };
      const code = e.Code || e.name || 'Error';
      let hint = '';
      if (code === 'NotEntitled' || /enable R2/i.test(e.message || '')) hint = ' — R2 is not enabled on this Cloudflare account (enable R2 in the Cloudflare dashboard).';
      else if (code === 'NoSuchBucket') hint = ` — bucket "${bucket}" does not exist.`;
      else if (code === 'AccessDenied' || code === 'InvalidAccessKeyId' || code === 'SignatureDoesNotMatch') hint = ' — check the R2 access keys and that they have Object Read & Write on this bucket.';
      return `Recording storage check failed: ${code}${hint}`.slice(0, 450);
    }
  },

  async getPresignedUrl(bucket: string, key: string, expiresInSeconds = 3600): Promise<string> {
    return getSignedUrl(getClient(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresInSeconds });
  },
};
