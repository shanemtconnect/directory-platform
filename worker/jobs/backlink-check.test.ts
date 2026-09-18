import { describe, it, expect, expectTypeOf, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { badges, cities, listings } from "@/lib/db/schema";
import { makeListing, makeScaffold } from "@/test/factories";
import { BACKLINK_RANK_BOOST } from "@/lib/db/queries/badges";
import type { BacklinkFetch, Resolver } from "@/lib/badge/backlink";
import { checkBadgeBacklinks, backlinkTargets, type BacklinkCheckDeps } from "./backlink-check";

const PUBLIC_DNS: Resolver = async () => ["93.184.216.34"];

/** A fetch stand-in that answers with the HTML mapped to the URL it is given. */
function pages(map: Record<string, string>): typeof fetch {
  return (async (url: string) => {
    const html = map[url];
    if (html === undefined) return new Response("gone", { status: 404 });
    return new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });
  }) as unknown as typeof fetch;
}

describe("backlinkTargets", () => {
  it("accepts the canonical listing URL or the site root", () => {
    const targets = backlinkTargets({ citySlug: "leeds", listingSlug: "the-old-mill" });
    expect(targets.some((t) => t.endsWith("/leeds/the-old-mill"))).toBe(true);
    // A site-wide "listed on X" footer link is a real backlink too.
    expect(targets.some((t) => new URL(t).pathname === "/")).toBe(true);
  });
});

describe("checkBadgeBacklinks", () => {
  it("verifies a badge whose page links back, and awards the boost", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Mill" });
      await tx.insert(badges).values({ listingId, backlinkUrl: "https://client.example/about" });
      const targets = backlinkTargets({ citySlug: "leeds", listingSlug: "the-old-mill" });

      const report = await checkBadgeBacklinks(tx, {
        resolve: PUBLIC_DNS,
        fetchImpl: pages({
          "https://client.example/about": `<a href="${targets[0]}">us</a>`,
        }),
      });

      expect(report).toMatchObject({ checked: 1, verified: 1, failed: 0 });
      // A boost granted changes the ranking on every cached page the listing
      // sits on — its own, its reviews page, the town and the pillar inside
      // it; the scheduler revalidates them once this transaction has committed.
      const [city] = await tx.select({ slug: cities.slug }).from(cities).where(eq(cities.id, ctx.cityId));
      expect(report.revalidate).toEqual([
        `/${city!.slug}/the-old-mill`,
        `/${city!.slug}/the-old-mill/reviews`,
        `/${city!.slug}`,
        `/${city!.slug}/barn-venues`,
      ]);
      const [badge] = await tx.select().from(badges).where(eq(badges.listingId, listingId));
      expect(badge?.backlinkVerified).toBe(true);
      expect(badge?.lastCheckedAt).not.toBeNull();
      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.backlinkBoost).toBe(BACKLINK_RANK_BOOST);
    });
  });

  it("un-verifies and takes the boost back when the link is gone", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "The Old Mill", backlinkBoost: 5 });
      await tx.insert(badges).values({
        listingId,
        backlinkUrl: "https://client.example/about",
        backlinkVerified: true,
        lastCheckedAt: new Date("2020-01-01T00:00:00Z"),
      });

      const report = await checkBadgeBacklinks(tx, {
        resolve: PUBLIC_DNS,
        fetchImpl: pages({ "https://client.example/about": "<p>redesigned, no link</p>" }),
      });

      expect(report).toMatchObject({ checked: 1, verified: 0, failed: 1 });
      expect(report.revalidate).toHaveLength(4);
      const [listing] = await tx.select().from(listings).where(eq(listings.id, listingId));
      expect(listing?.backlinkBoost).toBe(0);
    });
  });

  it("names no pages when the check changes nothing — a still-dead link is not a stale page", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "Still Dead" });
      await tx.insert(badges).values({ listingId, backlinkUrl: "https://client.example/about" });

      const report = await checkBadgeBacklinks(tx, {
        resolve: PUBLIC_DNS,
        fetchImpl: pages({ "https://client.example/about": "<p>no link</p>" }),
      });

      expect(report).toMatchObject({ checked: 1, verified: 0, failed: 1, revalidate: [] });
    });
  });

  it("refuses a private backlink URL without fetching it", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const listingId = await makeListing(tx, ctx, { name: "Sneaky" });
      await tx.insert(badges).values({
        listingId,
        backlinkUrl: "http://169.254.169.254/latest/meta-data/",
      });
      const fetchImpl = vi.fn();

      const report = await checkBadgeBacklinks(tx, {
        resolve: PUBLIC_DNS,
        fetchImpl: fetchImpl as unknown as BacklinkFetch,
      });

      expect(fetchImpl).not.toHaveBeenCalled();
      expect(report).toMatchObject({ checked: 1, verified: 0, failed: 1 });
      const [badge] = await tx.select().from(badges).where(eq(badges.listingId, listingId));
      // Still stamped, or the job retries this for ever.
      expect(badge?.lastCheckedAt).not.toBeNull();
      expect(badge?.backlinkVerified).toBe(false);
    });
  });

  it("carries on after one badge's site fails", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const bad = await makeListing(tx, ctx, { name: "Down Site" });
      const good = await makeListing(tx, ctx, { name: "Up Site" });
      await tx.insert(badges).values([
        { listingId: bad, backlinkUrl: "https://down.example/" },
        { listingId: good, backlinkUrl: "https://up.example/" },
      ]);
      const targets = backlinkTargets({ citySlug: "leeds", listingSlug: "up-site" });

      const fetchImpl = (async (url: string) => {
        if (url.startsWith("https://down.example")) throw new Error("connect ECONNREFUSED");
        return new Response(`<a href="${targets[0]}">us</a>`, { status: 200 });
      }) as unknown as typeof fetch;

      const report = await checkBadgeBacklinks(tx, { resolve: PUBLIC_DNS, fetchImpl });

      expect(report).toMatchObject({ checked: 2, verified: 1, failed: 1 });
    });
  });

  it("does nothing when nothing is due", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      const fetchImpl = vi.fn();
      const report = await checkBadgeBacklinks(tx, {
        resolve: PUBLIC_DNS,
        fetchImpl: fetchImpl as unknown as BacklinkFetch,
      });
      expect(report).toMatchObject({ checked: 0, verified: 0, failed: 0 });
      expect(fetchImpl).not.toHaveBeenCalled();
    });
  });
});

describe("BacklinkCheckDeps", () => {
  /**
   * The job's fetch hook is the pinned type from lib/badge/backlink.ts, not
   * the global one. `typeof fetch` would type-check a caller passing Node's
   * bundled fetch, which ignores an npm-undici Agent and so would skip the
   * dispatcher the DNS pin lives in. Enforced by `tsc`, which the suite runs
   * under; the assertion is a no-op at runtime.
   */
  it("types fetchImpl as BacklinkFetch, the same as checkBacklink's own deps", () => {
    expectTypeOf<BacklinkCheckDeps["fetchImpl"]>().toEqualTypeOf<BacklinkFetch | undefined>();
    expectTypeOf<BacklinkCheckDeps["fetchImpl"]>().not.toEqualTypeOf<typeof fetch | undefined>();
  });
});
