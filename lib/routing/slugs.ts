import { and, eq } from "drizzle-orm";
import {
  slugs, redirects, cities, verticals, areas, categories, listings,
} from "@/lib/db/schema";
import type { TestDb } from "@/lib/db/types";
import { slugify, isReserved, RESERVED_SLUGS } from "./slugify";

export const ROOT_SCOPE = "root";

export type SlugKind = "static" | "city" | "vertical" | "area" | "category" | "listing" | "region";

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

/**
 * Claims one candidate, or reports that someone else already holds it.
 *
 * Insert-and-see rather than check-then-insert: two imports of the same
 * business name used to pass the "is it taken?" check together, and the loser's
 * INSERT raised 23505 — which poisons the whole surrounding transaction in
 * Postgres, so the caller aborted instead of taking the next candidate.
 */
async function claim(
  tx: Tx,
  values: { parentScope: string; slug: string; kind: SlugKind; entityId: string | null },
): Promise<boolean> {
  const inserted = await tx
    .insert(slugs)
    .values(values)
    .onConflictDoNothing()
    .returning({ slug: slugs.slug });
  return inserted.length > 0;
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
  // /leeds/pricing is not a route we own, so a business may be called Pricing.
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
    const claimed = await claim(tx, {
      parentScope: input.parentScope,
      slug: candidate,
      kind: input.kind,
      entityId: input.entityId,
    });
    if (claimed) return candidate;
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
    await claim(tx, { parentScope: ROOT_SCOPE, slug, kind: "static", entityId: null });
  }
}

/**
 * The registry says where a URL resolves; the entity's own `slug` column is
 * what every link on the site is BUILT from — the sitemap, the homepage, the
 * category pages. Leaving it stale means every internal link keeps emitting the
 * old URL and 301s on the way in, which is exactly the link equity a rename is
 * supposed to preserve.
 */
async function writeEntitySlug(
  tx: Tx, kind: Exclude<SlugKind, "static">, entityId: string, slug: string,
): Promise<void> {
  switch (kind) {
    case "city":
      await tx.update(cities).set({ slug }).where(eq(cities.id, entityId));
      return;
    case "vertical":
      await tx.update(verticals).set({ slug }).where(eq(verticals.id, entityId));
      return;
    case "area":
      await tx.update(areas).set({ slug }).where(eq(areas.id, entityId));
      return;
    case "category":
      await tx.update(categories).set({ slug }).where(eq(categories.id, entityId));
      return;
    case "listing":
      await tx.update(listings).set({ slug }).where(eq(listings.id, entityId));
      return;
    case "region":
      // A region has no row of its own: its name lives on every city in it,
      // and lib/db/queries/areas.ts `renameRegion` rewrites those.
      return;
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
  if (input.kind === "static") {
    throw new SlugError("A static slug belongs to a route, not an entity, and cannot be renamed");
  }
  const kind = input.kind;

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
  // A category has two kinds of registry row: the root one that names its
  // national page at /categories/<slug> — its identity — and a per-city alias
  // that makes /<city>/<slug> resolve. Renaming an alias must not move the
  // national page out from under everything linking to it.
  const isCategoryAlias = kind === "category" && input.parentScope !== ROOT_SCOPE;
  if (!isCategoryAlias) await writeEntitySlug(tx, kind, input.entityId, allocated);

  const newPath = input.newPathFor(allocated);

  // Collapse the chain first. Rename twice and /alpha -> /beta -> /gamma is two
  // hops: it leaks link equity, and Google stops following after a handful.
  // Every URL that pointed at the old path now points at the new one directly.
  await tx.update(redirects).set({ toPath: newPath }).where(eq(redirects.toPath, input.oldPath));

  await tx
    .insert(redirects)
    .values({ fromPath: input.oldPath, toPath: newPath, statusCode: 301 })
    .onConflictDoUpdate({ target: redirects.fromPath, set: { toPath: newPath } });

  return allocated;
}

/* ------------------------------------------------------------------ regions */

/**
 * Where region slugs live in the registry.
 *
 * A region is not a row of its own: it is the set of cities that share a
 * `cities.region` value, and its page is /areas/<slug>. "areas" is a reserved
 * root slug, so the scope is that literal rather than an entity id — the same
 * way ROOT_SCOPE is a literal. Nothing else is ever allocated under it.
 */
export const REGION_SCOPE = "areas";

/** The one spelling of a region's URL segment, from its name. */
export const regionSlug = (region: string): string => slugify(region);

/**
 * Registers a region's slug. Idempotent, so the seed and every import can
 * call it for every city row they touch.
 *
 * `entityId` is null on purpose: the registry has no region table to point
 * at. The slug IS derived from the name, so resolution goes the other way —
 * a region page asks the cities for the region whose slugified name matches —
 * and the row here is what a rename hangs its redirect off (see
 * `renameRegion` in lib/db/queries/areas.ts).
 *
 * Reserved words are refused as they are at the root: /areas/page/2 is page 2
 * of /areas, so a region called "Page" would have a URL it could never own.
 */
export async function registerRegionSlug(tx: Tx, region: string): Promise<string> {
  const slug = regionSlug(region);
  if (slug === "") {
    throw new SlugError(`Cannot derive a slug from region ${JSON.stringify(region)}`);
  }
  if (isReserved(slug)) {
    throw new SlugError(`"${slug}" is a reserved slug and cannot be used for a region`);
  }
  await claim(tx, { parentScope: REGION_SCOPE, slug, kind: "region", entityId: null });
  return slug;
}

/** The inverse, for a rename: the old spelling's row goes so nothing claims it twice. */
export async function releaseRegionSlug(tx: Tx, region: string): Promise<void> {
  await tx
    .delete(slugs)
    .where(and(eq(slugs.parentScope, REGION_SCOPE), eq(slugs.slug, regionSlug(region))));
}
