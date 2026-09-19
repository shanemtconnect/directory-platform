import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { withTestDb, type TestDb } from "@/test/db";
import { makeListing, makeScaffold } from "@/test/factories";
import { auditLog, enquiries, listings, profiles, user } from "@/lib/db/schema";
import { resetClock, setClock } from "@/lib/clock";
import type { Viewer } from "@/lib/db/viewer";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { listingPaths } from "./paths";
import {
  markEnquiryHandled,
  ownerEnquiries,
  ownerListing,
  ownerListings,
  updateOwnerListing,
} from "./owner";

afterEach(() => resetClock());

async function owner(tx: TestDb, role: "user" | "owner" | "admin" = "owner") {
  const userId = `u_${randomUUID()}`;
  await tx.insert(user).values({
    id: userId, name: "Jo", email: `${userId}@example.test`, emailVerified: true,
  });
  const [profile] = await tx.insert(profiles).values({ userId, role }).returning({ id: profiles.id });
  return { userId, profileId: profile!.id, viewer: { role, userId } as Viewer };
}

async function owned(tx: TestDb, patch: Record<string, unknown> = {}) {
  const ctx = await makeScaffold(tx);
  const jo = await owner(tx);
  const listingId = await makeListing(tx, ctx, {
    name: "The Old Mill", ownerId: jo.profileId, claimStatus: "claimed", ...patch,
  });
  return { ...jo, listingId, ctx };
}

describe("ownerListings", () => {
  it("returns only the listings this viewer's profile owns", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const stranger = await owner(tx);
      await makeListing(tx, jo.ctx, { name: "Someone Else", ownerId: stranger.profileId });
      await makeListing(tx, jo.ctx, { name: "Nobody's" });

      const mine = await ownerListings(tx, jo.viewer);
      expect(mine.map((l) => l.name)).toEqual(["The Old Mill"]);
      expect(mine[0]?.path).toMatch(/^\/[a-z0-9-]+\/the-old-mill$/);
    });
  });

  it("gives an anonymous viewer nothing rather than everything", async () => {
    await withTestDb(async (tx) => {
      await owned(tx);
      await expect(ownerListings(tx, { role: "public" })).rejects.toThrow(/FORBIDDEN/);
    });
  });

  it("gives an admin their OWN listings, not every listing on the site", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const admin = await owner(tx, "admin");
      expect(await ownerListings(tx, admin.viewer)).toHaveLength(0);
      expect(await ownerListings(tx, jo.viewer)).toHaveLength(1);
    });
  });

  it("still lists a listing whose status has moved away from published", async () => {
    await withTestDb(async (tx) => {
      // An owner whose listing is under review must still see it, or the
      // dashboard tells them their business has vanished.
      const jo = await owned(tx, { status: "pending" });
      expect(await ownerListings(tx, jo.viewer)).toHaveLength(1);
    });
  });
});

describe("ownerListing", () => {
  it("returns the editable fields for a listing the viewer owns", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx, { phone: "01632 960000", description: "A mill." });
      const row = await ownerListing(tx, jo.viewer, jo.listingId);
      expect(row?.phone).toBe("01632 960000");
      expect(row?.description).toBe("A mill.");
    });
  });

  it("returns null for somebody else's listing — the caller renders a 404", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const stranger = await owner(tx);
      expect(await ownerListing(tx, stranger.viewer, jo.listingId)).toBeNull();
    });
  });

  it("returns null for an id that is not a uuid", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      expect(await ownerListing(tx, jo.viewer, "nope")).toBeNull();
    });
  });
});

describe("updateOwnerListing", () => {
  const patch = {
    description: "A converted watermill on the river.",
    phone: "01632 960111",
    website: "https://oldmill.example",
    socials: ["https://instagram.com/oldmill"],
    openingHours: { mon: "09:00-17:00", tue: "Closed" },
  };

  it("saves the editable fields and writes an audit row", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      const result = await updateOwnerListing(tx, jo.viewer, jo.listingId, patch, "203.0.113.7");
      expect(result.outcome).toBe("saved");
      if (result.outcome !== "saved") return;
      // The edit shows on the listing page and on every page that prints its
      // details; the action busts what `listingPaths` says, not its own list.
      expect(result.paths).toEqual(await listingPaths(tx, ADMIN_VIEWER, jo.listingId));

      const [row] = await tx.select().from(listings).where(eq(listings.id, jo.listingId));
      expect(row?.description).toBe(patch.description);
      expect(row?.phone).toBe("01632 960111");
      expect(row?.socials).toEqual(patch.socials);
      expect(row?.openingHours).toEqual(patch.openingHours);

      const audits = await tx
        .select({ action: auditLog.action, actorId: auditLog.actorId, ip: auditLog.ip })
        .from(auditLog)
        .where(eq(auditLog.entityId, jo.listingId));
      // Global constraint 22: who, what and from where. An audit row with no
      // address cannot answer the only question anybody asks it afterwards.
      expect(audits).toEqual([
        { action: "listing.edited", actorId: jo.profileId, ip: "203.0.113.7" },
      ]);
    });
  });

  it("touches nothing when the viewer does not own the listing", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx, { description: "Untouched." });
      const stranger = await owner(tx);
      const result = await updateOwnerListing(tx, stranger.viewer, jo.listingId, patch, null);
      expect(result.outcome).toBe("not-found");

      const [row] = await tx.select().from(listings).where(eq(listings.id, jo.listingId));
      expect(row?.description).toBe("Untouched.");
      expect(await tx.select().from(auditLog)).toHaveLength(0);
    });
  });

  it("cannot be used to change status, tier or ownership", async () => {
    await withTestDb(async (tx) => {
      const jo = await owned(tx);
      // The patch type admits five fields; this is the runtime half of the same
      // statement, since a form post is not typechecked.
      await updateOwnerListing(tx, jo.viewer, jo.listingId, {
        ...patch,
        ...({ status: "archived", tier: "premium", ownerId: randomUUID() } as unknown as object),
      }, null);
      const [row] = await tx.select().from(listings).where(eq(listings.id, jo.listingId));
      expect(row?.status).toBe("published");
      expect(row?.tier).toBe("free");
      expect(row?.ownerId).toBe(jo.profileId);
    });
  });
});

describe("ownerEnquiries", () => {
  async function withEnquiry(tx: TestDb, patch: Record<string, unknown> = {}) {
    const jo = await owned(tx);
    const [row] = await tx.insert(enquiries).values({
      listingId: jo.listingId,
      name: "Sam Enquirer",
      email: "sam@example.co.uk",
      message: "Are you free in June?",
      ...patch,
    }).returning({ id: enquiries.id });
    return { ...jo, enquiryId: row!.id };
  }

  it("lists the enquiries for a listing the viewer owns, newest first", async () => {
    await withTestDb(async (tx) => {
      const jo = await withEnquiry(tx);
      const rows = await ownerEnquiries(tx, jo.viewer, jo.listingId);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.name).toBe("Sam Enquirer");
      expect(rows[0]?.readAt).toBeNull();
    });
  });

  it("gives a stranger nothing, because an enquiry is somebody's contact details", async () => {
    await withTestDb(async (tx) => {
      const jo = await withEnquiry(tx);
      const stranger = await owner(tx);
      expect(await ownerEnquiries(tx, stranger.viewer, jo.listingId)).toEqual([]);
    });
  });

  it("hides the enquirer's IP, which is ours to hold and not the owner's to see", async () => {
    await withTestDb(async (tx) => {
      const jo = await withEnquiry(tx, { ip: "203.0.113.7" });
      const rows = await ownerEnquiries(tx, jo.viewer, jo.listingId);
      expect(JSON.stringify(rows)).not.toContain("203.0.113.7");
    });
  });

  it("leaves spam out of the owner's inbox", async () => {
    await withTestDb(async (tx) => {
      const jo = await withEnquiry(tx, { isSpam: true });
      expect(await ownerEnquiries(tx, jo.viewer, jo.listingId)).toEqual([]);
    });
  });
});

describe("markEnquiryHandled", () => {
  async function withEnquiry(tx: TestDb) {
    const jo = await owned(tx);
    const [row] = await tx.insert(enquiries).values({
      listingId: jo.listingId,
      name: "Sam", email: "sam@example.co.uk", message: "Hello",
      createdAt: new Date("2026-09-08T12:00:00Z"),
    }).returning({ id: enquiries.id });
    return { ...jo, enquiryId: row!.id };
  }

  it("stamps read_at", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-08T12:30:00Z"));
      const jo = await withEnquiry(tx);
      expect(await markEnquiryHandled(tx, jo.viewer, jo.enquiryId, "read", null)).toBe(true);
      const [row] = await tx.select().from(enquiries).where(eq(enquiries.id, jo.enquiryId));
      expect(row?.readAt?.toISOString()).toBe("2026-09-08T12:30:00.000Z");
      expect(row?.repliedAt).toBeNull();
    });
  });

  it("records the response time in minutes when the owner marks it replied", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-08T14:00:00Z"));
      const jo = await withEnquiry(tx);
      expect(await markEnquiryHandled(tx, jo.viewer, jo.enquiryId, "replied", null)).toBe(true);
      const [row] = await tx.select().from(enquiries).where(eq(enquiries.id, jo.enquiryId));
      expect(row?.respondedInMinutes).toBe(120);
      // Replying implies reading it.
      expect(row?.readAt).not.toBeNull();
    });
  });

  it("keeps the first response time when it is marked replied twice", async () => {
    await withTestDb(async (tx) => {
      setClock(new Date("2026-09-08T14:00:00Z"));
      const jo = await withEnquiry(tx);
      await markEnquiryHandled(tx, jo.viewer, jo.enquiryId, "replied", null);
      setClock(new Date("2026-09-09T14:00:00Z"));
      await markEnquiryHandled(tx, jo.viewer, jo.enquiryId, "replied", null);
      const [row] = await tx.select().from(enquiries).where(eq(enquiries.id, jo.enquiryId));
      expect(row?.respondedInMinutes).toBe(120);
    });
  });

  it("audits each handling, with the actor and the address it came from", async () => {
    await withTestDb(async (tx) => {
      const jo = await withEnquiry(tx);
      await markEnquiryHandled(tx, jo.viewer, jo.enquiryId, "read", "203.0.113.7");
      await markEnquiryHandled(tx, jo.viewer, jo.enquiryId, "replied", "203.0.113.8");

      const audits = await tx
        .select({ action: auditLog.action, actorId: auditLog.actorId, ip: auditLog.ip })
        .from(auditLog)
        .where(eq(auditLog.entityId, jo.enquiryId));
      expect(audits).toEqual([
        { action: "enquiry.marked_read", actorId: jo.profileId, ip: "203.0.113.7" },
        { action: "enquiry.marked_replied", actorId: jo.profileId, ip: "203.0.113.8" },
      ]);
    });
  });

  it("writes no audit row for an enquiry the viewer does not own", async () => {
    await withTestDb(async (tx) => {
      const jo = await withEnquiry(tx);
      const stranger = await owner(tx);
      await markEnquiryHandled(tx, stranger.viewer, jo.enquiryId, "read", "203.0.113.9");
      const audits = await tx.select().from(auditLog).where(eq(auditLog.entityId, jo.enquiryId));
      expect(audits).toHaveLength(0);
    });
  });

  it("refuses somebody else's enquiry", async () => {
    await withTestDb(async (tx) => {
      const jo = await withEnquiry(tx);
      const stranger = await owner(tx);
      expect(await markEnquiryHandled(tx, stranger.viewer, jo.enquiryId, "read", null)).toBe(false);
      const [row] = await tx.select().from(enquiries).where(eq(enquiries.id, jo.enquiryId));
      expect(row?.readAt).toBeNull();
    });
  });
});
