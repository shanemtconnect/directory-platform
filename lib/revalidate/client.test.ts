import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PATHS_PER_REQUEST, revalidatePaths } from "./client";

const SITE = "https://example.co.uk";
const ENV = { NEXT_PUBLIC_SITE_URL: SITE, INTERNAL_REVALIDATE_SECRET: "s3cret" };

function okFetch() {
  return vi.fn(async () => Response.json({ revalidated: 1 }));
}

describe("revalidatePaths", () => {
  const log = vi.fn<(line: string) => void>();
  beforeEach(() => log.mockReset());

  it("POSTs the paths to the internal route with the bearer secret", async () => {
    const fetchImpl = okFetch();

    const out = await revalidatePaths(["/leeds/the-old-mill", "/leeds"], { env: ENV, fetchImpl, log });

    expect(out).toEqual({ sent: 2, skipped: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SITE}/api/internal/revalidate`);
    expect(init.method).toBe("POST");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer s3cret");
    expect(JSON.parse(String(init.body))).toEqual({ paths: ["/leeds/the-old-mill", "/leeds"] });
  });

  it("strips a trailing slash from the site URL and de-duplicates the paths", async () => {
    const fetchImpl = okFetch();

    await revalidatePaths(["/a", "/a", "/b"], { env: { ...ENV, NEXT_PUBLIC_SITE_URL: `${SITE}/` }, fetchImpl, log });

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${SITE}/api/internal/revalidate`);
    expect(JSON.parse(String(init.body))).toEqual({ paths: ["/a", "/b"] });
  });

  it("sends nothing and says so when the secret is unset — logging once, not per call", async () => {
    const fetchImpl = okFetch();
    const env = { NEXT_PUBLIC_SITE_URL: SITE };

    const first = await revalidatePaths(["/a"], { env, fetchImpl, log });
    const second = await revalidatePaths(["/b"], { env, fetchImpl, log });

    expect(first).toEqual({ sent: 0, skipped: true });
    expect(second).toEqual({ sent: 0, skipped: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.mock.calls.filter(([l]) => l.includes("INTERNAL_REVALIDATE_SECRET"))).toHaveLength(1);
  });

  it("does nothing for an empty list", async () => {
    const fetchImpl = okFetch();
    expect(await revalidatePaths([], { env: ENV, fetchImpl, log })).toEqual({ sent: 0, skipped: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("splits a long list into requests the route will accept", async () => {
    const fetchImpl = okFetch();
    const paths = Array.from({ length: MAX_PATHS_PER_REQUEST + 5 }, (_, i) => `/city-${i}`);

    const out = await revalidatePaths(paths, { env: ENV, fetchImpl, log });

    expect(out.sent).toBe(MAX_PATHS_PER_REQUEST + 5);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    const bodies = fetchImpl.mock.calls.map((c) => {
      const [, init] = c as unknown as [string, RequestInit];
      return (JSON.parse(String(init.body)) as { paths: string[] }).paths.length;
    });
    expect(bodies).toEqual([MAX_PATHS_PER_REQUEST, 5]);
  });

  it("never throws: a network failure is logged and reported, not raised", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });

    const out = await revalidatePaths(["/a"], { env: ENV, fetchImpl, log });

    expect(out).toEqual({ sent: 0, skipped: false });
    expect(log.mock.calls.some(([l]) => l.includes("ECONNREFUSED"))).toBe(true);
  });

  it("never throws: a non-2xx answer is logged with its status", async () => {
    const fetchImpl = vi.fn(async () => new Response("nope", { status: 404 }));

    const out = await revalidatePaths(["/a"], { env: ENV, fetchImpl, log });

    expect(out).toEqual({ sent: 0, skipped: false });
    expect(log.mock.calls.some(([l]) => l.includes("404"))).toBe(true);
  });
});
