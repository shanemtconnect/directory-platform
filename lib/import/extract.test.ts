import { describe, it, expect } from "vitest";
import { extractBusiness, IMPORT_DESCRIPTION_MAX } from "./extract";

const BASE = "https://harbourlight.example/about";

const OG_ONLY = `<!doctype html><html><head>
  <title>Home | Harbour Light Studio</title>
  <meta property="og:site_name" content="Harbour Light Studio">
  <meta property="og:title" content="Home">
  <meta property='og:description' content="Portraits &amp; product photography on the quay, since 2009.">
  <meta name="description" content="A plainer description that loses to og:description.">
</head><body></body></html>`;

const JSON_LD = `<html><head>
<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    { "@type": "WebSite", "name": "Not the business", "url": "https://harbourlight.example/" },
    {
      "@type": ["LocalBusiness", "ProfessionalService"],
      "name": "Harbour Light Studio Ltd",
      "description": "Portrait studio on the harbour.",
      "telephone": "01632 960123",
      "url": "https://www.harbourlight.example/",
      "address": {
        "@type": "PostalAddress",
        "streetAddress": "4 Quay Street",
        "addressLocality": "Porthaven",
        "addressRegion": "Cornwall",
        "postalCode": "TR1 1AA"
      },
      "sameAs": ["https://facebook.com/harbourlight", "https://instagram.com/harbourlight", "not a url"]
    }
  ]
}
</script></head><body></body></html>`;

describe("extractBusiness", () => {
  it("reads OpenGraph tags when that is all there is", () => {
    expect(extractBusiness(OG_ONLY, BASE)).toEqual({
      name: "Harbour Light Studio",
      description: "Portraits & product photography on the quay, since 2009.",
      website: "https://harbourlight.example",
    });
  });

  it("reads a JSON-LD LocalBusiness with a PostalAddress", () => {
    expect(extractBusiness(JSON_LD, BASE)).toEqual({
      name: "Harbour Light Studio Ltd",
      description: "Portrait studio on the harbour.",
      phone: "01632 960123",
      website: "https://www.harbourlight.example/",
      addressLine1: "4 Quay Street",
      city: "Porthaven",
      region: "Cornwall",
      postcode: "TR1 1AA",
      socials: ["https://facebook.com/harbourlight", "https://instagram.com/harbourlight"],
    });
  });

  it("prefers JSON-LD over OpenGraph, and fills gaps from OpenGraph", () => {
    const both = OG_ONLY.replace(
      "</head>",
      `<script type="application/ld+json">{"@type":"Organization","name":"Harbour Light Studio Ltd","telephone":"01632 960999"}</script></head>`,
    );
    expect(extractBusiness(both, BASE)).toEqual({
      name: "Harbour Light Studio Ltd",
      description: "Portraits & product photography on the quay, since 2009.",
      phone: "01632 960999",
      website: "https://harbourlight.example",
    });
  });

  it("skips a malformed JSON-LD block and keeps reading the rest", () => {
    const html = `<head>
      <script type="application/ld+json">{ "@type": "LocalBusiness", "name": "Broken", }</script>
      <script type="application/ld+json">{"@type":"LocalBusiness","name":"Whole","telephone":"01632 960555"}</script>
      <meta property="og:description" content="Still read.">
    </head>`;
    expect(extractBusiness(html, BASE)).toEqual({
      name: "Whole",
      description: "Still read.",
      phone: "01632 960555",
      website: "https://harbourlight.example",
    });
  });

  it("returns nothing but the fetched origin for a page with no metadata", () => {
    expect(extractBusiness("<html><body><p>Hello</p></body></html>", BASE)).toEqual({
      website: "https://harbourlight.example",
    });
  });

  it("falls back to <title> for the name", () => {
    expect(extractBusiness("<title>  Harbour\n Light </title>", BASE).name).toBe("Harbour Light");
  });

  it("ignores metadata inside HTML comments and tolerates > inside attribute values", () => {
    const html = `<!-- <meta property="og:site_name" content="Old name"> -->
      <meta content="Fish -> chips" property="og:site_name">`;
    expect(extractBusiness(html, BASE).name).toBe("Fish -> chips");
  });

  it("trims a long description to what the form accepts, on a word boundary", () => {
    const long = "word ".repeat(400).trim();
    const { description } = extractBusiness(`<meta property="og:description" content="${long}">`, BASE);
    expect(description!.length).toBeLessThanOrEqual(IMPORT_DESCRIPTION_MAX);
    expect(description!.endsWith("word")).toBe(true);
  });

  it("does not take a Person or a WebSite for the business", () => {
    const html = `<script type="application/ld+json">[
      {"@type":"Person","name":"Jo Bloggs","telephone":"01632 960111","address":{"streetAddress":"1 Home Road"}},
      {"@type":"WebSite","name":"Site"}
    ]</script>`;
    expect(extractBusiness(html, BASE)).toEqual({ website: "https://harbourlight.example" });
  });

  it("reads an address given as a plain string, and ignores a non-http website", () => {
    const html = `<script type="application/ld+json">{"@type":"Store","name":"Shop","url":"javascript:alert(1)","address":"9 Market Row"}</script>`;
    expect(extractBusiness(html, BASE)).toEqual({
      name: "Shop",
      addressLine1: "9 Market Row",
      website: "https://harbourlight.example",
    });
  });
});
