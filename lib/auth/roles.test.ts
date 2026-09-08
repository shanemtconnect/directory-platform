import { describe, it, expect } from "vitest";
import { withTestDb } from "@/test/db";
import { profiles, user } from "@/lib/db/schema";
import { eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";

/**
 * Role lives in OUR profiles table, never in the session or anything a client
 * can influence. These tests pin the properties `currentViewer` depends on;
 * currentViewer itself needs a request context, so it is covered end to end by
 * the admin route tests rather than here.
 */
async function makeUser(tx: Parameters<Parameters<typeof withTestDb>[0]>[0], role?: "user" | "owner" | "admin") {
  const id = randomUUID();
  await tx.insert(user).values({ id, name: "Test", email: `${id}@example.test` });
  if (role) await tx.insert(profiles).values({ userId: id, role });
  return id;
}

describe("role storage", () => {
  it("defaults a new profile to 'user' — nobody signs up as an admin", async () => {
    await withTestDb(async (tx) => {
      const id = await makeUser(tx);
      await tx.insert(profiles).values({ userId: id });
      const [p] = await tx.select().from(profiles).where(eq(profiles.userId, id));
      expect(p?.role).toBe("user");
    });
  });

  it("stores admin only when explicitly set", async () => {
    await withTestDb(async (tx) => {
      const id = await makeUser(tx, "admin");
      const [p] = await tx.select().from(profiles).where(eq(profiles.userId, id));
      expect(p?.role).toBe("admin");
    });
  });

  it("allows exactly one profile per user", async () => {
    await withTestDb(async (tx) => {
      const id = await makeUser(tx, "user");
      await expect(tx.insert(profiles).values({ userId: id, role: "admin" })).rejects.toThrow();
    });
  });

  it("rejects a role outside the enum, so 'superadmin' cannot be smuggled in", async () => {
    await withTestDb(async (tx) => {
      const id = await makeUser(tx);
      await expect(
        tx.insert(profiles).values({ userId: id, role: "superadmin" as never }),
      ).rejects.toThrow();
    });
  });

  it("cascades profile removal when the user is deleted", async () => {
    await withTestDb(async (tx) => {
      const id = await makeUser(tx, "admin");
      await tx.delete(user).where(eq(user.id, id));
      // An orphaned role:'admin' row surviving its user is the bug this
      // foreign key exists to prevent.
      expect(await tx.select().from(profiles).where(eq(profiles.userId, id))).toHaveLength(0);
    });
  });

  it("refuses a profile for a user that does not exist", async () => {
    await withTestDb(async (tx) => {
      await expect(
        tx.insert(profiles).values({ userId: randomUUID(), role: "admin" }),
      ).rejects.toThrow();
    });
  });

  it("enforces unique email addresses", async () => {
    await withTestDb(async (tx) => {
      const email = `${randomUUID()}@example.test`;
      await tx.insert(user).values({ id: randomUUID(), name: "A", email });
      await expect(
        tx.insert(user).values({ id: randomUUID(), name: "B", email }),
      ).rejects.toThrow();
    });
  });
});
