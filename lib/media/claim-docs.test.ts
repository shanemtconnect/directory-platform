import { afterEach, describe, expect, it } from "vitest";
import {
  CLAIM_DOC_MAX_BYTES,
  claimDocKey,
  claimDocsConfigured,
  claimDocsEnv,
  isAllowedClaimDocType,
  presignClaimDocUpload,
} from "./claim-docs";

const ENV = { ...process.env };

function configure(): void {
  process.env.R2_ACCOUNT_ID = "test-account";
  process.env.R2_ACCESS_KEY_ID = "test-key";
  process.env.R2_SECRET_ACCESS_KEY = "test-secret";
  process.env.R2_BUCKET_CLAIM_DOCS = "claim-docs";
}

afterEach(() => {
  process.env = { ...ENV };
});

describe("claimDocsConfigured", () => {
  it("is true only when every R2 value is present", () => {
    configure();
    expect(claimDocsConfigured()).toBe(true);
    for (const key of [
      "R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET_CLAIM_DOCS",
    ]) {
      configure();
      delete process.env[key];
      expect(claimDocsConfigured(), key).toBe(false);
    }
  });

  it("treats whitespace as unset, since that is what a blank .env line leaves", () => {
    configure();
    process.env.R2_BUCKET_CLAIM_DOCS = "   ";
    expect(claimDocsConfigured()).toBe(false);
  });

  it("refuses to hand out a bucket name when it is not configured", () => {
    expect(() => claimDocsEnv()).toThrow(/not configured/i);
  });
});

describe("isAllowedClaimDocType", () => {
  it("takes a PDF or a photograph of a document and nothing else", () => {
    expect(isAllowedClaimDocType("application/pdf")).toBe(true);
    expect(isAllowedClaimDocType("image/jpeg")).toBe(true);
    expect(isAllowedClaimDocType("image/png")).toBe(true);
    // An SVG is a script that renders; a Word document runs macros.
    expect(isAllowedClaimDocType("image/svg+xml")).toBe(false);
    expect(isAllowedClaimDocType("text/html")).toBe(false);
    expect(isAllowedClaimDocType("")).toBe(false);
  });
});

describe("claimDocKey", () => {
  it("files the object under the claim with an extension matching the type", () => {
    const key = claimDocKey("11111111-1111-4111-8111-111111111111", "application/pdf");
    expect(key).toMatch(/^claims\/11111111-1111-4111-8111-111111111111\/proof-[a-f0-9]{16}\.pdf$/);
  });

  it("never repeats a key, so a re-upload cannot overwrite the first attempt", () => {
    const a = claimDocKey("11111111-1111-4111-8111-111111111111", "image/png");
    const b = claimDocKey("11111111-1111-4111-8111-111111111111", "image/png");
    expect(a).not.toBe(b);
    expect(a.endsWith(".png")).toBe(true);
  });

  it("refuses a claim id that is not a uuid, so a key cannot be traversed", () => {
    expect(() => claimDocKey("../../etc", "application/pdf")).toThrow();
  });
});

describe("presignClaimDocUpload", () => {
  interface Policy { conditions: unknown[] }
  const policyOf = (fields: Record<string, string>): Policy =>
    JSON.parse(Buffer.from(fields["Policy"]!, "base64").toString("utf8")) as Policy;

  it("pins the exact content type and the 8 MB cap", async () => {
    configure();
    const key = claimDocKey("11111111-1111-4111-8111-111111111111", "application/pdf");
    const { fields } = await presignClaimDocUpload(key, "application/pdf");
    const conditions = policyOf(fields).conditions;
    expect(conditions).toContainEqual(["starts-with", "$Content-Type", "application/pdf"]);
    expect(conditions).toContainEqual(["content-length-range", 1, CLAIM_DOC_MAX_BYTES]);
    expect(fields["key"]).toBe(key);
  });

  it("will not sign a type outside the allowed list", async () => {
    configure();
    const key = claimDocKey("11111111-1111-4111-8111-111111111111", "application/pdf");
    await expect(presignClaimDocUpload(key, "image/svg+xml")).rejects.toThrow(/not allowed/i);
  });

  it("will not sign anything at all when R2 is unset", async () => {
    const key = "claims/x/proof.pdf";
    await expect(presignClaimDocUpload(key, "application/pdf")).rejects.toThrow(/not configured/i);
  });
});
