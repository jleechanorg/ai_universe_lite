import { Storage, type Bucket, type File } from "@google-cloud/storage";
import { logger } from "../lib/logger.js";

// =====================================================================
// GCS reference-file store
// ---------------------------------------------------------------------
// Object layout: gs://<bucket>/intake/<intakeId>/<filename>
// Lifecycle: 30-day expiration is enforced by the GCS bucket lifecycle
// rule (see infra/terraform). This module never deletes files on upload;
// deleteRefs() is for the GC cron that runs after a 30-day grace.
// =====================================================================

const BUCKET_FALLBACK = "ai-universe-lite-refs";

let storage: Storage | null = null;
let bucket: Bucket | null = null;

function resolveBucketName(): string {
  const fromEnv = process.env.REF_BUCKET;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return BUCKET_FALLBACK;
}

function getStorageClient(): Storage {
  if (storage) return storage;
  storage = new Storage();
  return storage;
}

/**
 * Lazy-init the reference bucket. Subsequent calls return the same
 * cached Bucket handle.
 */
export async function initBucket(): Promise<Bucket> {
  if (bucket) return bucket;
  const name = resolveBucketName();
  const client = getStorageClient();
  bucket = client.bucket(name);
  // Probe to surface misconfig / missing-bucket early. getMetadata()
  // is the cheapest read; if the bucket doesn't exist this throws
  // 404, which is the right signal to fail fast.
  try {
    await bucket.getMetadata();
    logger.info({ bucket: name }, "ref storage bucket ready");
  } catch (err) {
    logger.warn({ err, bucket: name }, "ref storage bucket metadata probe failed (continuing)");
  }
  return bucket;
}

function objectName(intakeId: string, filename: string): string {
  // Object name: intake/<intakeId>/<filename> — explicit prefix so
  // listRefs() can be a single .getFiles({ prefix }) call.
  return `intake/${intakeId}/${filename}`;
}

export interface UploadRefResult {
  objectName: string;
  signedUrl: string;
  size: number;
}

/**
 * Upload a single reference file for an intake and return a
 * long-lived (7 day) v4 signed URL for the agent to download.
 */
export async function uploadRef(
  intakeId: string,
  filename: string,
  contentType: string,
  buffer: Buffer,
): Promise<UploadRefResult> {
  const b = await initBucket();
  const name = objectName(intakeId, filename);
  const file: File = b.file(name);
  await file.save(buffer, {
    contentType,
    resumable: false,
    metadata: { contentType },
  });
  const [size] = await file.getMetadata().then(([meta]) => {
    const n = Number((meta as { size?: string | number }).size ?? buffer.byteLength);
    return [Number.isFinite(n) ? n : buffer.byteLength] as const;
  });
  const signedUrl = await getSignedDownloadUrl(intakeId, filename, 7 * 24 * 60 * 60);
  logger.info({ intakeId, filename, size, objectName: name }, "ref uploaded");
  return { objectName: name, signedUrl, size };
}

/**
 * Download a single reference file's bytes.
 */
export async function getRef(intakeId: string, filename: string): Promise<Buffer> {
  const b = await initBucket();
  const name = objectName(intakeId, filename);
  const [contents] = await b.file(name).download();
  return contents as Buffer;
}

export interface RefListing {
  filename: string;
  size: number;
  contentType: string;
  updated: string;
}

/**
 * List all files under intake/<intakeId>/, returning metadata for
 * each. Filename is the basename (not the full object key).
 */
export async function listRefs(intakeId: string): Promise<RefListing[]> {
  const b = await initBucket();
  const prefix = `intake/${intakeId}/`;
  const [files] = await b.getFiles({ prefix });
  const out: RefListing[] = [];
  for (const f of files) {
    const name = f.name;
    const filename = name.startsWith(prefix) ? name.slice(prefix.length) : name;
    if (!filename) continue;
    const [meta] = await f.getMetadata();
    const m = meta as {
      size?: string | number;
      contentType?: string;
      updated?: string;
    };
    out.push({
      filename,
      size: Number(m.size ?? 0),
      contentType: m.contentType ?? "application/octet-stream",
      updated: m.updated ?? new Date().toISOString(),
    });
  }
  return out;
}

/**
 * Delete every file under intake/<intakeId>/. Used by the GC cron
 * after the 30-day terraform-managed lifecycle. Safe to call when
 * the prefix is empty (no-op).
 */
export async function deleteRefs(intakeId: string): Promise<void> {
  const b = await initBucket();
  const prefix = `intake/${intakeId}/`;
  const [files] = await b.getFiles({ prefix });
  if (files.length === 0) {
    logger.debug({ intakeId }, "deleteRefs: nothing to delete");
    return;
  }
  await Promise.all(
    files.map((f) =>
      f.delete({ ignoreNotFound: true }).catch((err: unknown) => {
        logger.warn({ err, name: f.name }, "deleteRefs: failed to delete one object");
      }),
    ),
  );
  logger.info({ intakeId, deleted: files.length }, "ref store: intake cleared");
}

/**
 * Generate a v4 signed URL for ephemeral download. Default TTL 1h.
 * The bucket must be uniform-bucket-level-access off OR the signing
 * service account must have iam.serviceAccountTokenCreator on the
 * bucket (the deploy contract sets this up).
 */
export async function getSignedDownloadUrl(
  intakeId: string,
  filename: string,
  ttlSeconds = 3600,
): Promise<string> {
  const b = await initBucket();
  const name = objectName(intakeId, filename);
  const [url] = await b.file(name).getSignedUrl({
    version: "v4",
    action: "read",
    expires: Date.now() + ttlSeconds * 1000,
  });
  return url;
}
