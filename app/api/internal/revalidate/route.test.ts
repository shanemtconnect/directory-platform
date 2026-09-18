import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";

const revalidatePath = vi.fn<(p: string) => void>();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...args: unknown[]) => limitPublicWrite(...args),
}));

const ENV = { ...process.env };
const SECRET = "correct-horse-battery-staple";
const allowed: RateLimitResult = { allowed: true, remaining: 59, retryAfterSeconds: 0 };
const blocked: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 42 };

function post(body: unknown, auth?: string, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (auth !== undefined) headers.authorization = auth;
  return new Request("http://localhost:3211/api/internal/revalidate", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("POST /api/internal/revalidate", () => {
  beforeEach(() => {
    revalidatePath.mockReset();
    limitPublicWrite.mockReset().mockResolvedValue(allowed);
    process.env.INTERNAL_REVALIDATE_SECRET = SECRET;
  });
  afterEach(() => {
    process.env = { ...ENV };
  });

  it("is a 404 when the secret is not configured, whatever the caller sends", async () => {
    delete process.env.INTERNAL_REVALIDATE_SECRET;
    const { POST } = await import("./route");

    const res = await POST(post({ paths: ["/leeds"] }, `Bearer ${SECRET}`));

    expect(res.status).toBe(404);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("is a 404 without a bearer token", async () => {
    const { POST } = await import("./route");
    expect((await POST(post({ paths: ["/leeds"] }))).status).toBe(404);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("is a 404 for the wrong token, including one of a different length", async () => {
    const { POST } = await import("./route");
    expect((await POST(post({ paths: ["/leeds"] }, "Bearer nope"))).status).toBe(404);
    expect((await POST(post({ paths: ["/leeds"] }, `Bearer ${SECRET}x`))).status).toBe(404);
    expect((await POST(post({ paths: ["/leeds"] }, SECRET))).status).toBe(404);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("revalidates each path with the right token and reports the count", async () => {
    const { POST } = await import("./route");

    const res = await POST(post({ paths: ["/leeds/the-old-mill", "/leeds/the-old-mill/reviews", "/leeds"] }, `Bearer ${SECRET}`));

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revalidated: 3 });
    expect(revalidatePath.mock.calls.map(([p]) => p)).toEqual([
      "/leeds/the-old-mill",
      "/leeds/the-old-mill/reviews",
      "/leeds",
    ]);
  });

  it("caps a request at 100 paths", async () => {
    const { MAX_PATHS, POST } = await import("./route");
    expect(MAX_PATHS).toBe(100);
    const paths = Array.from({ length: 101 }, (_, i) => `/city-${i}`);

    const res = await POST(post({ paths }, `Bearer ${SECRET}`));

    expect(res.status).toBe(400);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects absolute URLs, protocol-relative paths and anything not site-relative", async () => {
    const { POST } = await import("./route");
    for (const bad of [
      "https://evil.example/leeds",
      "//evil.example/leeds",
      "/\\evil.example",
      "leeds",
      "",
      "javascript:alert(1)",
    ]) {
      const res = await POST(post({ paths: ["/leeds", bad] }, `Bearer ${SECRET}`));
      expect(res.status, bad).toBe(400);
    }
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it("rejects a body that is not { paths: string[] }", async () => {
    const { POST } = await import("./route");
    expect((await POST(post("not json", `Bearer ${SECRET}`))).status).toBe(400);
    expect((await POST(post({ paths: "/leeds" }, `Bearer ${SECRET}`))).status).toBe(400);
    expect((await POST(post({ paths: [42] }, `Bearer ${SECRET}`))).status).toBe(400);
    expect((await POST(post({}, `Bearer ${SECRET}`))).status).toBe(400);
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  describe("throttle", () => {
    it("counts a request only once the bearer has matched", async () => {
      const { POST } = await import("./route");
      await POST(post({ paths: ["/leeds"] }));
      await POST(post({ paths: ["/leeds"] }, "Bearer nope"));
      delete process.env.INTERNAL_REVALIDATE_SECRET;
      await POST(post({ paths: ["/leeds"] }, `Bearer ${SECRET}`));

      expect(limitPublicWrite).not.toHaveBeenCalled();
    });

    it("uses its own bucket at sixty a minute", async () => {
      const { INTERNAL_REVALIDATE_RATE_LIMIT } = await import("@/lib/spam/write-limit");
      expect(INTERNAL_REVALIDATE_RATE_LIMIT).toEqual({ limit: 60, windowSeconds: 60 });
      const { POST } = await import("./route");

      const req = post({ paths: ["/leeds"] }, `Bearer ${SECRET}`, { "x-forwarded-for": "10.0.0.7" });
      await POST(req);

      expect(limitPublicWrite).toHaveBeenCalledTimes(1);
      const [feature, headers, opts] = limitPublicWrite.mock.calls[0]!;
      expect(feature).toBe("internal-revalidate");
      expect((headers as Headers).get("x-forwarded-for")).toBe("10.0.0.7");
      expect(opts).toBe(INTERNAL_REVALIDATE_RATE_LIMIT);
    });

    it("is a 429 with Retry-After once the bucket is spent, and revalidates nothing", async () => {
      limitPublicWrite.mockResolvedValue(blocked);
      const { POST } = await import("./route");

      const res = await POST(post({ paths: ["/leeds"] }, `Bearer ${SECRET}`));

      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("42");
      expect(revalidatePath).not.toHaveBeenCalled();
    });
  });

  describe("body cap", () => {
    it("is 16 KB", async () => {
      const { MAX_BODY_BYTES } = await import("./route");
      expect(MAX_BODY_BYTES).toBe(16 * 1024);
    });

    it("is a 413 on a Content-Length over the cap, before the body is read", async () => {
      const { POST } = await import("./route");

      const res = await POST(
        post({ paths: ["/leeds"] }, `Bearer ${SECRET}`, { "content-length": String(16 * 1024 + 1) }),
      );

      expect(res.status).toBe(413);
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("is a 413 when the bytes that arrive are over the cap, whatever the header said", async () => {
      const { POST } = await import("./route");
      // 100 paths of ~200 bytes each: within the path count, over the byte cap.
      // Multi-byte characters, so the string's length understates the wire.
      const paths = Array.from({ length: 100 }, (_, i) => `/${"é".repeat(100)}-${i}`);
      const body = JSON.stringify({ paths });
      expect(Buffer.byteLength(body)).toBeGreaterThan(16 * 1024);

      const res = await POST(post(body, `Bearer ${SECRET}`, { "content-length": "100" }));

      expect(res.status).toBe(413);
      expect(revalidatePath).not.toHaveBeenCalled();
    });

    it("takes a body at the cap without a Content-Length, as fetch may send it", async () => {
      const { POST } = await import("./route");
      const path = `/${"a".repeat(2000)}`;
      const paths = Array.from({ length: 8 }, () => path);
      const body = JSON.stringify({ paths });
      expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16 * 1024);

      const res = await POST(post(body, `Bearer ${SECRET}`));

      expect(res.status).toBe(200);
      expect(revalidatePath).toHaveBeenCalledTimes(8);
    });
  });

  it("treats an empty list as nothing to do", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ paths: [] }, `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revalidated: 0 });
  });
});
