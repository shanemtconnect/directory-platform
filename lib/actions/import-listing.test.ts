import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import type { FetchedPage, SafeFetchDeps } from "@/lib/net/safe-fetch";

/**
 * The add-listing URL import. The fetch and the extractor are tested on their
 * own (lib/net, lib/import); what is only testable here is the order the
 * action spends things in, and what it says when the page cannot be read.
 */

const rateLimit = vi.fn<(key: string | null, opts: unknown) => Promise<RateLimitResult>>();
const fetchPublicHtml = vi.fn<(url: string, deps?: SafeFetchDeps) => Promise<FetchedPage>>();
let requestHeaders = new Headers();

vi.mock("next/headers", () => ({ headers: () => Promise.resolve(requestHeaders) }));
vi.mock("@/lib/spam/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/rate-limit")>()),
  rateLimit: (key: string | null, opts: unknown) => rateLimit(key, opts),
}));
vi.mock("@/lib/net/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/net/safe-fetch")>()),
  fetchPublicHtml: (url: string, deps?: SafeFetchDeps) => fetchPublicHtml(url, deps),
}));

const REFUSAL =
  "We couldn't read that page. Facebook and Google pages usually block this — fill the form in below.";
const ALLOWED: RateLimitResult = { allowed: true, remaining: 9, retryAfterSeconds: 0 };
const BLOCKED: RateLimitResult = { allowed: false, remaining: 0, retryAfterSeconds: 1800 };
const PAGE: FetchedPage = {
  finalUrl: "https://harbourlight.example/",
  status: 200,
  html: `<script type="application/ld+json">{"@type":"LocalBusiness","name":"Harbour Light","telephone":"01632 960123"}</script>`,
};

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

async function run(fields: Record<string, string>) {
  const { importFromUrl } = await import("./import-listing");
  return importFromUrl({ status: "idle" }, form(fields));
}

beforeEach(() => {
  vi.resetModules();
  requestHeaders = new Headers({ "x-forwarded-for": "203.0.113.9" });
  rateLimit.mockReset().mockResolvedValue(ALLOWED);
  fetchPublicHtml.mockReset().mockResolvedValue(PAGE);
});

describe("importFromUrl", () => {
  it("returns what the page says about the business", async () => {
    const state = await run({ url: "https://harbourlight.example/" });
    expect(state).toEqual({
      status: "imported",
      values: { name: "Harbour Light", phone: "01632 960123", website: "https://harbourlight.example" },
    });
  });

  it("adds https:// to a bare domain, as the submit form does", async () => {
    await run({ url: "harbourlight.example" });
    expect(fetchPublicHtml).toHaveBeenCalledWith("https://harbourlight.example/", expect.anything());
  });

  it("gives the plain-English refusal when the page cannot be fetched", async () => {
    const { SafeFetchError } = await import("@/lib/net/safe-fetch");
    fetchPublicHtml.mockRejectedValue(new SafeFetchError("HTTP 403", 403, "https://facebook.com/x"));
    expect(await run({ url: "https://facebook.com/x" })).toEqual({ status: "error", message: REFUSAL });
  });

  it("gives the same refusal for a page with nothing on it to read", async () => {
    fetchPublicHtml.mockResolvedValue({ ...PAGE, html: "<p>Log in to continue</p>" });
    expect(await run({ url: "https://harbourlight.example/" })).toEqual({ status: "error", message: REFUSAL });
  });

  it("counts against a budget of ten an hour per connection, before fetching", async () => {
    await run({ url: "https://harbourlight.example/" });
    expect(rateLimit).toHaveBeenCalledWith(
      expect.stringMatching(/^import-url:/),
      { limit: 10, windowSeconds: 3600 },
    );
  });

  it("stops at the rate limit without fetching", async () => {
    rateLimit.mockResolvedValue(BLOCKED);
    const state = await run({ url: "https://harbourlight.example/" });
    expect(state.status).toBe("error");
    expect(state.status === "error" && state.message).toMatch(/try again in 30 minutes/);
    expect(fetchPublicHtml).not.toHaveBeenCalled();
  });

  it("refuses something that is not a web address before spending the budget", async () => {
    for (const url of ["", "ftp://harbourlight.example/", "http://"]) {
      const state = await run({ url });
      expect(state.status).toBe("error");
    }
    expect(rateLimit).not.toHaveBeenCalled();
    expect(fetchPublicHtml).not.toHaveBeenCalled();
  });

  it("answers a filled honeypot with an empty import and spends nothing", async () => {
    const state = await run({ url: "https://harbourlight.example/", import_company_url: "spam" });
    expect(state).toEqual({ status: "imported", values: {} });
    expect(rateLimit).not.toHaveBeenCalled();
    expect(fetchPublicHtml).not.toHaveBeenCalled();
  });

  it("never passes a loopback allowance outside the e2e suite", async () => {
    await run({ url: "https://harbourlight.example/" });
    expect(fetchPublicHtml.mock.calls[0]![1]!.approve).toBeUndefined();
  });
});

describe("importFromUrl — logging", () => {
  it("logs an unexpected failure but not an ordinary fetch refusal", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { SafeFetchError } = await import("@/lib/net/safe-fetch");
      fetchPublicHtml.mockRejectedValueOnce(new SafeFetchError("HTTP 403", 403, "https://x.example/"));
      expect(await run({ url: "https://x.example/" })).toEqual({ status: "error", message: REFUSAL });
      expect(error).not.toHaveBeenCalled();

      fetchPublicHtml.mockRejectedValueOnce(new TypeError("extractor bug"));
      expect(await run({ url: "https://x.example/" })).toEqual({ status: "error", message: REFUSAL });
      expect(error).toHaveBeenCalledWith("[import-url] import failed:", expect.any(TypeError));
    } finally {
      error.mockRestore();
    }
  });
});
