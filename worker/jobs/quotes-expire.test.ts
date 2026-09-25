import { afterEach, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { withTestDb } from "@/test/db";
import { quoteRequests } from "@/lib/db/schema";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { createQuoteRequest, QUOTE_VERIFY_TTL_HOURS } from "@/lib/db/queries/quotes";
import { makeListing, makeScaffold } from "@/test/factories";
import { resetClock, setClock } from "@/lib/clock";
import type { Db } from "@/lib/db/client";
import { expirePendingQuotes } from "./quotes-expire";

afterEach(() => resetClock());

describe("quotes.expire", () => {
  it("marks a request nobody confirmed within 48 hours expired, and logs how many", async () => {
    await withTestDb(async (tx) => {
      const ctx = await makeScaffold(tx);
      await makeListing(tx, ctx, { email: "a@example.com" });
      const T0 = Date.parse("2026-09-25T12:00:00Z");
      setClock(new Date(T0));
      const created = await createQuoteRequest(tx, PUBLIC_VIEWER, {
        cityId: ctx.cityId, categoryId: ctx.primaryCategoryId, name: "Sam", email: "sam@example.co.uk",
        phone: null, message: "Eighty people in June, with parking.", ip: null,
      });
      if (created.outcome !== "created") throw new Error(created.outcome);
      const log = vi.spyOn(console, "log").mockImplementation(() => {});

      setClock(new Date(T0 + (QUOTE_VERIFY_TTL_HOURS - 1) * 3_600_000));
      expect(await expirePendingQuotes(tx as unknown as Db)).toBe(0);

      setClock(new Date(T0 + QUOTE_VERIFY_TTL_HOURS * 3_600_000 + 1));
      expect(await expirePendingQuotes(tx as unknown as Db)).toBe(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining("expired 1 unconfirmed quote request"));
      log.mockRestore();

      const [row] = await tx.select({ status: quoteRequests.status }).from(quoteRequests)
        .where(eq(quoteRequests.id, created.quoteRequestId));
      expect(row!.status).toBe("expired");
    });
  });
});
