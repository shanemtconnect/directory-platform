import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { auditLog, categories, cities, listings } from "@/lib/db/schema";
import { PUBLIC_VIEWER, type Viewer } from "@/lib/db/viewer";
import { makeScaffold, makeCategoryInCity, makeCity, makeListing } from "@/test/factories";
import {
  PARKED_SUBMISSION_ACTION,
  createSubmission,
  findSubmissionDuplicate,
  resolveSubmittedCity,
  setListingStatus,
  submissionOptions,
  type SubmissionInput,
} from "./submissions";

const ADMIN: Viewer = { role: "admin", userId: "00000000-0000-4000-8000-00000000adm1" };

function input(patch: Partial<SubmissionInput> = {}): SubmissionInput {
  return {
    name: "The Old Mill",
    categoryId: "",
    region: "West Yorkshire",
    city: "Leeds",
    addressLine1: "1 Mill Lane",
    postcode: "LS1 4DY",
    phone: "01632 960000",
    website: "https://example.co.uk",
    description: "A long enough description of the business to clear the minimum length check.",
    submitterName: "Sam Owner",
    submitterEmail: "sam@example.co.uk",
    requestedTier: "premium",
    ip: "203.0.113.5",
    ...patch,
  };
}

async function readListing(tx: TestDb, id: string) {
  const [row] = await tx.select().from(listings).where(eq(listings.id, id)).limit(1);
  return row;
}

describe("createSubmission", () => {
  it("files a pending, public, unclaimed listing that is not live", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const result = await createSubmission(tx, PUBLIC_VIEWER, input({ categoryId: ctx.primaryCategoryId }));

      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;

      const row = await readListing(tx, result.listingId);
      expect(row?.status).toBe("pending");
      expect(row?.source).toBe("public");
      expect(row?.claimStatus).toBe("unclaimed");
      expect(row?.publishedAt).toBeNull();
      expect(row?.cityId).toBe(ctx.cityId);
      expect(row?.verticalId).toBe(ctx.verticalId);
      expect(row?.slug).toBe("the-old-mill");
    });
  });

  it("never sets a rating or a verified state from a form", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const result = await createSubmission(tx, PUBLIC_VIEWER, input({ categoryId: ctx.primaryCategoryId }));
      if (result.outcome !== "created") throw new Error("expected a created listing");

      const row = await readListing(tx, result.listingId);
      expect(row?.ratingAvg).toBeNull();
      expect(row?.ratingCount).toBe(0);
      expect(row?.verifiedAt).toBeNull();
      expect(row?.verifiedExpiresAt).toBeNull();
    });
  });

  it("records the requested tier but leaves the listing on free", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const result = await createSubmission(
        tx,
        PUBLIC_VIEWER,
        input({ categoryId: ctx.primaryCategoryId, requestedTier: "premium" }),
      );
      if (result.outcome !== "created") throw new Error("expected a created listing");

      const row = await readListing(tx, result.listingId);
      expect(row?.tier).toBe("free");
      const custom = row?.customFields as { submission?: { requestedTier?: string } } | null;
      expect(custom?.submission?.requestedTier).toBe("premium");
    });
  });

  it("keeps the submitter's email off the published contact details", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const result = await createSubmission(tx, PUBLIC_VIEWER, input({ categoryId: ctx.primaryCategoryId }));
      if (result.outcome !== "created") throw new Error("expected a created listing");

      const row = await readListing(tx, result.listingId);
      expect(row?.submittedByEmail).toBe("sam@example.co.uk");
      expect(row?.email).toBeNull();
    });
  });

  it("does not create a city for an unknown town — it parks the submission", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const before = await tx.select({ id: cities.id }).from(cities);

      const result = await createSubmission(
        tx,
        PUBLIC_VIEWER,
        input({ categoryId: ctx.primaryCategoryId, city: "Otley", region: "West Yorkshire" }),
      );

      expect(result.outcome).toBe("parked");
      const after = await tx.select({ id: cities.id }).from(cities);
      expect(after).toHaveLength(before.length);
      expect(await tx.select({ id: listings.id }).from(listings)).toHaveLength(0);
    });
  });

  it("keeps the parked submission readable, with the town as typed", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const result = await createSubmission(
        tx,
        PUBLIC_VIEWER,
        input({ categoryId: ctx.primaryCategoryId, city: "Otley" }),
      );
      if (result.outcome !== "parked") throw new Error("expected a parked submission");

      const [row] = await tx
        .select()
        .from(auditLog)
        .where(eq(auditLog.id, result.parkedId))
        .limit(1);
      expect(row?.action).toBe(PARKED_SUBMISSION_ACTION);
      expect(row?.entityType).toBe("listing_submission");
      expect(row?.ip).toBe("203.0.113.5");
      const meta = row?.meta as { submittedCity?: string; listing?: { name?: string } } | null;
      expect(meta?.submittedCity).toBe("Otley");
      expect(meta?.listing?.name).toBe("The Old Mill");
    });
  });

  it("rejects a category that is not on the taxonomy", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      const result = await createSubmission(
        tx,
        PUBLIC_VIEWER,
        input({ categoryId: "00000000-0000-0000-0000-000000000000" }),
      );
      expect(result.outcome).toBe("unknown-category");
    });
  });

  it("rejects an inactive category rather than filing under it", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx
        .update(categories)
        .set({ isActive: false })
        .where(eq(categories.id, ctx.primaryCategoryId));

      const result = await createSubmission(tx, PUBLIC_VIEWER, input({ categoryId: ctx.primaryCategoryId }));
      expect(result.outcome).toBe("unknown-category");
    });
  });

  it("disambiguates two towns of the same name by region", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const other = await makeCity(tx, "Newport", "Isle of Wight");
      await makeCity(tx, "Newport", "Pembrokeshire");
      await makeCategoryInCity(tx, ctx.verticalId, other, "Barn Halls");

      const result = await createSubmission(
        tx,
        PUBLIC_VIEWER,
        input({ categoryId: ctx.primaryCategoryId, city: "newport", region: "Isle of Wight" }),
      );
      if (result.outcome !== "created") throw new Error("expected a created listing");

      const row = await readListing(tx, result.listingId);
      expect(row?.cityId).toBe(other);
    });
  });
});

describe("resolveSubmittedCity", () => {
  it("matches regardless of case and surrounding space", async () => {
    await withTestDb(async (tx) => {
      const { cityId } = await makeScaffold(tx);
      expect(await resolveSubmittedCity(tx, "  lEEds ", "West Yorkshire")).toBe(cityId);
    });
  });

  it("returns null for an unknown town", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      expect(await resolveSubmittedCity(tx, "Otley", "West Yorkshire")).toBeNull();
    });
  });

  it("returns null when the name is ambiguous and no region is given", async () => {
    await withTestDb(async (tx) => {
      await makeCity(tx, "Newport", "Isle of Wight");
      await makeCity(tx, "Newport", "Pembrokeshire");
      expect(await resolveSubmittedCity(tx, "Newport", null)).toBeNull();
    });
  });
});

describe("findSubmissionDuplicate", () => {
  it("finds a published listing by name and postcode, with its canonical path", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const existing = await makeListing(tx, ctx, {
        name: "The Old Mill",
        postcode: "LS1 4DY",
        phone: null,
      });

      const hit = await findSubmissionDuplicate(tx, PUBLIC_VIEWER, input());
      expect(hit).toEqual({
        kind: "match",
        listingId: existing,
        name: "The Old Mill",
        slug: "the-old-mill",
        citySlug: "leeds",
        reason: "matching name and postcode",
      });
    });
  });

  it("finds a duplicate on a phone number punctuated differently", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const existing = await makeListing(tx, ctx, {
        name: "A Different Trading Name",
        postcode: "LS9 9ZZ",
        phone: "(01632) 960-000",
      });

      // Same digits, different punctuation. A leading +44 in place of the 0 is
      // NOT matched: normalisePhone strips punctuation, it does not dial-code
      // normalise, so that pair reaches admin review instead.
      const hit = await findSubmissionDuplicate(
        tx,
        PUBLIC_VIEWER,
        input({ name: "The Old Mill", phone: "01632 960000" }),
      );
      expect(hit).toMatchObject({ kind: "match", listingId: existing, reason: "matching phone" });
    });
  });

  it("returns null when nothing matches", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "Somewhere Else", postcode: "LS9 9ZZ", phone: "01632 960111" });

      expect(await findSubmissionDuplicate(tx, PUBLIC_VIEWER, input())).toBeNull();
    });
  });

  it("tells the public a match is pending without naming it", async () => {
    await withTestDb(async (tx) => {
      // Otherwise the form is a lookup tool: type a phone number, read back
      // the name and slug of a listing nobody is allowed to see yet.
      const ctx = await makeScaffold(tx);
      const existing = await makeListing(tx, ctx, {
        name: "The Old Mill",
        postcode: "LS1 4DY",
        phone: null,
      });
      await tx.update(listings).set({ status: "pending" }).where(eq(listings.id, existing));

      expect(await findSubmissionDuplicate(tx, PUBLIC_VIEWER, input())).toEqual({
        kind: "pending",
      });
    });
  });

  it("says nothing about a removed listing either", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const existing = await makeListing(tx, ctx, {
        name: "The Old Mill",
        postcode: "LS1 4DY",
        phone: null,
      });
      await tx.update(listings).set({ status: "removed" }).where(eq(listings.id, existing));

      expect(await findSubmissionDuplicate(tx, PUBLIC_VIEWER, input())).toEqual({
        kind: "pending",
      });
    });
  });

  it("gives an admin the details of an unpublished match", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const existing = await makeListing(tx, ctx, {
        name: "The Old Mill",
        postcode: "LS1 4DY",
        phone: null,
      });
      await tx.update(listings).set({ status: "pending" }).where(eq(listings.id, existing));

      expect(await findSubmissionDuplicate(tx, ADMIN, input())).toMatchObject({
        kind: "match",
        name: "The Old Mill",
      });
    });
  });
});

describe("submissionOptions", () => {
  it("offers active categories and the regions we hold", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const retired = await makeCategoryInCity(tx, ctx.verticalId, ctx.cityId, "Retired Type");
      await tx.update(categories).set({ isActive: false }).where(eq(categories.id, retired));

      const options = await submissionOptions(tx, PUBLIC_VIEWER);
      expect(options.categories.map((c) => c.name)).toContain("Barn Venues");
      expect(options.categories.map((c) => c.name)).not.toContain("Retired Type");
      expect(options.regions).toContain("West Yorkshire");
    });
  });

  it("does not offer a region only unpublished cities sit in", async () => {
    await withTestDb(async (tx) => {
      await makeScaffold(tx);
      const hidden = await makeCity(tx, "Hidden Town", "Rutland");
      await tx.update(cities).set({ isPublished: false }).where(eq(cities.id, hidden));

      const options = await submissionOptions(tx, PUBLIC_VIEWER);
      expect(options.regions).not.toContain("Rutland");
      expect(options.regions).toContain("West Yorkshire");
    });
  });
});


/**
 * Global constraint 9. The gate is the difference between a directory Google
 * indexes and one it ignores, and nothing outside the seed and the importer
 * used to move it — a listing could go live and leave its city noindexed with
 * nothing to trigger a retry.
 */
describe("setListingStatus and the indexing gate", () => {
  const INTRO = "<p>Leeds has a good spread of places.</p>";

  async function cityRow(tx: TestDb, cityId: string) {
    const [row] = await tx
      .select({ isIndexable: cities.isIndexable, listingCount: cities.listingCount })
      .from(cities)
      .where(eq(cities.id, cityId))
      .limit(1);
    return row;
  }

  it("flips is_indexable when the third listing in a city is published", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(cities).set({ introHtml: INTRO }).where(eq(cities.id, ctx.cityId));

      await makeListing(tx, ctx, { status: "published" });
      await makeListing(tx, ctx, { status: "published" });
      const third = await makeListing(tx, ctx, { status: "pending" });

      // Two published listings is one short of siteConfig.seo.minListingsToIndex.
      await setListingStatus(tx, ADMIN, third, "archived");
      expect(await cityRow(tx, ctx.cityId)).toMatchObject({ isIndexable: false, listingCount: 2 });

      const result = await setListingStatus(tx, ADMIN, third, "published");
      expect(result).toMatchObject({ outcome: "changed", from: "archived", to: "published" });
      expect(await cityRow(tx, ctx.cityId)).toMatchObject({ isIndexable: true, listingCount: 3 });
    });
  });

  it("keeps the gate shut when the city has no intro copy", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { status: "published" });
      await makeListing(tx, ctx, { status: "published" });
      const third = await makeListing(tx, ctx, { status: "pending" });

      await setListingStatus(tx, ADMIN, third, "published");
      expect(await cityRow(tx, ctx.cityId)).toMatchObject({ isIndexable: false, listingCount: 3 });
    });
  });

  it("closes the gate again when a listing is taken down", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(cities).set({ introHtml: INTRO }).where(eq(cities.id, ctx.cityId));
      await makeListing(tx, ctx, { status: "published" });
      await makeListing(tx, ctx, { status: "published" });
      const third = await makeListing(tx, ctx, { status: "published" });
      await setListingStatus(tx, ADMIN, third, "published");
      expect(await cityRow(tx, ctx.cityId)).toMatchObject({ isIndexable: true });

      await setListingStatus(tx, ADMIN, third, "removed");
      expect(await cityRow(tx, ctx.cityId)).toMatchObject({ isIndexable: false, listingCount: 2 });
    });
  });

  it("stamps published_at once and does not rewrite it on a republish", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, { status: "pending", publishedAt: null });

      await setListingStatus(tx, ADMIN, id, "published");
      const first = (await readListing(tx, id))?.publishedAt;
      expect(first).not.toBeNull();

      await setListingStatus(tx, ADMIN, id, "archived");
      await setListingStatus(tx, ADMIN, id, "published");
      expect((await readListing(tx, id))?.publishedAt).toEqual(first);
    });
  });

  it("is admin only, and says so without touching the row", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const id = await makeListing(tx, ctx, { status: "pending" });

      expect(await setListingStatus(tx, PUBLIC_VIEWER, id, "published"))
        .toEqual({ outcome: "forbidden" });
      expect((await readListing(tx, id))?.status).toBe("pending");
    });
  });

  it("reports an unknown listing rather than silently succeeding", async () => {
    await withTestDb(async (tx) => {
      expect(await setListingStatus(tx, ADMIN, "00000000-0000-4000-8000-0000000000ff", "published"))
        .toEqual({ outcome: "unknown-listing" });
    });
  });

  it("recomputes the city on a submission too, so a filed row cannot skip the gate", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await tx.update(cities).set({ introHtml: INTRO, listingCount: 99, isIndexable: true })
        .where(eq(cities.id, ctx.cityId));
      await makeListing(tx, ctx, { status: "published" });

      await createSubmission(tx, PUBLIC_VIEWER, input({ categoryId: ctx.primaryCategoryId }));

      // The stale count is corrected and the gate closes: one published
      // listing, and a pending submission is not a published listing.
      expect(await cityRow(tx, ctx.cityId)).toMatchObject({ isIndexable: false, listingCount: 1 });
    });
  });
});
