import { describe, it, expect } from "vitest";
import { siteConfig } from "@/config/site.config";
import { isUuid, stripCrlf, validateEnquiry, validateSubmission } from "./validation";

const LISTING_ID = "3f7c1c8a-6b6e-4a1e-9c2a-9a5a7b1d4e21";
const CATEGORY_ID = "8c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

function formOf(fields: Record<string, string>): FormData {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return form;
}

const enquiry = (patch: Record<string, string> = {}) =>
  formOf({
    listingId: LISTING_ID,
    name: "Sam Owner",
    email: "sam@example.co.uk",
    phone: "01632 960000",
    message: "We are looking for somewhere for about eighty people in June.",
    ...patch,
  });

const submission = (patch: Record<string, string> = {}) =>
  formOf({
    name: "The Old Mill",
    categoryId: CATEGORY_ID,
    region: "West Yorkshire",
    city: "Leeds",
    addressLine1: "1 Mill Lane",
    postcode: "LS1 4DY",
    phone: "01632 960000",
    website: "example.co.uk",
    description:
      "A long enough description of the business to clear the fifty character minimum length check.",
    submitterName: "Sam Owner",
    submitterEmail: "sam@example.co.uk",
    tier: Object.keys(siteConfig.tiers)[0]!,
    ...patch,
  });

describe("isUuid", () => {
  it("accepts a canonical uuid in either case", () => {
    expect(isUuid(LISTING_ID)).toBe(true);
    expect(isUuid(LISTING_ID.toUpperCase())).toBe(true);
  });

  it("rejects anything Postgres would throw on", () => {
    // "invalid input syntax for type uuid" used to escape the action as a 500.
    for (const bad of ["", "not-a-uuid", "1; drop table listings", `${LISTING_ID} `]) {
      expect(isUuid(bad)).toBe(false);
    }
  });
});

describe("stripCrlf", () => {
  it("leaves ordinary text alone", () => {
    expect(stripCrlf("Sam Owner")).toBe("Sam Owner");
  });

  it("replaces newlines with a space so words do not run together", () => {
    expect(stripCrlf("Sam\r\nBcc: victim@example.com")).toBe("Sam Bcc: victim@example.com");
    expect(stripCrlf("one\n\n\ntwo")).toBe("one two");
  });
});

describe("validateEnquiry", () => {
  it("accepts a good enquiry and hands back trimmed values", () => {
    const { values, errors } = validateEnquiry(enquiry({ name: "  Sam Owner  " }));
    expect(errors).toBeUndefined();
    expect(values).toMatchObject({
      listingId: LISTING_ID,
      name: "Sam Owner",
      email: "sam@example.co.uk",
      phone: "01632 960000",
    });
  });

  it("treats a blank phone as no phone", () => {
    expect(validateEnquiry(enquiry({ phone: "  " })).values?.phone).toBeNull();
  });

  it("rejects a listingId that is not a uuid", () => {
    const { values, errors } = validateEnquiry(enquiry({ listingId: "../../etc/passwd" }));
    expect(values).toBeUndefined();
    expect(errors?.listingId).toBeTruthy();
  });

  it("rejects a missing listingId", () => {
    const form = enquiry();
    form.delete("listingId");
    expect(validateEnquiry(form).errors?.listingId).toBeTruthy();
  });

  it("strips CR/LF out of the name — an email header is one newline away", () => {
    const { values } = validateEnquiry(
      enquiry({ name: "Sam\r\nBcc: victim@example.com" }),
    );
    expect(values?.name).toBe("Sam Bcc: victim@example.com");
    expect(values?.name).not.toMatch(/[\r\n]/);
  });

  it("strips CR/LF out of the phone number too", () => {
    expect(validateEnquiry(enquiry({ phone: "01632\r\n960000" })).values?.phone).toBe(
      "01632 960000",
    );
  });

  it("strips CR/LF out of the message", () => {
    const { values } = validateEnquiry(
      enquiry({ message: "Line one about the booking.\nLine two about the date." }),
    );
    expect(values?.message).not.toMatch(/[\r\n]/);
  });

  it("still catches the ordinary mistakes", () => {
    expect(validateEnquiry(enquiry({ name: "A" })).errors?.name).toBeTruthy();
    expect(validateEnquiry(enquiry({ email: "nope" })).errors?.email).toBeTruthy();
    expect(validateEnquiry(enquiry({ message: "too short" })).errors?.message).toBeTruthy();
    expect(validateEnquiry(enquiry({ message: "x".repeat(2001) })).errors?.message).toBeTruthy();
  });
});

describe("validateSubmission", () => {
  it("accepts a good submission", () => {
    const { values, errors } = validateSubmission(submission());
    expect(errors).toBeUndefined();
    expect(values).toMatchObject({ name: "The Old Mill", categoryId: CATEGORY_ID, city: "Leeds" });
    expect(values?.website).toBe("https://example.co.uk/");
  });

  it("rejects a categoryId that is not a uuid, as a field error", () => {
    const { values, errors } = validateSubmission(submission({ categoryId: "'; select 1--" }));
    expect(values).toBeUndefined();
    expect(errors?.categoryId).toBeTruthy();
  });

  it("still rejects an empty category", () => {
    expect(validateSubmission(submission({ categoryId: "" })).errors?.categoryId).toBeTruthy();
  });

  it("strips CR/LF out of the business name and phone", () => {
    const { values } = validateSubmission(
      submission({ name: "The Old Mill\r\nBcc: victim@example.com", phone: "01632\r\n960000" }),
    );
    expect(values?.name).toBe("The Old Mill Bcc: victim@example.com");
    expect(values?.phone).toBe("01632 960000");
  });

  it("still catches the ordinary mistakes", () => {
    expect(validateSubmission(submission({ name: "A" })).errors?.name).toBeTruthy();
    expect(validateSubmission(submission({ postcode: "nonsense" })).errors?.postcode).toBeTruthy();
    expect(validateSubmission(submission({ description: "too short" })).errors?.description)
      .toBeTruthy();
    expect(validateSubmission(submission({ tier: "platinum" })).errors?.tier).toBeTruthy();
    expect(validateSubmission(submission({ submitterEmail: "nope" })).errors?.submitterEmail)
      .toBeTruthy();
  });
});
