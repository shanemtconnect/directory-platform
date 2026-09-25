import { describe, it, expect, vi } from "vitest";
import type { LookupFunction } from "node:net";
import type { Dispatcher } from "undici";
import { fetchPublicHtml, SafeFetchError, type Resolver, type SafeFetch } from "./safe-fetch";

/*
 * The guard itself is covered exhaustively by lib/badge/backlink.test.ts,
 * which drives it through checkBacklink. These are the contract of the
 * shared entry point: what it returns, and that every failure is a
 * SafeFetchError rather than a result a caller could mistake for a page.
 */

const PUBLIC: Resolver = async () => ["93.184.216.34"];
const ok = (html: string): Response =>
  new Response(html, { status: 200, headers: { "Content-Type": "text/html" } });

describe("fetchPublicHtml", () => {
  it("returns the page, the URL that served it and its status", async () => {
    const fetchImpl = (async () => ok("<title>Hi</title>")) as unknown as SafeFetch;
    const page = await fetchPublicHtml("https://client.example/about", { resolve: PUBLIC, fetchImpl });
    expect(page).toEqual({
      finalUrl: "https://client.example/about",
      html: "<title>Hi</title>",
      status: 200,
    });
  });

  it("refuses http://127.0.0.1 before it fetches anything", async () => {
    const fetchImpl = vi.fn();
    const attempt = fetchPublicHtml("http://127.0.0.1/", {
      resolve: PUBLIC,
      fetchImpl: fetchImpl as unknown as SafeFetch,
    });
    await expect(attempt).rejects.toBeInstanceOf(SafeFetchError);
    await expect(attempt).rejects.toThrow(/private/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("throws a SafeFetchError carrying the status for a non-2xx page", async () => {
    const fetchImpl = (async () => new Response("gone", { status: 404 })) as unknown as SafeFetch;
    const error = await fetchPublicHtml("https://client.example/", { resolve: PUBLIC, fetchImpl })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SafeFetchError);
    expect(error).toMatchObject({ status: 404, finalUrl: "https://client.example/" });
  });

  it("sends the caller's user agent", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("user-agent") ?? "");
      return ok("");
    }) as unknown as SafeFetch;
    await fetchPublicHtml("https://client.example/", {
      resolve: PUBLIC, fetchImpl, userAgent: "tester/1.0 (+https://dir.example/trust)",
    });
    expect(seen).toEqual(["tester/1.0 (+https://dir.example/trust)"]);
  });

  it("uses a caller's approve step on every hop, and pins what it approved", async () => {
    let lookup: LookupFunction | null = null;
    const agentFactory = (fn: LookupFunction): Dispatcher => {
      lookup = fn;
      return { close: async () => {} } as unknown as Dispatcher;
    };
    const approve = vi.fn(async (raw: string) => ({ url: new URL(raw), addresses: ["127.0.0.1"] }));
    const pinned: string[] = [];
    const fetchImpl = (async (url: string) => {
      await new Promise<void>((resolve, reject) =>
        lookup!(new URL(url).hostname, { all: true }, (err, address) => {
          if (err) return reject(err);
          pinned.push(...(address as unknown as { address: string }[]).map((a) => a.address));
          resolve();
        }),
      );
      return ok("fixture");
    }) as unknown as SafeFetch;

    const page = await fetchPublicHtml("http://localhost:3255/e2e/import-fixture", {
      approve, fetchImpl, agentFactory,
    });

    expect(page.html).toBe("fixture");
    expect(approve).toHaveBeenCalledWith("http://localhost:3255/e2e/import-fixture", expect.any(Function));
    expect(pinned).toEqual(["127.0.0.1"]);
  });
});
