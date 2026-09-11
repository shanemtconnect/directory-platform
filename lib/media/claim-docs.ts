import { randomBytes } from "node:crypto";
import { deleteObject, presignGet, presignUpload, type PresignedUpload } from "./r2";
import { CLAIM_DOCUMENT_TYPES, MAX_UPLOAD_BYTES } from "./validate";

/**
 * The private half of storage.
 *
 * A claim document is somebody's utility bill or headed letter, uploaded to
 * prove they run a business. It lives in its own bucket — never the media one,
 * which is served publicly through a CDN — is never given a public URL, and is
 * deleted thirty days after the claim is decided.
 *
 * Everything here fails closed when the R2 credentials are absent, which is
 * the local and staging state today. The claim page hides the document rung
 * rather than offering a button that throws.
 */

export const CLAIM_DOC_MAX_BYTES = MAX_UPLOAD_BYTES;

/** How long an admin's view of a document stays valid. */
export const CLAIM_DOC_VIEW_TTL_SECONDS = 15 * 60;

const EXTENSIONS: Record<string, string> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function blank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

export function claimDocsConfigured(): boolean {
  return !(
    blank(process.env.R2_ACCOUNT_ID) ||
    blank(process.env.R2_ACCESS_KEY_ID) ||
    blank(process.env.R2_SECRET_ACCESS_KEY) ||
    blank(process.env.R2_BUCKET_CLAIM_DOCS)
  );
}

/**
 * The bucket name, or a refusal.
 *
 * `process.env.R2_BUCKET_CLAIM_DOCS!` would sign a URL against the bucket
 * literally named "undefined" — which either 404s much later or, worse,
 * succeeds against somebody's test bucket.
 */
export function claimDocsEnv(): string {
  if (!claimDocsConfigured()) {
    throw new Error("Claim document storage is not configured (R2_BUCKET_CLAIM_DOCS)");
  }
  return process.env.R2_BUCKET_CLAIM_DOCS!.trim();
}

export function isAllowedClaimDocType(contentType: string): boolean {
  return (CLAIM_DOCUMENT_TYPES as readonly string[]).includes(contentType);
}

/**
 * The object key, chosen by the server.
 *
 * Never built from the uploaded filename: a name is attacker-controlled text,
 * and the only safe response to `../../` is not to use it at all. The random
 * suffix means a second attempt on the same claim cannot silently overwrite
 * the first — the row decides which key is current, not the bucket.
 */
export function claimDocKey(claimId: string, contentType: string): string {
  if (!UUID.test(claimId)) throw new Error("claimDocKey: claim id must be a uuid");
  const ext = EXTENSIONS[contentType];
  if (ext === undefined) throw new Error(`claimDocKey: ${contentType} is not allowed here`);
  return `claims/${claimId}/proof-${randomBytes(8).toString("hex")}.${ext}`;
}

/**
 * Uploads go straight to R2, so a document never touches the app server's
 * disk. The exact content type is pinned in the policy rather than a prefix:
 * for claim documents the allowed set is three specific types, and R2 should
 * refuse a fourth at upload time rather than us discovering it later.
 */
// `async` so a refusal comes back as a rejected promise rather than a throw
// from the call expression: every caller awaits this inside a try.
export async function presignClaimDocUpload(
  key: string,
  contentType: string,
): Promise<PresignedUpload> {
  const bucket = claimDocsEnv();
  if (!isAllowedClaimDocType(contentType)) {
    throw new Error(`File type ${contentType} is not allowed here`);
  }
  return presignUpload(bucket, key, {
    contentTypePrefix: contentType,
    maxBytes: CLAIM_DOC_MAX_BYTES,
  });
}

/** The only way to read a claim document, and only from the admin route. */
export function presignClaimDocView(key: string): Promise<string> {
  return presignGet(claimDocsEnv(), key, CLAIM_DOC_VIEW_TTL_SECONDS);
}

export function deleteClaimDoc(key: string): Promise<void> {
  return deleteObject(claimDocsEnv(), key);
}
