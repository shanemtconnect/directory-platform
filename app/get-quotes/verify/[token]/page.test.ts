import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QuoteTokenPreview } from "@/lib/db/queries/quotes";
import type { RateLimitResult } from "@/lib/spam/rate-limit";
import { elements, text } from "@/test/elements";

/**
 * The page the emailed link opens. It must NOT confirm anything — only
 * preview the token and offer the POST button — because scanners GET links.
 */

class NotFound extends Error {}
class Redirect extends Error {}

const previewQuoteToken = vi.fn<(...a: unknown[]) => Promise<QuoteTokenPreview>>();
const verifyQuoteToken = vi.fn();
const limitPublicWrite = vi.fn<(...a: unknown[]) => Promise<RateLimitResult>>();
let quoteBroadcast = true;

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw new Redirect(to);
  },
}));
vi.mock("next/headers", () => ({ headers: () => Promise.resolve(new Headers()) }));
vi.mock("@/lib/db/client", () => ({ db: { marker: "the pool" } }));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { quoteBroadcast };
  },
  isEnabled: (flag: string) => flag === "quoteBroadcast" && quoteBroadcast,
}));
vi.mock("@/lib/db/queries/quotes", () => ({
  previewQuoteToken: (...a: unknown[]) => previewQuoteToken(...a),
  verifyQuoteToken: (...a: unknown[]) => verifyQuoteToken(...a),
}));
vi.mock("@/lib/spam/write-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/spam/write-limit")>()),
  limitPublicWrite: (...a: unknown[]) => limitPublicWrite(...a),
}));

beforeEach(() => {
  vi.resetModules();
  quoteBroadcast = true;
  previewQuoteToken.mockReset().mockResolvedValue({ outcome: "live", source: "quote" });
  verifyQuoteToken.mockReset();
  limitPublicWrite.mockReset().mockResolvedValue({ allowed: true, remaining: 29, retryAfterSeconds: 0 });
});

async function render(token = "tok%2Blive") {
  const { default: page } = await import("./page");
  return page({ params: Promise.resolve({ token }) });
}

describe("/get-quotes/verify/[token]", () => {
  it("offers a POST button to …/confirm and confirms nothing itself", async () => {
    const tree = await render();

    expect(previewQuoteToken).toHaveBeenCalledWith(expect.anything(), { role: "public" }, "tok+live");
    expect(verifyQuoteToken).not.toHaveBeenCalled();
    const form = [...elements(tree)].find((el) => el.type === "form");
    expect(form?.props).toMatchObject({ method: "post", action: "/get-quotes/verify/tok%2Blive/confirm" });
    expect(text(tree)).toMatch(/Confirm my request/);
  });

  it("calls an enquiry's link an enquiry", async () => {
    previewQuoteToken.mockResolvedValue({ outcome: "live", source: "enquiry" });
    expect(text(await render())).toMatch(/Confirm my enquiry/);
  });

  it.each([
    ["already-verified", "already"],
    ["expired", "expired"],
    ["unknown", "unknown"],
  ] as const)("sends a %s link to the page that says so", async (outcome, state) => {
    previewQuoteToken.mockResolvedValue({ outcome });
    await expect(render()).rejects.toThrow(`/get-quotes/confirmed?state=${state}`);
  });

  it("counts every view against the confirm bucket and looks nothing up over it", async () => {
    limitPublicWrite.mockResolvedValue({ allowed: false, remaining: 0, retryAfterSeconds: 30 });
    expect(text(await render())).toMatch(/Too many attempts/);
    expect(limitPublicWrite).toHaveBeenCalledWith("quote-verify", expect.any(Headers), { limit: 30, windowSeconds: 60 });
    expect(previewQuoteToken).not.toHaveBeenCalled();
  });

  it("404s with quotes off", async () => {
    quoteBroadcast = false;
    await expect(render()).rejects.toThrow(NotFound);
  });
});
