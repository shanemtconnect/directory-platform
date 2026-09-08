import { describe, it, expect, beforeAll } from "vitest";
import { presignUpload } from "./r2";
import { MAX_UPLOAD_BYTES } from "./validate";

beforeAll(() => {
  process.env.R2_ACCOUNT_ID = "test-account";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
});

interface Policy {
  conditions: unknown[];
}

function policyOf(fields: Record<string, string>): Policy {
  return JSON.parse(Buffer.from(fields["Policy"]!, "base64").toString("utf8")) as Policy;
}

describe("presignUpload", () => {
  /**
   * A presigned PUT signs the key and nothing else: the holder can upload a
   * 4 GB file, or an HTML page with a Content-Type that makes the CDN serve it
   * back as a script. A POST policy is the only form that lets the server put
   * a size and a type on the browser's upload.
   */
  it("caps the upload at the configured size", async () => {
    const { fields } = await presignUpload("media", "listing/1/original.jpg");
    expect(policyOf(fields).conditions).toContainEqual([
      "content-length-range", 1, MAX_UPLOAD_BYTES,
    ]);
  });

  it("refuses an empty upload as well as an oversized one", async () => {
    const { fields } = await presignUpload("media", "listing/1/original.jpg");
    const range = policyOf(fields).conditions.find(
      (c): c is [string, number, number] => Array.isArray(c) && c[0] === "content-length-range",
    );
    expect(range?.[1]).toBe(1);
  });

  it("constrains the Content-Type the browser may declare", async () => {
    const { fields } = await presignUpload("media", "listing/1/original.jpg");
    expect(policyOf(fields).conditions).toContainEqual(["starts-with", "$Content-Type", "image/"]);
  });

  it("takes a different type prefix for claim documents", async () => {
    const { fields } = await presignUpload("docs", "claim/1.pdf", {
      contentTypePrefix: "application/pdf",
    });
    expect(policyOf(fields).conditions).toContainEqual([
      "starts-with", "$Content-Type", "application/pdf",
    ]);
  });

  it("returns the key the browser must post back with the form", async () => {
    const { url, fields } = await presignUpload("media", "listing/1/original.jpg");
    expect(fields["key"]).toBe("listing/1/original.jpg");
    expect(url).toContain("media");
  });
});
