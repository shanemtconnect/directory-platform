import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { auditLog, cities } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeViewer } from "@/test/admin-fixtures";
import { makeScaffold, makeListing } from "@/test/factories";
import {
  adminCities,
  introHtmlFromText,
  saveCityIntro,
  setCityPublished,
} from "./cities";

async function readCity(tx: TestDb, id: string) {
  const [row] = await tx.select().from(cities).where(eq(cities.id, id)).limit(1);
  return row;
}

describe("introHtmlFromText", () => {
  it("wraps each blank-line-separated block in its own paragraph", () => {
    expect(introHtmlFromText("One.\n\nTwo.")).toBe("<p>One.</p>\n<p>Two.</p>");
  });

  it("escapes the text rather than accepting markup from the form", () => {
    expect(introHtmlFromText('<script>alert("x")</script>')).toBe(
      "<p>&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;</p>",
    );
  });

  it("keeps a single newline inside a paragraph as a space", () => {
    expect(introHtmlFromText("One line\nnext line")).toBe("<p>One line next line</p>");
  });

  it("is null for nothing, so the gate reads it as no intro copy at all", () => {
    expect(introHtmlFromText("")).toBeNull();
    expect(introHtmlFromText("   \n\n  ")).toBeNull();
  });
});

describe("adminCities", () => {
  it("reports the count, the flags, who made it and whether copy exists", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "Live One" });

      const rows = await adminCities(tx, admin);
      const leeds = rows.find((r) => r.id === ctx.cityId);
      expect(leeds?.name).toBe("Leeds");
      expect(leeds?.createdBy).toBe("seed");
      expect(leeds?.isPublished).toBe(true);
      expect(leeds?.isIndexable).toBe(false);
      expect(leeds?.hasIntro).toBe(false);
      // The stored column, which only a recompute updates.
      expect(leeds?.listingCount).toBe(0);
    });
  });

  it("refuses anyone who is not an admin", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeViewer(tx, "owner");
      await expect(adminCities(tx, owner)).rejects.toThrow("FORBIDDEN");
      await expect(adminCities(tx, PUBLIC_VIEWER)).rejects.toThrow("FORBIDDEN");
    });
  });
});

describe("saveCityIntro", () => {
  it("stores escaped paragraphs and opens the gate once the threshold is met", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "One" });
      await makeListing(tx, ctx, { name: "Two" });
      await makeListing(tx, ctx, { name: "Three" });

      const result = await saveCityIntro(tx, admin, ctx.cityId, "Leeds & the rest.", { ip: null });
      expect(result).toEqual({ outcome: "saved", listingCount: 3, isIndexable: true });

      const city = await readCity(tx, ctx.cityId);
      expect(city?.introHtml).toBe("<p>Leeds &amp; the rest.</p>");
      expect(city?.isIndexable).toBe(true);
    });
  });

  it("will not open the gate on copy alone", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "Only One" });

      const result = await saveCityIntro(tx, admin, ctx.cityId, "Some copy.", { ip: null });
      expect(result).toEqual({ outcome: "saved", listingCount: 1, isIndexable: false });
    });
  });

  it("clearing the copy closes the gate again", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "One" });
      await makeListing(tx, ctx, { name: "Two" });
      await makeListing(tx, ctx, { name: "Three" });
      await saveCityIntro(tx, admin, ctx.cityId, "Some copy.", { ip: null });

      const result = await saveCityIntro(tx, admin, ctx.cityId, "  ", { ip: null });
      expect(result).toEqual({ outcome: "saved", listingCount: 3, isIndexable: false });
      expect((await readCity(tx, ctx.cityId))?.introHtml).toBeNull();
    });
  });

  it("audits the save against the city", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);

      await saveCityIntro(tx, admin, ctx.cityId, "Some copy.", { ip: "203.0.113.4" });

      const [row] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, ctx.cityId), eq(auditLog.action, "city.intro_saved")))
        .limit(1);
      expect(row?.entityType).toBe("city");
      expect(row?.actorId).not.toBeNull();
      expect(row?.ip).toBe("203.0.113.4");
      expect(row?.meta).toMatchObject({ hasIntro: true, isIndexable: false });
    });
  });

  it("reports a city that is not there", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const result = await saveCityIntro(
        tx,
        admin,
        "11111111-1111-4111-8111-111111111111",
        "Copy.",
        { ip: null },
      );
      expect(result).toEqual({ outcome: "unknown-city" });
    });
  });

  it("refuses anyone who is not an admin, and changes nothing", async () => {
    await withTestDb(async (tx) => {
      const owner = await makeViewer(tx, "owner");
      const ctx = await makeScaffold(tx);
      await expect(saveCityIntro(tx, owner, ctx.cityId, "Copy.", { ip: null })).rejects.toThrow(
        "FORBIDDEN",
      );
      expect((await readCity(tx, ctx.cityId))?.introHtml).toBeNull();
      expect(await tx.select().from(auditLog)).toHaveLength(0);
    });
  });
});

describe("setCityPublished", () => {
  it("toggles the flag, recomputes the gate and audits it", async () => {
    await withTestDb(async (tx) => {
      const admin = await makeViewer(tx);
      const ctx = await makeScaffold(tx);

      const result = await setCityPublished(tx, admin, ctx.cityId, false, { ip: null });
      expect(result).toEqual({ outcome: "saved", listingCount: 0, isIndexable: false });
      expect((await readCity(tx, ctx.cityId))?.isPublished).toBe(false);

      const [row] = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, ctx.cityId), eq(auditLog.action, "city.unpublished")))
        .limit(1);
      expect(row?.entityType).toBe("city");

      await setCityPublished(tx, admin, ctx.cityId, true, { ip: null });
      expect((await readCity(tx, ctx.cityId))?.isPublished).toBe(true);
      const published = await tx
        .select()
        .from(auditLog)
        .where(and(eq(auditLog.entityId, ctx.cityId), eq(auditLog.action, "city.published")));
      expect(published).toHaveLength(1);
    });
  });

  it("refuses anyone who is not an admin", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await expect(
        setCityPublished(tx, PUBLIC_VIEWER, ctx.cityId, false, { ip: null }),
      ).rejects.toThrow("FORBIDDEN");
    });
  });
});
