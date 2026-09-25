import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { withTestDb, type TestDb } from "@/test/db";
import { leadBlocklist, leads } from "@/lib/db/schema";
import { makeScaffold } from "@/test/factories";
import { resetClock, setClock } from "@/lib/clock";
import { checkLeadRules, DUPLICATE_WINDOW_DAYS, normaliseEmail } from "./rules";

const DAY = 86_400_000;
const NOW = new Date("2026-09-25T12:00:00Z");

afterEach(() => resetClock());

/** A number nobody else in the shared test database is using. */
function freshPhone(): { raw: string; e164: string } {
  const tail = String(Math.floor(Math.random() * 10_000)).padStart(4, "0");
  return { raw: `01632 96${tail}`, e164: `+44163296${tail}` };
}
function freshEmail(): string {
  return `rules-${randomUUID()}@example.co.uk`;
}

async function existingLead(
  tx: TestDb,
  cityId: string,
  fields: { email: string; phoneNormalised: string | null; createdAt: Date },
): Promise<string> {
  const [row] = await tx.insert(leads).values({
    source: "capture", cityId, firstName: "Sam", brief: "A job", name: "Sam Earlier",
    email: fields.email, emailNormalised: normaliseEmail(fields.email),
    phone: fields.phoneNormalised, phoneNormalised: fields.phoneNormalised,
    message: "A job", priceCents: 2500,
    expiresAt: new Date(fields.createdAt.getTime() + 30 * DAY),
    halfPriceAt: new Date(fields.createdAt.getTime() + 7 * DAY),
    createdAt: fields.createdAt, updatedAt: fields.createdAt,
  }).returning({ id: leads.id });
  return row!.id;
}

describe("checkLeadRules", () => {
  it("passes an ordinary number and address", async () => {
    await withTestDb(async (tx) => {
      setClock(NOW);
      const verdict = await checkLeadRules(tx, { email: freshEmail(), phone: freshPhone().raw, country: "GB" });
      expect(verdict).toBe("ok");
    });
  });

  it("refuses a phone that does not normalise for the site's country, or is missing", async () => {
    await withTestDb(async (tx) => {
      for (const phone of ["0909 879 0000", "123", "+1 212 456 7890", null, ""]) {
        expect(await checkLeadRules(tx, { email: freshEmail(), phone, country: "GB" }))
          .toEqual({ reason: "phone_invalid" });
      }
    });
  });

  it("refuses a disposable address", async () => {
    await withTestDb(async (tx) => {
      expect(await checkLeadRules(tx, { email: "who@Mailinator.com", phone: freshPhone().raw, country: "GB" }))
        .toEqual({ reason: "disposable_email" });
    });
  });

  it("refuses a blocklisted phone or email until the entry expires", async () => {
    await withTestDb(async (tx) => {
      setClock(NOW);
      const phone = freshPhone();
      const email = freshEmail();
      await tx.insert(leadBlocklist).values([
        { kind: "phone", value: phone.e164, reason: "refund: dead_phone", expiresAt: new Date(NOW.getTime() + DAY) },
        { kind: "email", value: normaliseEmail(email), reason: "refund: spam", expiresAt: null },
      ]);

      // Reformatted, and in another case: still the same number and address.
      const spaced = phone.raw.replace(" ", "");
      expect(await checkLeadRules(tx, { email: freshEmail(), phone: spaced, country: "GB" }))
        .toEqual({ reason: "blocklisted" });
      expect(await checkLeadRules(tx, { email: email.toUpperCase(), phone: freshPhone().raw, country: "GB" }))
        .toEqual({ reason: "blocklisted" });

      // A day and a second later the phone entry has lapsed; the permanent email has not.
      setClock(new Date(NOW.getTime() + DAY + 1000));
      expect(await checkLeadRules(tx, { email: freshEmail(), phone: phone.raw, country: "GB" })).toBe("ok");
      expect(await checkLeadRules(tx, { email, phone: freshPhone().raw, country: "GB" }))
        .toEqual({ reason: "blocklisted" });
    });
  });

  it("calls the same phone or email within the window a duplicate, and not after it", async () => {
    await withTestDb(async (tx) => {
      setClock(NOW);
      const { cityId } = await makeScaffold(tx);
      const recent = { phone: freshPhone(), email: freshEmail() };
      const old = { phone: freshPhone(), email: freshEmail() };
      await existingLead(tx, cityId, {
        email: recent.email, phoneNormalised: recent.phone.e164, createdAt: new Date(NOW.getTime() - 29 * DAY),
      });
      await existingLead(tx, cityId, {
        email: old.email, phoneNormalised: old.phone.e164,
        createdAt: new Date(NOW.getTime() - (DUPLICATE_WINDOW_DAYS * DAY + 1000)),
      });

      expect(await checkLeadRules(tx, { email: freshEmail(), phone: recent.phone.raw, country: "GB" }))
        .toEqual({ reason: "duplicate" });
      expect(await checkLeadRules(tx, { email: ` ${recent.email.toUpperCase()} `, phone: freshPhone().raw, country: "GB" }))
        .toEqual({ reason: "duplicate" });
      expect(await checkLeadRules(tx, { email: old.email, phone: old.phone.raw, country: "GB" })).toBe("ok");
      expect(DUPLICATE_WINDOW_DAYS).toBe(30);
    });
  });
});
