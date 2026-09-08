import { describe, it, expect, afterEach } from "vitest";
import { verifyTurnstile, isHoneypotTripped } from "./turnstile";

const saved = process.env.TURNSTILE_SECRET_KEY;
afterEach(() => {
  if (saved === undefined) delete process.env.TURNSTILE_SECRET_KEY;
  else process.env.TURNSTILE_SECRET_KEY = saved;
});

describe("verifyTurnstile", () => {
  it("skips loudly when no secret is configured, rather than silently passing", async () => {
    delete process.env.TURNSTILE_SECRET_KEY;
    const r = await verifyTurnstile("anything");
    expect(r).toMatchObject({ ok: true, skipped: true });
    expect(r.reason).toMatch(/no TURNSTILE_SECRET_KEY/);
  });

  it("treats an empty secret as unconfigured", async () => {
    process.env.TURNSTILE_SECRET_KEY = "   ";
    expect((await verifyTurnstile("x")).skipped).toBe(true);
  });

  it("rejects a missing token once a secret IS configured — fails closed", async () => {
    process.env.TURNSTILE_SECRET_KEY = "real-secret";
    const r = await verifyTurnstile(null);
    expect(r.ok).toBe(false);
    expect(r.skipped).toBe(false);
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
