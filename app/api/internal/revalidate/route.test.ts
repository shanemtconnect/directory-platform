import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const revalidatePath = vi.fn<(p: string) => void>();
vi.mock("next/cache", () => ({ revalidatePath: (p: string) => revalidatePath(p) }));

const ENV = { ...process.env };
const SECRET = "correct-horse-battery-staple";

function post(body: unknown, auth?: string): Request {
  const headers: Record<string, string> = { "content-type": "application/json" };
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

  it("treats an empty list as nothing to do", async () => {
    const { POST } = await import("./route");
    const res = await POST(post({ paths: [] }, `Bearer ${SECRET}`));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ revalidated: 0 });
  });
});
