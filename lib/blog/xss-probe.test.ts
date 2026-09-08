import { describe, it, expect } from "vitest";
import { renderMarkdown } from "./posts";

/**
 * Adversarial probe over the ONE place we call dangerouslySetInnerHTML.
 *
 * The invariant is not "the output never contains the word onerror" — escaped
 * text may legitimately contain it. The invariant is that every tag in the
 * output was emitted by the renderer, and no attribute can be injected. So we
 * assert on TAGS and ATTRIBUTES, not on substrings.
 */
const ALLOWED = /^(p|h[1-6]|a|strong|em|ul|ol|li|code|pre|br|blockquote)$/;

function disallowedTags(html: string): string[] {
  return [...html.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9-]*)/g)]
    .map((m) => m[1]!.toLowerCase())
    .filter((t) => !ALLOWED.test(t));
}

function eventAttributes(html: string): string[] {
  // An on*= attribute INSIDE a tag, not in escaped body text.
  return [...html.matchAll(/<[^>]*?\s(on[a-z]+)\s*=/gi)].map((m) => m[1]!);
}

const ATTACKS = [
  "<script>alert(1)</script>",
  "<img src=x onerror=alert(1)>",
  "[click](javascript:alert(1))",
  "[click](data:text/html,<script>alert(1)</script>)",
  "**bold<svg onload=alert(1)>**",
  "<iframe src='//evil.test'></iframe>",
  '[x](https://ok.test "onmouseover=alert(1)")',
  "`<script>alert(1)</script>`",
  '</p><script>alert(1)</script><p>',
  '[x](" onmouseover="alert(1))',
  "<a href=\"javascript:alert(1)\">x</a>",
  "![img](javascript:alert(1))",
];

describe("renderMarkdown — adversarial", () => {
  for (const attack of ATTACKS) {
    it(`emits no injected tag or attribute for: ${attack.slice(0, 44)}`, () => {
      const html = renderMarkdown(attack);
      expect(disallowedTags(html)).toEqual([]);
      expect(eventAttributes(html)).toEqual([]);
      expect(html).not.toMatch(/href\s*=\s*"\s*javascript:/i);
      expect(html).not.toMatch(/href\s*=\s*"\s*data:/i);
    });
  }

  it("still renders legitimate markdown", () => {
    const html = renderMarkdown("# Title\n\nSome **bold** and [a link](https://ok.test).");
    expect(html).toContain("<h1>");
    expect(html).toContain("<strong>");
    expect(html).toContain('href="https://ok.test"');
  });
});
