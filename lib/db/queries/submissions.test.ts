import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { auditLog, categories, cities, listings } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { makeScaffold, makeCategoryInCity, makeCity, makeListing } from "@/test/factories";
import {
  PARKED_SUBMISSION_ACTION,
  createSubmission,
  findSubmissionDuplicate,
  resolveSubmittedCity,
  submissionOptions,
  type SubmissionInput,
} from "./submissions";

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
      const result = await createSubmission(tx, input({ categoryId: ctx.primaryCategoryId }));

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
      const result = await createSubmission(tx, input({ categoryId: ctx.primaryCategoryId }));
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
      const result = await createSubmission(tx, input({ categoryId: ctx.primaryCategoryId }));
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

      const result = await createSubmission(tx, input({ categoryId: ctx.primaryCategoryId }));
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
  it("finds an existing listing by name and postcode, with a claim slug", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      const existing = await makeListing(tx, ctx, {
        name: "The Old Mill",
        postcode: "LS1 4DY",
        phone: null,
      });

      const hit = await findSubmissionDuplicate(tx, input());
      expect(hit?.listingId).toBe(existing);
      expect(hit?.slug).toBe("the-old-mill");
      expect(hit?.reason).toBe("matching name and postcode");
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
        input({ name: "The Old Mill", phone: "01632 960000" }),
      );
      expect(hit?.listingId).toBe(existing);
      expect(hit?.reason).toBe("matching phone");
    });
  });

  it("returns null when nothing matches", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { name: "Somewhere Else", postcode: "LS9 9ZZ", phone: "01632 960111" });

      expect(await findSubmissionDuplicate(tx, input())).toBeNull();
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
