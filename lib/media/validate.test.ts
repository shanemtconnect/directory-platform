import { describe, it, expect } from "vitest";
import { sniffMime, assertUploadable, LISTING_IMAGE_TYPES, CLAIM_DOCUMENT_TYPES } from "./validate";

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PDF = Buffer.from("%PDF-1.7\n");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([1, 2, 3, 4]), Buffer.from("WEBP")]);
const SVG = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0x00]);

describe("sniffMime", () => {
  it("identifies jpeg, png, webp and pdf by magic bytes", () => {
    expect(sniffMime(JPEG)).toBe("image/jpeg");
    expect(sniffMime(PNG)).toBe("image/png");
    expect(sniffMime(WEBP)).toBe("image/webp");
    expect(sniffMime(PDF)).toBe("application/pdf");
  });

  it("returns null for an SVG, whatever the file is called", () => {
    expect(sniffMime(SVG)).toBeNull();
  });

  it("returns null for a renamed executable", () => {
    expect(sniffMime(EXE)).toBeNull();
  });

  it("returns null for a truncated header rather than reading past the end", () => {
    expect(sniffMime(Buffer.from([0xff]))).toBeNull();
    expect(sniffMime(Buffer.alloc(0))).toBeNull();
  });
});

describe("assertUploadable", () => {
  const listing = { allow: LISTING_IMAGE_TYPES };

  it("accepts a jpeg for listing media", () => {
    expect(assertUploadable(JPEG, listing)).toBe("image/jpeg");
  });

  it("rejects a PDF as listing media even though claim documents allow it", () => {
    expect(() => assertUploadable(PDF, listing)).toThrow(/not allowed/i);
    expect(assertUploadable(PDF, { allow: CLAIM_DOCUMENT_TYPES })).toBe("application/pdf");
  });

  it("rejects anything over 8 MB", () => {
    const big = Buffer.concat([JPEG, Buffer.alloc(8 * 1024 * 1024)]);
    expect(() => assertUploadable(big, listing)).toThrow(/too large/i);
  });

  it("rejects an SVG — this is the stored-XSS vector extension checks miss", () => {
    expect(() => assertUploadable(SVG, listing)).toThrow(/unrecognised/i);
  });

  it("rejects an executable renamed to .jpg", () => {
    expect(() => assertUploadable(EXE, listing)).toThrow(/unrecognised/i);
  });
});
