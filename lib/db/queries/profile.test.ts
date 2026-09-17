import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { auditLog, profiles, user } from "@/lib/db/schema";
import { ADMIN_VIEWER } from "@/worker/viewer";
import { withTestDb, type TestDb } from "@/test/db";
import type { Viewer } from "@/lib/db/viewer";
import { authEmailRecipient, ownProfile, updateOwnProfile } from "./profile";

async function makeUser(
  tx: TestDb,
  overrides: { name?: string; emailVerified?: boolean } = {},
): Promise<{ viewer: Viewer & { role: "user" }; userId: string; email: string }> {
  const userId = `u_${randomUUID()}`;
  const email = `${userId}@example.test`;
  await tx.insert(user).values({
    id: userId,
    name: overrides.name ?? "Original Name",
    email,
    emailVerified: overrides.emailVerified ?? false,
  });
  return { viewer: { role: "user", userId }, userId, email };
}

describe("ownProfile", () => {
  it("creates the profile row on first read, so a fresh account has one", async () => {
    await withTestDb(async (tx) => {
      const { viewer, email } = await makeUser(tx);
      const profile = await ownProfile(tx, viewer);
      expect(profile.email).toBe(email);
      expect(profile.emailVerified).toBe(false);
      expect(profile.marketingOptIn).toBe(false);
      expect(profile.role).toBe("user");
      const rows = await tx.select().from(profiles).where(eq(profiles.userId, viewer.userId));
      expect(rows).toHaveLength(1);
    });
  });

  it("falls back to the account name when the profile has none of its own", async () => {
    await withTestDb(async (tx) => {
      const { viewer } = await makeUser(tx, { name: "Account Name" });
      expect((await ownProfile(tx, viewer)).name).toBe("Account Name");
    });
  });

  it("refuses an anonymous viewer", async () => {
    await withTestDb(async (tx) => {
      await expect(ownProfile(tx, { role: "public" })).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("updateOwnProfile", () => {
  it("writes the viewer's own row and audits it", async () => {
    await withTestDb(async (tx) => {
      const { viewer } = await makeUser(tx);
      const updated = await updateOwnProfile(tx, viewer, {
        name: "New Name",
        phone: "020 7946 0100",
        marketingOptIn: true,
        ip: "203.0.113.9",
      });
      expect(updated.name).toBe("New Name");
      expect(updated.phone).toBe("020 7946 0100");
      expect(updated.marketingOptIn).toBe(true);

      const audits = await tx.select().from(auditLog).where(eq(auditLog.action, "profile.updated"));
      expect(audits).toHaveLength(1);
      expect(audits[0]!.ip).toBe("203.0.113.9");
      expect(audits[0]!.actorId).toBe(updated.profileId);
    });
  });

  it("cannot reach another user's profile", async () => {
    // There is no id parameter to tamper with: the row is chosen by the
    // viewer. This asserts the neighbouring row is untouched, which is the
    // thing that would actually go wrong if that ever changed.
    await withTestDb(async (tx) => {
      const mine = await makeUser(tx);
      const theirs = await makeUser(tx);
      await updateOwnProfile(tx, theirs.viewer, {
        name: "Their Name",
        phone: null,
        marketingOptIn: false,
        ip: null,
      });
      await updateOwnProfile(tx, mine.viewer, {
        name: "My Name",
        phone: null,
        marketingOptIn: true,
        ip: null,
      });

      expect((await ownProfile(tx, theirs.viewer)).name).toBe("Their Name");
      expect((await ownProfile(tx, theirs.viewer)).marketingOptIn).toBe(false);
      expect((await ownProfile(tx, mine.viewer)).name).toBe("My Name");
    });
  });

  it("never lets a viewer change their own role", async () => {
    await withTestDb(async (tx) => {
      const { viewer } = await makeUser(tx);
      await updateOwnProfile(tx, viewer, {
        name: "Someone",
        phone: null,
        marketingOptIn: false,
        ip: null,
      });
      const [row] = await tx
        .select({ role: profiles.role })
        .from(profiles)
        .where(eq(profiles.userId, viewer.userId));
      expect(row!.role).toBe("user");
    });
  });

  it("refuses an anonymous viewer", async () => {
    await withTestDb(async (tx) => {
      await expect(
        updateOwnProfile(tx, { role: "public" }, {
          name: "x",
          phone: null,
          marketingOptIn: false,
          ip: null,
        }),
      ).rejects.toThrow(/FORBIDDEN/);
    });
  });
});

describe("authEmailRecipient", () => {
  it("gives the worker the address a token email goes to", async () => {
    await withTestDb(async (tx) => {
      const { userId, email } = await makeUser(tx, { name: "Sam" });
      const recipient = await authEmailRecipient(tx, ADMIN_VIEWER, userId);
      expect(recipient).toEqual({ email, name: "Sam" });
    });
  });

  it("returns null for an account that has gone", async () => {
    await withTestDb(async (tx) => {
      expect(await authEmailRecipient(tx, ADMIN_VIEWER, "u_missing")).toBeNull();
    });
  });

  it("is not readable by an ordinary viewer", async () => {
    // The queue hands this a user id, so it is a lookup from an id to somebody
    // else's email address. Worker only.
    await withTestDb(async (tx) => {
      const { viewer, userId } = await makeUser(tx);
      await expect(authEmailRecipient(tx, viewer, userId)).rejects.toThrow(/FORBIDDEN/);
    });
  });
});
