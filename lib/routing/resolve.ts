import { eq } from "drizzle-orm";
import { redirects } from "@/lib/db/schema";
import type { SiteMode } from "@/config/types";
import type { TestDb } from "@/test/db";
import { resolveSlug, ROOT_SCOPE } from "./slugs";
import type { PillarScope } from "./scope";

export type RouteResolution =
  | { kind: "pillar"; scope: PillarScope }
  | { kind: "listing"; listingId: string; parentId: string }
  | { kind: "redirect"; to: string; status: number }
  | { kind: "not-found" };

async function redirectFor(tx: TestDb, path: string): Promise<RouteResolution | null> {
  const [r] = await tx.select().from(redirects).where(eq(redirects.fromPath, path)).limit(1);
  return r ? { kind: "redirect", to: r.toPath, status: r.statusCode } : null;
}

/**
 * One lookup per segment against the slug registry.
 *
 * No ordered fallback and no mode-specific branching: the `kind` column already
 * says what a slug is, which is exactly why /leeds/barn-venues is unambiguous
 * and why both site modes share this function.
 */
export async function resolveRoute(
  tx: TestDb,
  segments: string[],
  mode: SiteMode,
): Promise<RouteResolution> {
  const path = `/${segments.join("/")}`;
  const first = segments[0];
  if (first === undefined) return { kind: "not-found" };

  const root = await resolveSlug(tx, ROOT_SCOPE, first);

  // A reserved slug reaching this resolver means the static route did not
  // match, so there is nothing here. Never fall through to a lookup.
  if (root?.kind === "static") return { kind: "not-found" };

  const expectedRootKind = mode === "niche-national" ? "city" : "vertical";
  if (!root || root.kind !== expectedRootKind || root.entityId === null) {
    return (await redirectFor(tx, path)) ?? { kind: "not-found" };
  }
  const parentId = root.entityId;

  if (segments.length === 1) {
    return {
      kind: "pillar",
      scope:
        mode === "niche-national"
          ? { type: "city", cityId: parentId }
          : { type: "vertical", verticalId: parentId },
    };
  }

  const second = segments[1];
  if (segments.length > 2 || second === undefined) {
    return (await redirectFor(tx, path)) ?? { kind: "not-found" };
  }

  const child = await resolveSlug(tx, parentId, second);
  if (!child || child.entityId === null) {
    return (await redirectFor(tx, path)) ?? { kind: "not-found" };
  }

  switch (child.kind) {
    case "category":
      return {
        kind: "pillar",
        scope: { type: "city-category", cityId: parentId, categoryId: child.entityId },
      };
    case "area":
      return {
        kind: "pillar",
        scope: { type: "vertical-area", verticalId: parentId, areaId: child.entityId },
      };
    case "listing":
      return { kind: "listing", listingId: child.entityId, parentId };
    default:
      return { kind: "not-found" };
  }
}
