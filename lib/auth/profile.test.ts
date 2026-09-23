import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { withTestDb } from "@/test/db";
import { user } from "@/lib/db/schema";
import { ensureProfile } from "./profile";

describe("ensureProfile", () => {
  it("creates a profile with role user on first sight and returns the same row afterwards", async () => {
    await withTestDb(async (tx) => {
      const userId = `u_${randomUUID()}`;
      await tx.insert(user).values({ id: userId, name: "T", email: `${userId}@example.test`, emailVerified: false });
      const first = await ensureProfile(tx, { role: "user", userId });
      expect(first.role).toBe("user");
      const second = await ensureProfile(tx, { role: "user", userId });
      expect(second.id).toBe(first.id);
    });
  });

  it("refuses an anonymous viewer", async () => {
    await withTestDb(async (tx) => {
      await expect(ensureProfile(tx, { role: "public" })).rejects.toThrow(/signed-in/);
    });
  });
});
