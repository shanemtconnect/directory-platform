import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  AUTH_RATE_LIMIT,
  ENQUIRY_RATE_LIMIT,
  limitPublicWrite,
  retryMessage,
  SHORTLIST_RATE_LIMIT,
  SUBMIT_LISTING_RATE_LIMIT,
} from "./write-limit";

const GOOD_URL = process.env.REDIS_URL ?? "redis://localhost:6380";

beforeEach(() => {
  process.env.REDIS_URL = GOOD_URL;
});

/** A distinct feature name per test, so buckets never collide across runs. */
const feature = () => `test-write-${randomUUID()}`;

const withIp = (ip: string) => new Headers({ "x-forwarded-for": ip });

describe("limitPublicWrite", () => {
  it("allows up to the limit for one client, then blocks", async () => {
    const f = feature();
    const opts = { limit: 2, windowSeconds: 60 };
    const h = withIp("198.51.100.7");

    expect((await limitPublicWrite(f, h, opts)).allowed).toBe(true);
    expect((await limitPublicWrite(f, h, opts)).allowed).toBe(true);

    const blocked = await limitPublicWrite(f, h, opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts different clients separately", async () => {
    const f = feature();
    const opts = { limit: 1, windowSeconds: 60 };
    expect((await limitPublicWrite(f, withIp("198.51.100.8"), opts)).allowed).toBe(true);
    expect((await limitPublicWrite(f, withIp("198.51.100.9"), opts)).allowed).toBe(true);
    expect((await limitPublicWrite(f, withIp("198.51.100.8"), opts)).allowed).toBe(false);
  });

  it("counts the LAST forwarded hop, so a spoofed leading IP buys nothing", async () => {
    // Only the last entry is written by our own proxy. Reading the first would
    // hand an attacker a fresh bucket per request.
    const f = feature();
    const opts = { limit: 1, windowSeconds: 60 };
    const real = "198.51.100.10";

    expect((await limitPublicWrite(f, withIp(`1.1.1.1, ${real}`), opts)).allowed).toBe(true);
    expect((await limitPublicWrite(f, withIp(`2.2.2.2, ${real}`), opts)).allowed).toBe(false);
  });

  it("shares one bucket across every write of the same feature", async () => {
    // A budget spent per action would let a client multiply it by rotating
    // between add, remove, rename and share.
    const f = feature();
    const opts = { limit: 2, windowSeconds: 60 };
    const h = withIp("198.51.100.11");

    expect((await limitPublicWrite(f, h, opts)).allowed).toBe(true);
    expect((await limitPublicWrite(f, h, opts)).allowed).toBe(true);
    expect((await limitPublicWrite(f, h, opts)).allowed).toBe(false);
  });

  it("does not bucket unidentifiable requests together", async () => {
    // No proxy header at all: a shared "unknown" bucket would let one bot lock
    // out every other visitor arriving without one.
    const f = feature();
    const opts = { limit: 1, windowSeconds: 60 };
    for (let i = 0; i < 5; i++) {
      expect((await limitPublicWrite(f, new Headers(), opts)).allowed).toBe(true);
    }
  });

  it("reads x-real-ip when there is no forwarded-for", async () => {
    const f = feature();
    const opts = { limit: 1, windowSeconds: 60 };
    const h = () => new Headers({ "x-real-ip": "198.51.100.12" });
    expect((await limitPublicWrite(f, h(), opts)).allowed).toBe(true);
    expect((await limitPublicWrite(f, h(), opts)).allowed).toBe(false);
  });
});

describe("the shortlist budget", () => {
  it("is generous enough for real comparison behaviour", () => {
    // Saving is a one-click action a visitor repeats while comparing. A tight
    // cap would break the feature for the people using it properly.
    expect(SHORTLIST_RATE_LIMIT.limit).toBeGreaterThanOrEqual(60);
    expect(SHORTLIST_RATE_LIMIT.windowSeconds).toBe(3600);
  });

  it("tells a blocked visitor when to come back, in minutes", () => {
    expect(retryMessage({ allowed: false, remaining: 0, retryAfterSeconds: 601 }))
      .toContain("11 minutes");
  });
});

describe("the public write budgets", () => {
  // They live together so the whole picture is comparable in one read: a
  // budget is only sensible relative to the others, and when one of them was
  // an inline literal at its call site, nobody could see that the enquiry form
  // was stricter than a sign-in attempt.
  it("are all defined in this module", () => {
    for (const budget of [
      ENQUIRY_RATE_LIMIT,
      SUBMIT_LISTING_RATE_LIMIT,
      SHORTLIST_RATE_LIMIT,
      AUTH_RATE_LIMIT,
    ]) {
      expect(budget.limit).toBeGreaterThan(0);
      expect(budget.windowSeconds).toBeGreaterThan(0);
    }
  });

  it("keeps the one-off forms tighter than the repeated actions", () => {
    // Submitting a listing is something a person does once; saving to a
    // shortlist is something they do all afternoon. If this ever inverts,
    // somebody has copied a number without reading what it guards.
    expect(SUBMIT_LISTING_RATE_LIMIT.limit).toBeLessThan(ENQUIRY_RATE_LIMIT.limit);
    expect(ENQUIRY_RATE_LIMIT.limit).toBeLessThan(SHORTLIST_RATE_LIMIT.limit);
  });

  it("gives auth a short window, because credential stuffing is bursty", () => {
    expect(AUTH_RATE_LIMIT.windowSeconds).toBeLessThan(ENQUIRY_RATE_LIMIT.windowSeconds);
  });
});
