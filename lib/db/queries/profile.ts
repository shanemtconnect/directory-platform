import { eq } from "drizzle-orm";
import { profiles, user } from "@/lib/db/schema";
import { ensureProfile } from "@/lib/auth/profile";
import { isAdmin, type Viewer } from "@/lib/db/viewer";
import type { TestDb } from "@/test/db";
import { writeAudit } from "./audit";

/**
 * A person's own account record: half of it Better Auth's (`user`), half ours
 * (`profiles`).
 *
 * There is deliberately no `profileId` or `userId` parameter on any of these.
 * Constraint 24 says an owner sees only their own rows, and the cheapest way to
 * guarantee that is to leave the caller nothing to tamper with: the row is
 * chosen by the viewer, so "can a user edit another user's profile" is not a
 * check that can be forgotten — it is a question the signature cannot express.
 *
 * `role` is readable here and never writable. It is the admin bit
 * (lib/auth/viewer.ts reads it), so the only thing that sets it is a hand
 * written statement against the database.
 */

export interface OwnProfile {
  /** The uuid every "who" column in our schema references. */
  profileId: string;
  role: "user" | "owner" | "admin";
  /** From `profiles`, falling back to the name on the account. */
  name: string | null;
  phone: string | null;
  marketingOptIn: boolean;
  email: string;
  /** Drives the banner on /account. Sign-in does not depend on it. */
  emailVerified: boolean;
}

export interface ProfileUpdate {
  name: string | null;
  phone: string | null;
  marketingOptIn: boolean;
  /** For the audit row. Null when the request arrived with no proxy header. */
  ip: string | null;
}

function assertSignedIn(viewer: Viewer): asserts viewer is Exclude<Viewer, { role: "public" }> {
  if (viewer.role === "public") throw new Error("FORBIDDEN");
}

async function read(tx: TestDb, userId: string, profileId: string): Promise<OwnProfile> {
  const [row] = await tx
    .select({
      role: profiles.role,
      profileName: profiles.name,
      phone: profiles.phone,
      marketingOptIn: profiles.marketingOptIn,
      email: user.email,
      accountName: user.name,
      emailVerified: user.emailVerified,
    })
    .from(profiles)
    .innerJoin(user, eq(user.id, profiles.userId))
    .where(eq(profiles.userId, userId))
    .limit(1);

  // The profile was created or found a statement ago and the user row is its
  // own foreign key, so this is unreachable rather than a case to handle.
  if (!row) throw new Error("ownProfile: the account disappeared mid-read");

  return {
    profileId,
    role: row.role,
    // A brand-new profile has no name of its own; the one typed at signup is
    // on the account. Falling back means the settings form is pre-filled
    // rather than blank, which is the difference between a person correcting
    // a name and a person retyping one.
    name: row.profileName ?? row.accountName,
    phone: row.phone,
    marketingOptIn: row.marketingOptIn,
    email: row.email,
    emailVerified: row.emailVerified,
  };
}

/**
 * Creates the row if this is the first time we have needed it. Signing up does
 * not write a profile — Better Auth does not know about our table — so lazy
 * creation is what guarantees requirement 4, and it happens on a READ as well
 * as a write so simply opening /account is enough.
 */
export async function ownProfile(tx: TestDb, viewer: Viewer): Promise<OwnProfile> {
  assertSignedIn(viewer);
  const { id } = await ensureProfile(tx, viewer);
  return read(tx, viewer.userId, id);
}

/**
 * Audited in the same transaction as the change (constraint 22). The caller
 * passes a transaction handle for exactly that reason.
 *
 * Only three columns are settable. `role` and `billing_customer_id` are not in
 * the update object at all, rather than being filtered out of one: a column
 * that is never named cannot be added to the form later by accident.
 */
export async function updateOwnProfile(
  tx: TestDb,
  viewer: Viewer,
  input: ProfileUpdate,
): Promise<OwnProfile> {
  assertSignedIn(viewer);
  const { id } = await ensureProfile(tx, viewer);

  await tx
    .update(profiles)
    .set({
      name: input.name,
      phone: input.phone,
      marketingOptIn: input.marketingOptIn,
    })
    .where(eq(profiles.userId, viewer.userId));

  await writeAudit(tx, viewer, {
    action: "profile.updated",
    entityType: "profile",
    entityId: id,
    // The values are not copied into the audit row: it is a record that the
    // person changed their own contact details, not a second copy of them.
    meta: { marketingOptIn: input.marketingOptIn, phoneSet: input.phone !== null },
    ip: input.ip,
  });

  return read(tx, viewer.userId, id);
}

/**
 * Where a password-reset or verification email goes.
 *
 * The queue carries a user id and a URL, never an address (lib/email/notify.ts),
 * so the worker resolves the recipient at send time — which also means an
 * account deleted between enqueue and send is simply not written to.
 *
 * Admin-gated because it turns an id into somebody else's email address, and
 * the only caller that legitimately holds one of those ids is the worker.
 */
export async function authEmailRecipient(
  tx: TestDb,
  viewer: Viewer,
  userId: string,
): Promise<{ email: string; name: string } | null> {
  if (!isAdmin(viewer)) throw new Error("FORBIDDEN");
  const [row] = await tx
    .select({ email: user.email, name: user.name })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return row ?? null;
}
