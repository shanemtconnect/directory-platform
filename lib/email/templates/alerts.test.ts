import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import { DIGEST_MAX_MATCHES, savedSearchDigest, type SavedSearchDigestData } from "./alerts";

const ENV = { ...process.env };
beforeEach(() => {
  process.env.NEXT_PUBLIC_SITE_URL = "https://example.co.uk";
});
afterEach(() => {
  process.env = { ...ENV };
});

const match = (i: number) => ({
  title: `Match ${i} <b>`,
  url: `https://example.co.uk/leeds/match-${i}`,
  place: "Leeds",
});

function data(n: number, patch: Partial<SavedSearchDigestData> = {}): SavedSearchDigestData {
  return {
    kind: "listings",
    label: "Barns in Leeds",
    matches: Array.from({ length: n }, (_, i) => match(i + 1)),
    searchUrl: "https://example.co.uk/search?q=barn&city=leeds",
    manageUrl: "https://example.co.uk/account/alerts",
    unsubscribeToken: "payload.signature",
    ...patch,
  };
}

describe("savedSearchDigest", () => {
  it("lists every match when there are at most ten, escaped, with no 'more' line", () => {
    const email = savedSearchDigest(data(3));
    expect(email.subject).toBe(`3 new ${siteConfig.entity.plural} for "Barns in Leeds"`);
    for (const i of [1, 2, 3]) {
      expect(email.text).toContain(`https://example.co.uk/leeds/match-${i}`);
      expect(email.html).toContain(`Match ${i} &lt;b&gt;`);
    }
    expect(email.html).not.toContain("<b>");
    expect(email.text).not.toMatch(/and \d+ more/);
  });

  it(`shows at most ${DIGEST_MAX_MATCHES} and links the rest as "and N more"`, () => {
    const email = savedSearchDigest(data(14));
    expect(email.subject).toBe(`14 new ${siteConfig.entity.plural} for "Barns in Leeds"`);
    expect(email.text).toContain("match-10");
    expect(email.text).not.toContain("match-11");
    expect(email.text).toContain("And 4 more");
    expect(email.text).toContain("https://example.co.uk/search?q=barn&city=leeds");
    expect(email.html).toContain('href="https://example.co.uk/search?q=barn&amp;city=leeds"');
  });

  it("carries the unsubscribe link and the manage link in every digest", () => {
    for (const n of [1, 12]) {
      const email = savedSearchDigest(data(n));
      expect(email.text).toContain("/unsubscribe?t=payload.signature");
      expect(email.html).toContain("/unsubscribe?t=payload.signature");
      expect(email.text).toContain("https://example.co.uk/account/alerts");
    }
  });

  it("says jobs for a jobs search and singular for one match", () => {
    expect(savedSearchDigest(data(1, { kind: "jobs", label: "Leeds" })).subject).toBe('1 new job for "Leeds"');
    expect(savedSearchDigest(data(1)).subject).toBe(`1 new ${siteConfig.entity.singular} for "Barns in Leeds"`);
  });
});
