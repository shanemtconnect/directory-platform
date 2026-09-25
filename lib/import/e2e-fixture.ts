import { resolvePublicUrl, type ApprovedUrl, type Resolver } from "@/lib/net/safe-fetch";

/**
 * The e2e suite's stand-in for a business's website.
 *
 * The URL import fetches through the SSRF guard, which refuses loopback — and
 * the only server the e2e suite can rely on is the app itself, on loopback.
 * Rather than weaken the guard, this adds ONE allowance beside it, and only
 * while the e2e suite runs:
 *
 *   - `E2E_IMPORT_FIXTURE=1` — a switch that exists for this and nothing
 *     else, set only in playwright.config.ts's server env, exact value only —
 *     AND `NEXT_PUBLIC_DEMO_MODE=true` (which also gates the fixture route)
 *     AND `PORT` set. A demo or staging box with demo mode on still does not
 *     get the allowance unless someone sets the dedicated switch by hand;
 *   - plain http to `localhost` or `127.0.0.1`, on this server's own `PORT`,
 *     at exactly `IMPORT_FIXTURE_PATH` (after URL normalisation, so `..`
 *     does not walk out of it);
 *   - pinned to 127.0.0.1, so the socket goes nowhere else.
 *
 * Every other URL — including every redirect hop — still goes through
 * `resolvePublicUrl` unchanged.
 */
export const IMPORT_FIXTURE_PATH = "/e2e/import-fixture";

type Env = Partial<Record<"E2E_IMPORT_FIXTURE" | "NEXT_PUBLIC_DEMO_MODE" | "PORT", string | undefined>>;

export function fixtureRouteEnabled(): boolean {
  return process.env["NEXT_PUBLIC_DEMO_MODE"] === "true";
}

export function e2eFixtureApproval(
  env: Env = {
    E2E_IMPORT_FIXTURE: process.env["E2E_IMPORT_FIXTURE"],
    NEXT_PUBLIC_DEMO_MODE: process.env["NEXT_PUBLIC_DEMO_MODE"],
    PORT: process.env["PORT"],
  },
): ((raw: string, resolve: Resolver) => Promise<ApprovedUrl>) | undefined {
  if (env.E2E_IMPORT_FIXTURE !== "1" || env.NEXT_PUBLIC_DEMO_MODE !== "true") return undefined;
  const port = env.PORT?.trim();
  if (!port) return undefined;

  return async (raw, resolve) => {
    let url: URL | null = null;
    try {
      url = new URL(raw);
    } catch {
      url = null;
    }
    if (
      url !== null &&
      url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1") &&
      url.port === port &&
      url.pathname === IMPORT_FIXTURE_PATH
    ) {
      return { url, addresses: ["127.0.0.1"] };
    }
    return resolvePublicUrl(raw, resolve);
  };
}

const escapeAttr = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * The fixture page. The spec passes the fields that must be unique per run
 * (name, phone) and the ones that must match the seed (city, region) as query
 * parameters; everything is escaped, so the page renders them as data only.
 */
export function fixtureHtml(params: URLSearchParams): string {
  const get = (key: string, fallback: string): string => (params.get(key) ?? fallback).slice(0, 200);
  const name = get("name", "Harbour Light Studio");
  const business = {
    "@context": "https://schema.org",
    "@type": "LocalBusiness",
    name,
    description:
      "An end-to-end test page standing in for a business's own website. It exists " +
      "only so the add-listing import can be exercised against a real fetch.",
    telephone: get("phone", "01632 960000"),
    // A real-looking public address: the submit form rejects a dotless host
    // such as `localhost`, which is what the fetched origin would be here.
    url: "https://harbourlight.example/",
    address: {
      "@type": "PostalAddress",
      streetAddress: "4 Quay Street",
      addressLocality: get("city", "Porthaven"),
      addressRegion: get("region", ""),
      postalCode: get("postcode", ""),
    },
  };
  // `<` escaped inside the JSON so no value can close the script element.
  const jsonLd = JSON.stringify(business).replace(/</g, "\\u003c");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="robots" content="noindex, nofollow">
<title>${escapeAttr(name)}</title>
<meta property="og:site_name" content="${escapeAttr(name)}">
<script type="application/ld+json">${jsonLd}</script>
</head><body><h1>${escapeAttr(name)}</h1></body></html>`;
}
