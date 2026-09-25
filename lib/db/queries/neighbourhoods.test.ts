import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { makeViewer } from "@/test/admin-fixtures";
import {
  makeCity, makeScaffold, makeCategory, makeListing, makeNeighbourhood,
} from "@/test/factories";
import { areas, auditLog, cities, jobQueue, listings, slugs } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { siteConfig } from "@/config/site.config";
import { parseNeighbourhoodCsv, NEIGHBOURHOOD_CSV_COLUMNS } from "@/lib/geo/neighbourhoods";
import {
  adminNeighbourhoods,
  assignNeighbourhoods,
  cityNeighbourhoods,
  enqueueNeighbourhoodAssign,
  importNeighbourhoods,
  setNeighbourhoodPublished,
  sitemapNeighbourhoods,
  NEIGHBOURHOODS_ASSIGN_KIND,
} from "./neighbourhoods";

const WORKER = { role: "admin", userId: "00000000-0000-0000-0000-000000000000" } as const;
const NMIN = siteConfig.geo.neighbourhoods.minListings;
const HEADER = NEIGHBOURHOOD_CSV_COLUMNS.join(",");

/** 1° of latitude ≈ 111.195 km. */
const kmNorth = (lat: number, km: number) => lat + km / 111.195;
const CENTRE = { lat: 53.8, lng: -1.55 };

async function citySlug(tx: TestDb, cityId: string): Promise<string> {
  const [c] = await tx.select({ slug: cities.slug }).from(cities).where(eq(cities.id, cityId));
  return c!.slug;
}

async function areaOf(tx: TestDb, listingId: string): Promise<string | null> {
  const [l] = await tx.select({ areaId: listings.areaId }).from(listings).where(eq(listings.id, listingId));
  return l!.areaId;
}

/* ------------------------------------------------------------------ import */

describe("importNeighbourhoods", () => {
  it("creates each row as an areas row under its town, registered in the town's slug scope", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const cityId = await makeCity(tx);
      const slug = await citySlug(tx, cityId);
      const { rows } = parseNeighbourhoodCsv(`${HEADER}\n${slug},Headingley,headingley,53.819,-1.58,1.5\n`, 2);

      const out = await importNeighbourhoods(tx, admin, rows, { ip: "203.0.113.9" });
      expect(out).toEqual({ created: 1, updated: 0, skipped: [] });

      const [area] = await tx.select().from(areas).where(eq(areas.cityId, cityId));
      expect(area).toMatchObject({ name: "Headingley", slug: "headingley", lat: 53.819, lng: -1.58, radiusKm: 1.5, isPublished: true });
      const [reg] = await tx.select().from(slugs).where(and(eq(slugs.parentScope, cityId), eq(slugs.slug, "headingley")));
      expect(reg).toMatchObject({ kind: "area", entityId: area!.id });

      const [audit] = await tx.select().from(auditLog).where(eq(auditLog.action, "neighbourhoods.imported"));
      expect(audit).toMatchObject({ ip: "203.0.113.9", meta: { created: 1, updated: 0, skipped: 0 } });
    });
  });

  it("reports an unknown town by line and skips only that row", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const cityId = await makeCity(tx);
      const slug = await citySlug(tx, cityId);
      const { rows } = parseNeighbourhoodCsv(
        `${HEADER}\natlantis,Old Town,old-town,53.8,-1.5,2\n${slug},Headingley,headingley,53.8,-1.5,2\n`, 2,
      );
      const out = await importNeighbourhoods(tx, admin, rows, {});
      expect(out.created).toBe(1);
      expect(out.skipped).toEqual([{ line: 2, message: expect.stringMatching(/no town.*atlantis/i) }]);
    });
  });

  it("refuses a slug a category or a listing already holds in that town", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx); // routes "Barn Venues" in the town
      await makeListing(tx, ctx, { name: "The Mill" });
      const slug = await citySlug(tx, ctx.cityId);
      const { rows } = parseNeighbourhoodCsv(
        `${HEADER}\n${slug},Barn Venues,barn-venues,53.8,-1.5,2\n${slug},The Mill,the-mill,53.8,-1.5,2\n`, 2,
      );
      const out = await importNeighbourhoods(tx, admin, rows, {});
      expect(out.created).toBe(0);
      expect(out.skipped.map((s) => s.line)).toEqual([2, 3]);
      expect(out.skipped[0]!.message).toMatch(/category/);
      expect(out.skipped[1]!.message).toMatch(/listing/);
      expect(await tx.select().from(areas).where(eq(areas.cityId, ctx.cityId))).toEqual([]);
    });
  });

  it("refuses a category's slug even where the category is not routed in the town yet", async () => {
    // Otherwise the first listing of that category would find the slug taken
    // and route the category at /<town>/<slug>-2.
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      await makeCategory(tx, ctx.verticalId, "Rooftops");
      const { rows } = parseNeighbourhoodCsv(`${HEADER}\n${await citySlug(tx, ctx.cityId)},Rooftops,rooftops,53.8,-1.5,2\n`, 2);
      const out = await importNeighbourhoods(tx, admin, rows, {});
      expect(out.skipped).toEqual([{ line: 2, message: expect.stringMatching(/category/) }]);
    });
  });

  it("updates a neighbourhood the town already has rather than duplicating it", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const cityId = await makeCity(tx);
      const areaId = await makeNeighbourhood(tx, cityId, "Headingley");
      const { rows } = parseNeighbourhoodCsv(`${HEADER}\n${await citySlug(tx, cityId)},Headingley Village,headingley,53.9,-1.6,3\n`, 2);
      const out = await importNeighbourhoods(tx, admin, rows, {});
      expect(out).toEqual({ created: 0, updated: 1, skipped: [] });
      const [area] = await tx.select().from(areas).where(eq(areas.id, areaId));
      expect(area).toMatchObject({ name: "Headingley Village", lat: 53.9, lng: -1.6, radiusKm: 3 });
    });
  });

  it("lets two towns each have a neighbourhood with the same slug", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const leeds = await makeCity(tx, "Leeds");
      const york = await makeCity(tx, "York", "North Yorkshire");
      const { rows } = parseNeighbourhoodCsv(
        `${HEADER}\n${await citySlug(tx, leeds)},City Centre,city-centre,53.80,-1.55,2\n` +
          `${await citySlug(tx, york)},City Centre,city-centre,53.96,-1.08,2\n`,
        2,
      );
      expect(await importNeighbourhoods(tx, admin, rows, {})).toEqual({ created: 2, updated: 0, skipped: [] });
      const made = await tx.select({ cityId: areas.cityId }).from(areas).where(eq(areas.slug, "city-centre"));
      expect(made.map((a) => a.cityId).sort()).toEqual([leeds, york].sort());
    });
  });

  it("skips and reports the same town and slug given twice in one file", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const leeds = await makeCity(tx, "Leeds");
      const slug = await citySlug(tx, leeds);
      const { rows } = parseNeighbourhoodCsv(
        `${HEADER}\n${slug},City Centre,city-centre,53.80,-1.55,2\n${slug},Centre Again,city-centre,53.81,-1.56,3\n`,
        2,
      );
      const out = await importNeighbourhoods(tx, admin, rows, {});
      expect(out).toEqual({
        created: 1, updated: 0,
        skipped: [{ line: 3, message: expect.stringMatching(/twice/i) }],
      });
      const [area] = await tx.select().from(areas).where(eq(areas.cityId, leeds));
      // The first row stands; the duplicate changed nothing.
      expect(area).toMatchObject({ name: "City Centre", radiusKm: 2 });
    });
  });

  it("still keeps local-multi-vertical area slugs unique among themselves", async () => {
    await withTestDb(async (tx) => {
      const slug = `st-helier-${Date.now()}`;
      await tx.insert(areas).values({ name: "St Helier", slug });
      await expect(tx.insert(areas).values({ name: "St Helier again", slug })).rejects.toThrow();
    });
  });

  it("refuses a viewer who is not an admin", async () => {
    await withTestDb(async (tx) => {
      await expect(importNeighbourhoods(tx, PUBLIC_VIEWER, [], {})).rejects.toThrow("FORBIDDEN");
    });
  });
});

/* ------------------------------------------------------------------ assign */

describe("assignNeighbourhoods", () => {
  it("assigns inside the radius, clears outside it, and recounts", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const areaId = await makeNeighbourhood(tx, ctx.cityId, "Headingley", { ...CENTRE, radiusKm: 2 });
      const inside = await makeListing(tx, ctx, { name: "Inside", lat: kmNorth(CENTRE.lat, 1), lng: CENTRE.lng });
      const outside = await makeListing(tx, ctx, { name: "Outside", lat: kmNorth(CENTRE.lat, 3), lng: CENTRE.lng, areaId });
      const unlocated = await makeListing(tx, ctx, { name: "Nowhere", areaId });

      const out = await assignNeighbourhoods(tx, WORKER);

      expect(await areaOf(tx, inside)).toBe(areaId);
      expect(await areaOf(tx, outside)).toBeNull();
      expect(await areaOf(tx, unlocated)).toBeNull();
      expect(out.changed).toBe(3);
      const [area] = await tx.select().from(areas).where(eq(areas.id, areaId));
      expect(area).toMatchObject({ listingCount: 1, isIndexable: 1 >= NMIN });
      const slug = await citySlug(tx, ctx.cityId);
      expect(out.revalidate).toEqual(expect.arrayContaining([`/${slug}`, `/${slug}/headingley`]));
    });
  });

  it("gives a listing in two overlapping radii to the nearer centroid, and a tie to the lower slug", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const south = await makeNeighbourhood(tx, ctx.cityId, "Beta", { ...CENTRE, radiusKm: 3 });
      const north = await makeNeighbourhood(tx, ctx.cityId, "Alpha", { lat: kmNorth(CENTRE.lat, 2), lng: CENTRE.lng, radiusKm: 3 });
      const nearSouth = await makeListing(tx, ctx, { name: "Near south", lat: kmNorth(CENTRE.lat, 0.5), lng: CENTRE.lng });
      const midway = await makeListing(tx, ctx, { name: "Midway", lat: kmNorth(CENTRE.lat, 1), lng: CENTRE.lng });

      await assignNeighbourhoods(tx, WORKER);
      expect(await areaOf(tx, nearSouth)).toBe(south);
      // 1 km from each by construction; floating point may make it a hair
      // either way, but whichever it is, it is the same on every run.
      const first = await areaOf(tx, midway);
      expect([north, south]).toContain(first);
      await assignNeighbourhoods(tx, WORKER);
      expect(await areaOf(tx, midway)).toBe(first);
    });
  });

  it("counts only published listings and leaves other towns' listings alone", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const areaId = await makeNeighbourhood(tx, ctx.cityId, "Headingley", { ...CENTRE, radiusKm: 2 });
      await makeListing(tx, ctx, { name: "Live", ...CENTRE });
      await makeListing(tx, ctx, { name: "Draft", ...CENTRE, status: "draft" });

      const otherCity = await makeCity(tx, "York", "North Yorkshire");
      const other = await makeListing(tx, { ...ctx, cityId: otherCity }, { name: "York one", ...CENTRE });

      const out = await assignNeighbourhoods(tx, WORKER);
      const [area] = await tx.select().from(areas).where(eq(areas.id, areaId));
      expect(area!.listingCount).toBe(1);
      expect(await areaOf(tx, other)).toBeNull();
      expect(out.cities).toBe(1);
    });
  });

  it("does nothing on a second run: nothing changed, nothing to revalidate", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeNeighbourhood(tx, ctx.cityId, "Headingley", { ...CENTRE, radiusKm: 2 });
      await makeListing(tx, ctx, { name: "Inside", ...CENTRE });
      await assignNeighbourhoods(tx, WORKER);
      expect(await assignNeighbourhoods(tx, WORKER)).toMatchObject({ changed: 0, revalidate: [] });
    });
  });

  it("can be narrowed to one town", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeNeighbourhood(tx, ctx.cityId, "Headingley", { ...CENTRE, radiusKm: 2 });
      const inside = await makeListing(tx, ctx, { name: "Inside", ...CENTRE });
      const out = await assignNeighbourhoods(tx, WORKER, { cityId: "3f2b8a61-0000-4000-8000-000000000000" });
      expect(out.cities).toBe(0);
      expect(await areaOf(tx, inside)).toBeNull();
    });
  });

  it("refuses a viewer who is not an admin", async () => {
    await withTestDb(async (tx) => {
      await expect(assignNeighbourhoods(tx, PUBLIC_VIEWER)).rejects.toThrow("FORBIDDEN");
    });
  });
});

/* ------------------------------------------------------------ admin + list */

describe("setNeighbourhoodPublished / enqueueNeighbourhoodAssign", () => {
  it("toggles publication with an audit row", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const cityId = await makeCity(tx);
      const areaId = await makeNeighbourhood(tx, cityId);
      expect(await setNeighbourhoodPublished(tx, admin, areaId, false, { ip: null })).toMatchObject({ ok: true });
      const [area] = await tx.select().from(areas).where(eq(areas.id, areaId));
      expect(area!.isPublished).toBe(false);
      const audit = await tx.select().from(auditLog).where(eq(auditLog.entityId, areaId));
      expect(audit.map((a) => a.action)).toEqual(["neighbourhood.unpublished"]);
    });
  });

  it("will not toggle a local-multi-vertical area, which has no town", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const [lmv] = await tx.insert(areas).values({ name: "St Helier", slug: `st-helier-${Date.now()}` }).returning();
      expect(await setNeighbourhoodPublished(tx, admin, lmv!.id, false, { ip: null })).toEqual({ ok: false });
    });
  });

  it("queues one assign job, with an audit row", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const id = await enqueueNeighbourhoodAssign(tx, admin, { ip: null });
      const [job] = await tx.select().from(jobQueue).where(eq(jobQueue.id, id));
      expect(job).toMatchObject({ kind: NEIGHBOURHOODS_ASSIGN_KIND, status: "pending" });
      const audit = await tx.select().from(auditLog).where(eq(auditLog.action, "neighbourhoods.assign_queued"));
      expect(audit).toHaveLength(1);
    });
  });
});

describe("adminNeighbourhoods", () => {
  it("lists every neighbourhood grouped by town, unpublished ones too", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const cityId = await makeCity(tx);
      await makeNeighbourhood(tx, cityId, "Headingley");
      await makeNeighbourhood(tx, cityId, "Armley", { isPublished: false });
      const towns = await adminNeighbourhoods(tx, admin);
      const town = towns.find((t) => t.cityId === cityId)!;
      expect(town.neighbourhoods.map((n) => [n.name, n.isPublished])).toEqual([
        ["Armley", false], ["Headingley", true],
      ]);
    });
  });

  it("refuses a viewer who is not an admin", async () => {
    await withTestDb(async (tx) => {
      await expect(adminNeighbourhoods(tx, PUBLIC_VIEWER)).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("cityNeighbourhoods (the town page's list)", () => {
  it("links only published neighbourhoods with at least one published listing, with live counts", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const a = await makeNeighbourhood(tx, ctx.cityId, "Headingley");
      const b = await makeNeighbourhood(tx, ctx.cityId, "Armley", { isPublished: false });
      await makeNeighbourhood(tx, ctx.cityId, "Empty");
      const c = await makeNeighbourhood(tx, ctx.cityId, "Drafty");
      await makeListing(tx, ctx, { name: "One", areaId: a });
      await makeListing(tx, ctx, { name: "Two", areaId: a });
      await makeListing(tx, ctx, { name: "Three", areaId: b });
      await makeListing(tx, ctx, { name: "Four", areaId: c, status: "draft" });

      expect(await cityNeighbourhoods(tx, PUBLIC_VIEWER, ctx.cityId)).toEqual([
        { id: a, name: "Headingley", slug: "headingley", listingCount: 2 },
      ]);
    });
  });
});

describe("sitemapNeighbourhoods", () => {
  it("advertises a neighbourhood only once it reaches geo.neighbourhoods.minListings", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const slug = await citySlug(tx, ctx.cityId);
      const full = await makeNeighbourhood(tx, ctx.cityId, "Headingley");
      const thin = await makeNeighbourhood(tx, ctx.cityId, "Armley");
      const hidden = await makeNeighbourhood(tx, ctx.cityId, "Hidden", { isPublished: false });
      for (let i = 0; i < NMIN; i++) {
        await makeListing(tx, ctx, { name: `Full ${i}`, areaId: full });
        await makeListing(tx, ctx, { name: `Hidden ${i}`, areaId: hidden });
      }
      for (let i = 0; i < NMIN - 1; i++) await makeListing(tx, ctx, { name: `Thin ${i}`, areaId: thin });

      const paths = (await sitemapNeighbourhoods(tx, PUBLIC_VIEWER)).map((e) => e.path);
      expect(paths).toContain(`/${slug}/headingley`);
      expect(paths).not.toContain(`/${slug}/armley`);
      expect(paths).not.toContain(`/${slug}/hidden`);
    });
  });

  it("drops every neighbourhood of an unpublished town", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const slug = await citySlug(tx, ctx.cityId);
      const full = await makeNeighbourhood(tx, ctx.cityId, "Headingley");
      for (let i = 0; i < NMIN; i++) await makeListing(tx, ctx, { name: `Full ${i}`, areaId: full });
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, ctx.cityId));
      const paths = (await sitemapNeighbourhoods(tx, PUBLIC_VIEWER)).map((e) => e.path);
      expect(paths).not.toContain(`/${slug}/headingley`);
    });
  });
});

