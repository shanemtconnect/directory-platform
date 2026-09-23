import { createHash } from "node:crypto";

/**
 * What a magic token looks like AT REST.
 *
 * Claim links, review verification links and outreach links are bearer
 * credentials: whoever holds one gets what it unlocks. Stored raw, a table
 * read — a backup, a dump pasted into a ticket, an admin page that lists the
 * column — hands out every live credential at once. Stored as a digest, the
 * same read yields nothing that opens anything: SHA-256 cannot be run
 * backwards, and the tokens it digests are 256 random bits, so there is no
 * dictionary to try.
 *
 * Plain SHA-256, not a salted or slow hash, on purpose. Salting and stretching
 * defend guessable secrets (passwords) against an offline search; a token
 * minted from the CSPRNG is not guessable, and a slow hash would only make
 * every lookup slower. Deterministic is the point: the lookup hashes what it
 * is handed and compares by equality, so the unique index keeps working.
 *
 * The raw token exists in exactly two places: the link that is sent, and the
 * job payload that carries it to the worker, which is scrubbed once the job
 * finishes (see lib/db/queries/jobs.ts).
 */
export function hashToken(raw: string): string {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}
