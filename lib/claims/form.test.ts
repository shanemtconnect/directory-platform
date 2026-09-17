import { describe, expect, it } from "vitest";
import { validateDocumentClaim, validateDomainClaim } from "./form";

const LISTING = "11111111-1111-4111-8111-111111111111";

function form(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

describe("validateDomainClaim", () => {
  it("accepts a business address and trims the optional fields", () => {
    const { values, errors } = validateDomainClaim(form({
      listingId: LISTING,
      businessEmail: "  Jo@OldMill.example ",
      claimantName: " Jo Bloggs ",
      roleAtBusiness: "",
    }));
    expect(errors).toBeUndefined();
    expect(values).toEqual({
      listingId: LISTING,
      businessEmail: "Jo@OldMill.example",
      claimantName: "Jo Bloggs",
      roleAtBusiness: null,
    });
  });

  it("refuses a listing id that is not a uuid — a hidden field is never a typo", () => {
    const { errors } = validateDomainClaim(form({ listingId: "x", businessEmail: "jo@a.example" }));
    expect(errors?.listingId).toBeTruthy();
  });

  it("asks for a valid address", () => {
    expect(validateDomainClaim(form({ listingId: LISTING, businessEmail: "" })).errors?.businessEmail)
      .toBeTruthy();
    expect(validateDomainClaim(form({ listingId: LISTING, businessEmail: "nope" })).errors?.businessEmail)
      .toBeTruthy();
  });

  it("strips CR and LF, which would otherwise reach a mail header", () => {
    const { values } = validateDomainClaim(form({
      listingId: LISTING,
      businessEmail: "jo@oldmill.example",
      claimantName: "Jo\r\nBcc: someone@example.com",
    }));
    expect(values?.claimantName).not.toMatch(/[\r\n]/);
  });

  it("caps the free-text fields", () => {
    const { errors } = validateDomainClaim(form({
      listingId: LISTING,
      businessEmail: "jo@oldmill.example",
      claimantName: "a".repeat(200),
    }));
    expect(errors?.claimantName).toBeTruthy();
  });
});

describe("validateDocumentClaim", () => {
  it("needs no email, because the document is the evidence", () => {
    const { values, errors } = validateDocumentClaim(form({
      listingId: LISTING,
      claimantName: "Jo Bloggs",
      roleAtBusiness: "Manager",
      evidenceNotes: "Utility bill in the business name.",
    }));
    expect(errors).toBeUndefined();
    expect(values?.evidenceNotes).toBe("Utility bill in the business name.");
  });

  it("insists on a name, since a document claim is read by a person", () => {
    expect(validateDocumentClaim(form({ listingId: LISTING })).errors?.claimantName).toBeTruthy();
  });

  it("keeps paragraph breaks in the notes but caps the length", () => {
    const ok = validateDocumentClaim(form({
      listingId: LISTING, claimantName: "Jo", evidenceNotes: "One.\r\n\r\nTwo.",
    }));
    expect(ok.values?.evidenceNotes).toBe("One.\n\nTwo.");
    const long = validateDocumentClaim(form({
      listingId: LISTING, claimantName: "Jo", evidenceNotes: "a".repeat(1200),
    }));
    expect(long.errors?.evidenceNotes).toBeTruthy();
  });
});
