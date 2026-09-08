import { describe, it, expect, afterEach, vi } from "vitest";
import { TURNSTILE_TIMEOUT_MS, verifyTurnstile, isHoneypotTripped } from "./turnstile";

const savedSecret = process.env.TURNSTILE_SECRET_KEY;

afterEach(() => {
  if (savedSecret === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = savedSecret;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function stubFetch(impl: (input: string, init: RequestInit) => Promise<Response>) {
  const spy = vi.fn(impl);
  vi.stubGlobal("fetch", spy);
  return spy;
}

function siteverify(body: unknown): Promise<Response> {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}

describe("verifyTurnstile without a secret", () => {
  it("skips outside production — local and staging run without a key", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    vi.stubEnv("NODE_ENV", "development");
    const r = await verifyTurnstile("anything");
    expect(r).toMatchObject({ ok: true, skipped: true });
    expect(r.reason).toMatch(/no TURNSTILE_SECRET_KEY/);
  });

  it("treats an empty secret as unconfigured", async () => {
    process.env.TURNSTILE_SECRET_KEY = "   ";
    vi.stubEnv("NODE_ENV", "development");
    expect((await verifyTurnstile("x")).skipped).toBe(true);
  });

  it("fails closed in production, and complains exactly once", async () => {
    // A fresh module instance: the "log once" latch is module state, and a
    // second test tripping it first would make this assertion vacuous.
    vi.resetModules();
    delete process.env.TURNSTILE_SECRET_KEY;
    vi.stubEnv("NODE_ENV", "production");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const { verifyTurnstile: fresh } = await import("./turnstile");
    const first = await fresh("token");
    const second = await fresh("token");

    expect(first).toEqual({ ok: false, skipped: false, reason: "not-configured" });
    expect(second).toEqual({ ok: false, skipped: false, reason: "not-configured" });
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("verifyTurnstile with a secret", () => {
  it("rejects a missing token — fails closed", async () => {
    process.env.TURNSTILE_SECRET_KEY = "real-secret";
    const r = await verifyTurnstile(null);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(false);
  });

  it("accepts a token Cloudflare says is good", async () => {
    process.env.TURNSTILE_SECRET_KEY = "real-secret";
    stubFetch(() => siteverify({ success: true }));
    expect(await verifyTurnstile("good-token")).toEqual({ ok: true, skipped: false });
  });

  it("reports the error codes when Cloudflare says the token is bad", async () => {
    process.env.TURNSTILE_SECRET_KEY = "real-secret";
    stubFetch(() => siteverify({ success: false, "error-codes": ["timeout-or-duplicate"] }));
    expect(await verifyTurnstile("used-token")).toEqual({
      ok: false,
      skipped: false,
      reason: "timeout-or-duplicate",
    });
  });

  it("sends the secret, the token and the caller's IP", async () => {
    process.env.TURNSTILE_SECRET_KEY = "real-secret";
    const spy = stubFetch(() => siteverify({ success: true }));
    await verifyTurnstile("good-token", "198.51.100.7");

    const [url, init] = spy.mock.calls[0]!;
    expect(url).toBe("https://challenges.cloudflare.com/turnstile/v0/siteverify");
    const body = new URLSearchParams(String(init.body));
    expect(body.get("secret")).toBe("real-secret");
    expect(body.get("response")).toBe("good-token");
    expect(body.get("remoteip")).toBe("198.51.100.7");
  });

  it("gives up after five seconds rather than hanging the form", async () => {
    process.env.TURNSTILE_SECRET_KEY = "real-secret";
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const spy = stubFetch(() => siteverify({ success: true }));

    await verifyTurnstile("good-token");

    expect(timeout).toHaveBeenCalledWith(TURNSTILE_TIMEOUT_MS);
    expect(TURNSTILE_TIMEOUT_MS).toBe(5000);
    expect(spy.mock.calls[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it("fails closed when Cloudflare is unreachable — an open door is worse", async () => {
    process.env.TURNSTILE_SECRET_KEY = "real-secret";
    stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    expect(await verifyTurnstile("good-token")).toEqual({
      ok: false,
      skipped: false,
      reason: "unreachable",
    });
  });

  it("fails closed when the request times out", async () => {
    process.env.TURNSTILE_SECRET_KEY = "real-secret";
    stubFetch(() => Promise.reject(new DOMException("The operation was aborted.", "TimeoutError")));
    expect((await verifyTurnstile("good-token")).reason).toBe("unreachable");
  });
});

describe("isHoneypotTripped", () => {
  it("is not tripped by an empty or absent field", () => {
    expect(isHoneypotTripped(null)).toBe(false);
    expect(isHoneypotTripped("")).toBe(false);
    expect(isHoneypotTripped("   ")).toBe(false);
  });

  it("is tripped by any real value, which only a bot would fill", () => {
    expect(isHoneypotTripped("http://spam.example")).toBe(true);
  });
});
