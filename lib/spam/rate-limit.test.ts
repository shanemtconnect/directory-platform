import { describe, it, expect, beforeEach } from "vitest";
import { rateLimit } from "./rate-limit";
import { randomUUID } from "node:crypto";

beforeEach(() => { process.env.REDIS_URL = process.env.REDIS_URL ?? "redis://localhost:6380"; });

describe("rateLimit", () => {
  it("allows up to the limit then blocks", async () => {
    const key = `test:${randomUUID()}`;
    const opts = { limit: 3, windowSeconds: 60 };
    for (let i = 0; i < 3; i++) {
      expect((await rateLimit(key, opts)).allowed).toBe(true);
    }
    const blocked = await rateLimit(key, opts);
    expect(blocked.allowed).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.retryAfterSeconds).toBeGreaterThan(0);
  });

  it("counts separate keys separately", async () => {
    const opts = { limit: 1, windowSeconds: 60 };
    const a = `test:${randomUUID()}`, b = `test:${randomUUID()}`;
    expect((await rateLimit(a, opts)).allowed).toBe(true);
    expect((await rateLimit(b, opts)).allowed).toBe(true);
    expect((await rateLimit(a, opts)).allowed).toBe(false);
  });

  it("reports remaining accurately", async () => {
    const key = `test:${randomUUID()}`;
    const opts = { limit: 5, windowSeconds: 60 };
    expect((await rateLimit(key, opts)).remaining).toBe(4);
    expect((await rateLimit(key, opts)).remaining).toBe(3);
  });

  it("fails OPEN when Redis is unreachable — a dead contact form is worse than spam", async () => {
    const saved = process.env.REDIS_URL;
    process.env.REDIS_URL = "redis://127.0.0.1:1";
    // Force a fresh client for the bad URL by using a distinct key.
    const res = await rateLimit(`unreachable:${randomUUID()}`, { limit: 1, windowSeconds: 60 });
    process.env.REDIS_URL = saved;
    expect(res.allowed).toBe(true);
  });
});
