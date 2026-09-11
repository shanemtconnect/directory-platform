import { describe, it, expect, vi } from "vitest";
import {
  HEARTBEAT_CRON,
  HEARTBEAT_INTERVAL_MINUTES,
  heartbeatMessage,
  pushUptime,
  UPTIME_PUSH_TIMEOUT_MS,
  type HeartbeatCounts,
} from "./heartbeat";

const counts: HeartbeatCounts = {
  queue: { pending: 3, failed: 1, done: 900 },
  runs: { ok: 12, failed: 0 },
};

describe("the heartbeat line", () => {
  it("runs every five minutes", () => {
    expect(HEARTBEAT_INTERVAL_MINUTES).toBe(5);
    expect(HEARTBEAT_CRON).toBe("*/5 * * * *");
  });

  it("names every queue status and every run status", () => {
    const line = heartbeatMessage(counts);

    expect(line).toContain("pending=3");
    expect(line).toContain("failed=1");
    expect(line).toContain("done=900");
    expect(line).toContain("ok=12");
  });

  it("says zero rather than going quiet when nothing has happened", () => {
    // An absent number reads as "not measured". The whole point of the
    // heartbeat is that its absence, not its contents, is the alert.
    const line = heartbeatMessage({ queue: {}, runs: {} });

    expect(line).toContain("pending=0");
    expect(line).toContain("failed=0");
    expect(line).toMatch(/runs\/5m/);
  });

  it("is one line", () => {
    expect(heartbeatMessage(counts)).not.toContain("\n");
  });
});

describe("pushUptime", () => {
  const url = "https://uptime.example.com/api/push/abc123";

  it("does nothing when UPTIME_PUSH_URL is unset", async () => {
    const fetchImpl = vi.fn();

    await expect(pushUptime("all good", {}, fetchImpl)).resolves.toBe("unconfigured");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does nothing when UPTIME_PUSH_URL is not a URL", async () => {
    const fetchImpl = vi.fn();

    await expect(pushUptime("x", { UPTIME_PUSH_URL: "not a url" }, fetchImpl)).resolves.toBe(
      "unconfigured",
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("GETs the push URL with the heartbeat as the message", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));

    await expect(pushUptime("queue pending=3", { UPTIME_PUSH_URL: url }, fetchImpl)).resolves.toBe(
      "sent",
    );

    const [requested, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sent = new URL(requested);
    expect(sent.origin + sent.pathname).toBe(url);
    expect(sent.searchParams.get("status")).toBe("up");
    expect(sent.searchParams.get("msg")).toBe("queue pending=3");
    expect(init.method).toBe("GET");
  });

  it("leaves query parameters the operator set themselves alone", async () => {
    const fetchImpl = vi.fn(async () => new Response("", { status: 200 }));

    await pushUptime("ignored", { UPTIME_PUSH_URL: `${url}?status=up&msg=mine` }, fetchImpl);

    const sent = new URL((fetchImpl.mock.calls[0] as unknown as [string])[0]);
    expect(sent.searchParams.get("msg")).toBe("mine");
  });

  it("reports failure rather than throwing when the monitor is down", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ENOTFOUND");
    });

    await expect(pushUptime("x", { UPTIME_PUSH_URL: url }, fetchImpl)).resolves.toBe("failed");
  });

  it("reports failure on a non-2xx answer", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 500 }));

    await expect(pushUptime("x", { UPTIME_PUSH_URL: url }, fetchImpl)).resolves.toBe("failed");
  });

  it("gives up on a monitor that never answers", async () => {
    const fetchImpl: typeof fetch = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    vi.useFakeTimers();
    try {
      const pending = pushUptime("x", { UPTIME_PUSH_URL: url }, fetchImpl);
      await vi.advanceTimersByTimeAsync(UPTIME_PUSH_TIMEOUT_MS + 1);

      await expect(pending).resolves.toBe("failed");
    } finally {
      vi.useRealTimers();
    }
  });
});
