import { describe, it, expect, vi } from "vitest";
import { healthReport, HEALTH_PROBE_TIMEOUT_MS, type HealthProbes } from "./health";

function probes(over: Partial<HealthProbes> = {}): HealthProbes {
  return {
    db: async () => undefined,
    redis: async () => "ok",
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
      build: "8dhlIRUNLtpabNXf4Ajbu",
      uptimeSeconds: 42,
    });
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
