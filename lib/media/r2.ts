import { S3Client, GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { createPresignedPost } from "@aws-sdk/s3-presigned-post";
import { MAX_UPLOAD_BYTES } from "./validate";

let cached: S3Client | null = null;

function client(): S3Client {
  if (cached) return cached;
  cached = new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID!,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY!,
    },
  });
  return cached;
}

export async function getObject(bucket: string, key: string): Promise<Buffer> {
  const res = await client().send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  const bytes = await res.Body!.transformToByteArray();
  return Buffer.from(bytes);
}

export async function putObject(
  bucket: string, key: string, body: Buffer, contentType: string,
): Promise<void> {
  await client().send(
    new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }),
  );
}

export async function deleteObject(bucket: string, key: string): Promise<void> {
  await client().send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
}

export interface PresignedUpload {
  /** POST the form here. */
  url: string;
  /** Hidden form fields, sent before the file part. */
  fields: Record<string, string>;
}

/**
 * Uploads go direct to R2, so files never land on the app server's disk — but
 * a presigned PUT signs the key and nothing else. Whoever holds it can push a
 * four-gigabyte file, or an HTML document with a Content-Type that makes the
 * CDN serve it back as a script from our own domain.
 *
 * A POST policy is the only presigned form that carries conditions, so the
 * size cap of global constraint 15 and the type restriction are enforced by
 * R2 at upload time rather than discovered by the worker afterwards. The
 * worker still sniffs the magic bytes: a Content-Type is a claim, not a fact.
 */
export function presignUpload(
  bucket: string,
  key: string,
  opts: { contentTypePrefix?: string; maxBytes?: number; ttlSeconds?: number } = {},
): Promise<PresignedUpload> {
  return createPresignedPost(client(), {
    Bucket: bucket,
    Key: key,
    Expires: opts.ttlSeconds ?? 900,
    Conditions: [
      // A zero-byte lower bound would let an empty file through and leave a
      // row the worker retries for ever.
      ["content-length-range", 1, opts.maxBytes ?? MAX_UPLOAD_BYTES],
      ["starts-with", "$Content-Type", opts.contentTypePrefix ?? "image/"],
    ],
  });
}

/**
 * The only way to read a claim document. 15 minutes, generated per view in an
 * admin-only route, and every generation is written to audit_log by the caller.
 */
export function presignGet(bucket: string, key: string, ttlSeconds = 900): Promise<string> {
  return getSignedUrl(client(), new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: ttlSeconds });
}
