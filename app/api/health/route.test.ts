import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RedisProbe } from "@/lib/observability/redis";
import type { RedisState } from "@/lib/redis/client";

const pingDatabase = vi.fn<(db: unknown) => Promise<void>>();
const probeRedis = vi.fn<() => Promise<RedisProbe>>();
const redisState = vi.fn<() => RedisState>();
const POOL = { marker: "the pool" };
const getDb = vi.fn(() => POOL);

vi.mock("@/lib/db/queries/health", () => ({ pingDatabase: (db: unknown) => pingDatabase(db) }));
vi.mock("@/lib/observability/redis", () => ({ probeRedis: () => probeRedis() }));
vi.mock("@/lib/db/client", () => ({ getDb: () => getDb() }));
vi.mock("@/lib/redis/client", () => ({ redisState: () => redisState() }));

describe("GET /api/health", () => {
  beforeEach(() => {
    pingDatabase.mockReset().mockResolvedValue(undefined);
    probeRedis.mockReset().mockResolvedValue("ok");
    redisState.mockReset().mockReturnValue({ status: "ready", downUntil: null });
    getDb.mockClear();
    // `./route` now probes through `memoizedHealthReport`, which keeps a
    // module-scoped memo — one report per process, keyed on nothing. Without
    // this reset, whichever test runs first would decide what every test
    // after it sees for up to `HEALTH_MEMO_OK_TTL_MS`.
    vi.resetModules();
  });

  it("does not open a database connection merely by being imported", async () => {
    // `next build` evaluates every route module to read its exports. A pool
    // opened at module scope would put a reachable database back into the
    // image build's requirements.
    await import("./route");

    expect(getDb).not.toHaveBeenCalled();
  });

  it("pings the shared pool rather than a connection of its own", async () => {
    const { GET } = await import("./route");

    await GET();

    expect(pingDatabase).toHaveBeenCalledWith(POOL);
  });

  it("answers 200 with the full report when the database is reachable", async () => {
    const { GET } = await import("./route");

    const res = await GET();
    const body: unknown = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, db: "ok", redis: "ok" });
    expect(body).toHaveProperty("build");
    expect(body).toHaveProperty("uptimeSeconds");
  });

  it("reports the shared Redis handle's state beside the probe result", async () => {
    // The probe opens a fresh connection and measures the server; the handle
    // is what the rate limiter and counters actually get, and it can be in a
    // cooldown while the server is fine. Both go in the body, under
    // different keys, so a monitor can tell "Redis is down" from "this
    // process gave up on Redis for thirty seconds".
    redisState.mockReturnValue({ status: "down", downUntil: 1_700_000_000_000 });
    const { GET } = await import("./route");

    const res = await GET();
    const body: unknown = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      redis: "ok",
      redisClient: { status: "down", downUntil: 1_700_000_000_000 },
    });
  });

  it("answers 503 when the database is unreachable", async () => {
    pingDatabase.mockRejectedValue(new Error("ECONNREFUSED"));
    const { GET } = await import("./route");

    const res = await GET();

    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ ok: false, db: "fail" });
  });

  it("stays 200 when only Redis is down", async () => {
    probeRedis.mockResolvedValue("fail");
    const { GET } = await import("./route");

    const res = await GET();

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, redis: "fail" });
  });

  it("is never cached", async () => {
    // A cached health check is a health check of the cache. Coolify would keep
    // seeing the 200 a dead container returned an hour ago.
    const { GET } = await import("./route");

    const res = await GET();

    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("is force-dynamic, so it never reaches the ISR cache handler", async () => {
    const route = await import("./route");

    expect(route.dynamic).toBe("force-dynamic");
    expect(route.revalidate).toBe(0);
  });

  it("reports a number of seconds, not a string", async () => {
    const { GET } = await import("./route");

    const body = (await (await GET()).json()) as { uptimeSeconds: unknown };

    expect(typeof body.uptimeSeconds).toBe("number");
    expect(Number.isInteger(body.uptimeSeconds)).toBe(true);
  });
});
