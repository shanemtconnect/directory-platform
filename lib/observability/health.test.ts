import { describe, it, expect, vi } from "vitest";
import { healthReport, HEALTH_PROBE_TIMEOUT_MS, type HealthProbes } from "./health";

function probes(over: Partial<HealthProbes> = {}): HealthProbes {
  return {
    db: async () => undefined,
    redis: async () => "ok",
    redisClient: () => ({ status: "ready", downUntil: null }),
    buildId: () => "8dhlIRUNLtpabNXf4Ajbu",
    uptimeSeconds: () => 42,
    ...over,
  };
}

describe("healthReport", () => {
  it("reports everything green", async () => {
    await expect(healthReport(probes())).resolves.toEqual({
      ok: true,
      db: "ok",
      redis: "ok",
      redisClient: { status: "ready", downUntil: null },
      build: "8dhlIRUNLtpabNXf4Ajbu",
      uptimeSeconds: 42,
    });
  });

  it("reports the shared Redis handle's state beside the probe, without letting it gate ok", async () => {
    // The probe measures the server; the handle can be in its 30 s cooldown
    // while the server is perfectly reachable. Both are worth seeing, and
    // neither decides the HTTP status.
    const report = await healthReport(
      probes({ redisClient: () => ({ status: "down", downUntil: 1_700_000_000_000 }) }),
    );

    expect(report.ok).toBe(true);
    expect(report.redis).toBe("ok");
    expect(report.redisClient).toEqual({ status: "down", downUntil: 1_700_000_000_000 });
  });

  it("is not ok when the database probe rejects", async () => {
    const report = await healthReport(
      probes({
        db: async () => {
          throw new Error("ECONNREFUSED");
        },
      }),
    );

    expect(report.ok).toBe(false);
    expect(report.db).toBe("fail");
  });

  it("stays ok when Redis is unreachable", async () => {
    // A dead Redis costs the ISR cache, not the site: cache-handler.mjs falls
    // back to a per-process LRU. Failing the health check here would pull every
    // container out of the load balancer and turn a slow site into an outage.
    const report = await healthReport(probes({ redis: async () => "fail" }));

    expect(report.ok).toBe(true);
    expect(report.redis).toBe("fail");
  });

  it("stays ok when Redis is not configured at all", async () => {
    const report = await healthReport(probes({ redis: async () => "absent" }));

    expect(report).toMatchObject({ ok: true, redis: "absent" });
  });

  it("fails the database probe rather than hanging on it", async () => {
    vi.useFakeTimers();
    try {
      const pending = healthReport(probes({ db: () => new Promise(() => {}) }));
      await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS + 1);

      await expect(pending).resolves.toMatchObject({ ok: false, db: "fail" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the two probes concurrently", async () => {
    // Sequential probes would take twice the timeout to answer a fully dead
    // dependency pair, which is longer than most orchestrators wait.
    vi.useFakeTimers();
    try {
      const pending = healthReport(
        probes({ db: () => new Promise(() => {}), redis: () => new Promise(() => {}) }),
      );
      await vi.advanceTimersByTimeAsync(HEALTH_PROBE_TIMEOUT_MS + 1);

      await expect(pending).resolves.toMatchObject({ ok: false, db: "fail", redis: "fail" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("never lets a thrown probe escape as a rejection", async () => {
    const report = await healthReport(
      probes({
        redis: async () => {
          throw new Error("boom");
        },
      }),
    );

    expect(report.redis).toBe("fail");
  });
});

describe("memoizedHealthReport", () => {
  // Each test gets its own module instance: the memo is module state — one
  // report per process, keyed on nothing — so a test that populates it would
  // otherwise decide what every test after it sees.
  async function freshModule() {
    vi.resetModules();
    return import("./health");
  }

  it("probes once for two calls inside the healthy TTL", async () => {
    const { memoizedHealthReport, HEALTH_MEMO_OK_TTL_MS } = await freshModule();
    vi.useFakeTimers();
    try {
      const db = vi.fn(async () => undefined);
      const p = probes({ db });

      await memoizedHealthReport(p);
      await vi.advanceTimersByTimeAsync(HEALTH_MEMO_OK_TTL_MS - 1);
      const second = await memoizedHealthReport(p);

      expect(db).toHaveBeenCalledTimes(1);
      expect(second).toMatchObject({ ok: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("probes again once the healthy TTL has elapsed", async () => {
    const { memoizedHealthReport, HEALTH_MEMO_OK_TTL_MS } = await freshModule();
    vi.useFakeTimers();
    try {
      const db = vi.fn(async () => undefined);
      const p = probes({ db });

      await memoizedHealthReport(p);
      await vi.advanceTimersByTimeAsync(HEALTH_MEMO_OK_TTL_MS + 1);
      await memoizedHealthReport(p);

      expect(db).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not memoise a failing report past the shorter failure TTL", async () => {
    // A failing report is memoised for only a third of the healthy TTL: the
    // memo exists to spare the database repeat load, not to slow down how
    // fast an operator sees recovery once the database actually comes back.
    const { memoizedHealthReport, HEALTH_MEMO_FAIL_TTL_MS, HEALTH_MEMO_OK_TTL_MS } =
      await freshModule();
    expect(HEALTH_MEMO_FAIL_TTL_MS).toBeLessThan(HEALTH_MEMO_OK_TTL_MS);

    vi.useFakeTimers();
    try {
      const db = vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      });
      const p = probes({ db });

      const first = await memoizedHealthReport(p);
      expect(first).toMatchObject({ ok: false });

      await vi.advanceTimersByTimeAsync(HEALTH_MEMO_FAIL_TTL_MS - 1);
      await memoizedHealthReport(p);
      expect(db).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(2);
      await memoizedHealthReport(p);
      expect(db).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not call Redis either while a report is memoised", async () => {
    const { memoizedHealthReport } = await freshModule();
    vi.useFakeTimers();
    try {
      const redis = vi.fn(async () => "ok" as const);
      const p = probes({ redis });

      await memoizedHealthReport(p);
      await memoizedHealthReport(p);

      expect(redis).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
