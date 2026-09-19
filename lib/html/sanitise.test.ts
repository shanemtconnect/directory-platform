import { describe, expect, it } from "vitest";
import { sanitiseRichText } from "./sanitise";

describe("sanitiseRichText", () => {
  it("keeps the tags intro copy is actually written in", () => {
    const html = "<p>Hello <strong>there</strong> and <em>welcome</em>.</p><ul><li>One</li></ul>";
    expect(sanitiseRichText(html)).toBe(html);
  });

  it("keeps an anchor's href and drops everything else on it", () => {
    expect(sanitiseRichText(`<a href="/cities" class="x" onclick="steal()">Cities</a>`))
      .toBe(`<a href="/cities">Cities</a>`);
  });

  it("drops a javascript: href but keeps the link text", () => {
    // The attack this whole module exists for: an href is the one attribute
    // that survives, so it is the one that has to be schemed.
    expect(sanitiseRichText(`<a href="javascript:alert(1)">Click</a>`)).toBe("<a>Click</a>");
    expect(sanitiseRichText(`<a href="  JaVaScRiPt:alert(1)">Click</a>`)).toBe("<a>Click</a>");
    expect(sanitiseRichText(`<a href="data:text/html,<script>">Click</a>`)).toBe("<a>Click</a>");
  });

  it("allows http, https, mailto, tel, root-relative and fragment hrefs", () => {
    for (const href of ["https://x.test/a", "http://x.test", "mailto:a@b.test", "tel:+441534000000", "/city/jersey", "#faq"]) {
      expect(sanitiseRichText(`<a href="${href}">t</a>`)).toBe(`<a href="${href}">t</a>`);
    }
  });

  it("rejects a protocol-relative href, which only looks site-relative", () => {
    expect(sanitiseRichText(`<a href="//evil.test/x">t</a>`)).toBe("<a>t</a>");
  });

  it("unwraps a tag that is not allowed but keeps its text", () => {
    expect(sanitiseRichText("<div><p>Kept</p></div>")).toBe("<p>Kept</p>");
    expect(sanitiseRichText("<span>Kept</span>")).toBe("Kept");
  });

  it("deletes script and style outright, content included", () => {
    expect(sanitiseRichText("<p>a</p><script>alert(1)</script><p>b</p>")).toBe("<p>a</p><p>b</p>");
    expect(sanitiseRichText("<style>body{display:none}</style>ok")).toBe("ok");
    expect(sanitiseRichText("<iframe src='//evil.test'>fallback</iframe>ok")).toBe("ok");
  });

  it("escapes a bare angle bracket instead of guessing at a tag", () => {
    expect(sanitiseRichText("5 < 6 & 7 > 6")).toBe("5 &lt; 6 &amp; 7 &gt; 6");
  });

  it("is not fooled by a > inside a quoted attribute value", () => {
    expect(sanitiseRichText(`<a href="/a" title="x > y">t</a>`)).toBe(`<a href="/a">t</a>`);
  });

  it("closes tags the source left open, and drops closers with nothing open", () => {
    expect(sanitiseRichText("<p>unclosed")).toBe("<p>unclosed</p>");
    expect(sanitiseRichText("</p>stray")).toBe("stray");
    expect(sanitiseRichText("<ul><li>a</ul>")).toBe("<ul><li>a</li></ul>");
  });

  it("emits br as a void element and never closes it", () => {
    expect(sanitiseRichText("a<br>b<br/>c")).toBe("a<br>b<br>c");
  });

  it("strips comments, doctypes and processing instructions", () => {
    expect(sanitiseRichText("<!-- <script>x</script> -->ok")).toBe("ok");
    expect(sanitiseRichText("<!doctype html>ok")).toBe("ok");
  });

  it("never emits a < that it did not write itself", () => {
    // A fuzz-ish backstop: whatever goes in, every < in the output opens a tag
    // whose name is on the allow list.
    const nasties = [
      `<img src=x onerror=alert(1)>`,
      `<svg/onload=alert(1)>`,
      `<a href=x onmouseover="alert(1)">t</a>`,
      `<<script>script>alert(1)<</script>/script>`,
      `<p onclick="x">t</p>`,
      `<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>`,
      `<a href="&#106;avascript:alert(1)">t</a>`,
    ];
    for (const input of nasties) {
      const out = sanitiseRichText(input);
      expect(out).not.toMatch(/on[a-z]+=/i);
      expect(out).not.toMatch(/javascript:/i);
      for (const tag of out.matchAll(/<\/?([a-z0-9]*)/gi)) {
        expect(["p", "br", "strong", "em", "b", "i", "a", "ul", "ol", "li", "h2", "h3", "blockquote"])
          .toContain((tag[1] ?? "").toLowerCase());
      }
    }
  });

  it("passes the seed's own intro copy through untouched", () => {
    const seeded =
      "<p>Demo Directory lists venues in Saint Helier, Jersey. They include bars and halls.</p>" +
      "<p>Every entry has its own page with an address, contact details and an enquiry form.</p>";
    expect(sanitiseRichText(seeded)).toBe(seeded);
  });

  it("returns an empty string for empty input", () => {
    expect(sanitiseRichText("")).toBe("");
  });
});
