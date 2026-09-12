import { describe, it, expect } from "vitest";
import { plausibleDomain, PLAUSIBLE_SCRIPT_SRC } from "./plausible";

describe("plausibleDomain", () => {
  it("is undefined when nothing is configured", () => {
    expect(plausibleDomain(undefined)).toBeUndefined();
    expect(plausibleDomain("")).toBeUndefined();
    expect(plausibleDomain("   ")).toBeUndefined();
  });

  it("passes a bare hostname through, trimmed", () => {
    expect(plausibleDomain(" example.co.uk ")).toBe("example.co.uk");
  });

  it("accepts the several-domains form Plausible supports", () => {
    expect(plausibleDomain("example.co.uk,www.example.co.uk")).toBe(
      "example.co.uk,www.example.co.uk",
    );
  });

  it("rejects a URL pasted in place of a hostname", () => {
    // Plausible silently ignores a data-domain with a scheme or a path, so the
    // site would ship a script that reports nothing, to nobody, indefinitely.
    // No script at all is the failure somebody notices.
    expect(plausibleDomain("https://example.co.uk")).toBeUndefined();
    expect(plausibleDomain("example.co.uk/")).toBeUndefined();
    expect(plausibleDomain("example.co.uk?x=1")).toBeUndefined();
    expect(plausibleDomain("example .co.uk")).toBeUndefined();
  });

  it("reads the inlined build-time constant by its literal name", () => {
    // NEXT_PUBLIC_ values are substituted into the source text by `next build`.
    // Reaching one through a variable inlines nothing and the browser gets
    // undefined — see lib/observability/sentry.ts.
    expect(plausibleDomain.toString()).toContain("process.env.NEXT_PUBLIC_PLAUSIBLE_DOMAIN");
  });
});

describe("PLAUSIBLE_SCRIPT_SRC", () => {
  it("is the hosted script, over https", () => {
    expect(PLAUSIBLE_SCRIPT_SRC).toBe("https://plausible.io/js/script.js");
  });
});
