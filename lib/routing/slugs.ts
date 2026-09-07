import { and, eq } from "drizzle-orm";
import { slugs, redirects } from "@/lib/db/schema";
import type { TestDb } from "@/test/db";
import { slugify, isReserved, RESERVED_SLUGS } from "./slugify";

export const ROOT_SCOPE = "root";

export type SlugKind = "static" | "city" | "vertical" | "area" | "category" | "listing";

export interface SlugRow {
  parentScope: string;
  slug: string;
  kind: SlugKind;
  entityId: string | null;
}

/** Any Drizzle handle — the real db or a test transaction. */
type Tx = TestDb;

export class SlugError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlugError";
  }
}

async function isTaken(tx: Tx, parentScope: string, slug: string): Promise<boolean> {
  const [row] = await tx
    .select({ slug: slugs.slug })
    .from(slugs)
    .where(and(eq(slugs.parentScope, parentScope), eq(slugs.slug, slug)))
    .limit(1);
  return row !== undefined;
}

/**
 * Allocates a slug within a scope, disambiguating on collision.
 *
 * Ladder: desired -> desired-disambiguator -> desired-disambiguator-2, -3, ...
 * Returns the slug actually allocated; insert the entity row with THIS value.
 *
 * Scope is the literal 'root' for cities and verticals, or the owning city's /
 * vertical's uuid for categories, areas and listings. That single namespace is
 * what stops a listing taking a category's slug inside the same city — a
 * collision no amount of resolution ordering can fix.
 */
export async function allocateSlug(
  tx: Tx,
  input: {
    parentScope: string;
    desired: string;
    kind: SlugKind;
    entityId: string;
    disambiguator?: string;
  },
): Promise<string> {
  const bare = slugify(input.desired);
  if (bare === "") {
    throw new SlugError(
      `Cannot derive a slug from ${JSON.stringify(input.desired)} — nothing slug-able in it`,
    );
  }
  // Reserved words only shadow a static route at the root. Inside a city,
  // /leeds/pricing is not a route we own, so a venue may be called Pricing.
  if (input.parentScope === ROOT_SCOPE && isReserved(bare)) {
    throw new SlugError(`"${bare}" is a reserved slug and cannot be used for a ${input.kind}`);
  }

  const candidates: string[] = [bare];
  const disambiguated = input.disambiguator
    ? slugify(`${input.desired}-${input.disambiguator}`)
    : null;
  if (disambiguated !== null && disambiguated !== bare) candidates.push(disambiguated);

  const stem = disambiguated ?? bare;
  for (let n = 2; n <= 50; n++) candidates.push(`${stem}-${n}`);

  for (const candidate of candidates) {
    if (await isTaken(tx, input.parentScope, candidate)) continue;
    await tx.insert(slugs).values({
      parentScope: input.parentScope,
      slug: candidate,
      kind: input.kind,
      entityId: input.entityId,
    });
    return candidate;
  }
  throw new SlugError(`Exhausted slug candidates for "${bare}" in scope ${input.parentScope}`);
}

export async function resolveSlug(
  tx: Tx,
  parentScope: string,
  slug: string,
): Promise<SlugRow | null> {
  const [row] = await tx
    .select({
      parentScope: slugs.parentScope,
      slug: slugs.slug,
      kind: slugs.kind,
      entityId: slugs.entityId,
    })
    .from(slugs)
    .where(and(eq(slugs.parentScope, parentScope), eq(slugs.slug, slug.toLowerCase())))
    .limit(1);
  return row ?? null;
}

/** Idempotent. Run from the seed and from any migration path. */
export async function seedReservedSlugs(tx: Tx): Promise<void> {
  for (const slug of RESERVED_SLUGS) {
    if (await isTaken(tx, ROOT_SCOPE, slug)) continue;
    await tx.insert(slugs).values({
      parentScope: ROOT_SCOPE,
      slug,
      kind: "static",
      entityId: null,
    });
  }
}

/**
 * Renames an entity's slug and preserves the old URL.
 *
 * Any slug change writes a redirects row and serves a 301 — never break a URL.
 * A rename that slugifies to the same value is a no-op: without that guard,
 * every admin save of an unchanged name writes a self-referential 301 and the
 * redirects table becomes a redirect-loop generator.
 */
export async function reallocateSlug(
  tx: Tx,
  input: {
    parentScope: string;
    entityId: string;
    kind: SlugKind;
    newDesired: string;
    oldPath: string;
    newPathFor: (slug: string) => string;
    disambiguator?: string;
  },
): Promise<string> {
  const [current] = await tx
    .select({ slug: slugs.slug })
    .from(slugs)
    .where(and(eq(slugs.parentScope, input.parentScope), eq(slugs.entityId, input.entityId)))
    .limit(1);
  if (!current) {
    throw new SlugError(`No slug allocated for entity ${input.entityId} in scope ${input.parentScope}`);
  }

  if (slugify(input.newDesired) === current.slug) return current.slug;

  await tx
    .delete(slugs)
    .where(and(eq(slugs.parentScope, input.parentScope), eq(slugs.entityId, input.entityId)));

  const allocated = await allocateSlug(tx, {
    parentScope: input.parentScope,
    desired: input.newDesired,
    kind: input.kind,
    entityId: input.entityId,
    disambiguator: input.disambiguator,
  });

  await tx
    .insert(redirects)
    .values({ fromPath: input.oldPath, toPath: input.newPathFor(allocated), statusCode: 301 })
    .onConflictDoUpdate({
      target: redirects.fromPath,
      set: { toPath: input.newPathFor(allocated) },
    });

  return allocated;
}
