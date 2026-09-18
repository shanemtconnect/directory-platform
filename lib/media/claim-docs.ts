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

/** The way back: what a stored key's extension says the document is. */
const CONTENT_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The exact shape `claimDocKey` mints, with the claim id fixed. */
const KEY_SUFFIX = /^proof-[0-9a-f]{16}\.(pdf|jpg|jpeg|png)$/;

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
 * Is this a key `claimDocKey` could have minted for this claim?
 *
 * The key goes out to the browser with the upload form and comes back with
 * the confirm step, so it is text the claimant chose by the time it is
 * stored. A prefix check (`claims/<id>/`) is not enough: it passes
 * `claims/<id>/../<other id>/proof-….pdf`, which S3 keys do not normalise but
 * an admin's browser might, and it passes any name and any extension — and
 * the extension is what the view route later types the download as. So the
 * whole key has to match, character for character, the one shape the server
 * produces. Anchored on a literal uuid: the id is checked before it is spliced
 * in, so it cannot carry a metacharacter.
 */
export function isClaimDocKey(claimId: string, key: string): boolean {
  if (!UUID.test(claimId)) return false;
  const prefix = `claims/${claimId}/`;
  return key.startsWith(prefix) && KEY_SUFFIX.test(key.slice(prefix.length));
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

/**
 * The only way to read a claim document, and only from the admin route.
 *
 * Served as a download of the type the KEY says it is — the extension the
 * server chose from the content type it signed the upload for — never the
 * type the object was uploaded with. `async` for the same reason as the
 * upload: the caller's try/catch sees a rejection, not a throw.
 */
export async function presignClaimDocView(key: string): Promise<string> {
  const bucket = claimDocsEnv();
  const ext = key.slice(key.lastIndexOf(".") + 1);
  const contentType = CONTENT_TYPES[ext];
  if (contentType === undefined) {
    throw new Error(`presignClaimDocView: .${ext} is not allowed here`);
  }
  return presignGet(bucket, key, { ttlSeconds: CLAIM_DOC_VIEW_TTL_SECONDS, contentType });
}

export function deleteClaimDoc(key: string): Promise<void> {
  return deleteObject(claimDocsEnv(), key);
}
