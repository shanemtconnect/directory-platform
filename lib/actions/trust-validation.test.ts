import { describe, it, expect } from "vitest";
import { validateRemovalRequest, validateReport } from "./trust-validation";

const LISTING = "11111111-2222-4333-8444-555555555555";

function form(fields: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}

function reportForm(patch: Record<string, string> = {}): FormData {
  return form({
    listingId: LISTING,
    reason: "closed",
    detail: "They shut in March and the sign has gone.",
    reporterEmail: "spotter@example.co.uk",
    ...patch,
  });
}

function removalForm(patch: Record<string, string> = {}): FormData {
  return form({
    listingId: LISTING,
    requesterName: "Alex Owner",
    requesterEmail: "alex@example.co.uk",
    relationship: "owner",
    reason: "I never asked to be listed.",
    ...patch,
  });
}

describe("validateReport", () => {
  it("accepts a complete report", () => {
    const { values, errors } = validateReport(reportForm());
    expect(errors).toBeUndefined();
    expect(values).toEqual({
      listingId: LISTING,
      reason: "closed",
      detail: "They shut in March and the sign has gone.",
      reporterEmail: "spotter@example.co.uk",
    });
  });

  it("accepts a report with no email and no detail", () => {
    const { values, errors } = validateReport(reportForm({ reporterEmail: "", detail: "" }));
    expect(errors).toBeUndefined();
    expect(values?.reporterEmail).toBeNull();
    expect(values?.detail).toBeNull();
  });

  it("rejects a reason that is not one of ours", () => {
    // A select, so this is a tampered form rather than a mistake.
    expect(validateReport(reportForm({ reason: "libellous" })).errors).toMatchObject({
      reason: expect.any(String),
    });
    expect(validateReport(reportForm({ reason: "" })).errors).toMatchObject({
      reason: expect.any(String),
    });
  });

  it("asks for detail when the reason is 'other', which says nothing on its own", () => {
    expect(validateReport(reportForm({ reason: "other", detail: "" })).errors).toMatchObject({
      detail: expect.any(String),
    });
    expect(validateReport(reportForm({ reason: "other", detail: "The photo is of a different building entirely." })).errors)
      .toBeUndefined();
  });

  it("rejects a listing id that is not a uuid", () => {
    expect(validateReport(reportForm({ listingId: "nope" })).errors).toMatchObject({
      listingId: expect.any(String),
    });
  });

  it("rejects an email that cannot be one", () => {
    expect(validateReport(reportForm({ reporterEmail: "spotter@" })).errors).toMatchObject({
      reporterEmail: expect.any(String),
    });
  });

  it("rejects detail longer than the cap", () => {
    expect(validateReport(reportForm({ detail: "x".repeat(1001) })).errors).toMatchObject({
      detail: expect.any(String),
    });
  });

  it("keeps the paragraphs somebody typed into the detail", () => {
    const { values } = validateReport(reportForm({ detail: "First line.\r\n\r\nSecond line." }));
    expect(values?.detail).toBe("First line.\n\nSecond line.");
  });

  it("rejects an email carrying a header injection rather than storing it", () => {
    // stripCrlf collapses the break to a space, which the email pattern then
    // refuses — the address never reaches a header with a Bcc bolted on.
    expect(validateReport(reportForm({ reporterEmail: "a@b.co\r\nBcc: c@d.co" })).errors)
      .toMatchObject({ reporterEmail: expect.any(String) });
  });
});

describe("validateRemovalRequest", () => {
  it("accepts a complete request", () => {
    const { values, errors } = validateRemovalRequest(removalForm());
    expect(errors).toBeUndefined();
    expect(values).toEqual({
      listingId: LISTING,
      requesterName: "Alex Owner",
      requesterEmail: "alex@example.co.uk",
      relationship: "owner",
      reason: "I never asked to be listed.",
    });
  });

  it("accepts a request with no reason, because we do not require one", () => {
    const { values, errors } = validateRemovalRequest(removalForm({ reason: "" }));
    expect(errors).toBeUndefined();
    expect(values?.reason).toBeNull();
  });

  it("requires a name and a working email, because the answer has to reach someone", () => {
    expect(validateRemovalRequest(removalForm({ requesterName: "A" })).errors).toMatchObject({
      requesterName: expect.any(String),
    });
    expect(validateRemovalRequest(removalForm({ requesterEmail: "alex@" })).errors).toMatchObject({
      requesterEmail: expect.any(String),
    });
  });

  it("rejects a relationship that is not one of ours", () => {
    expect(validateRemovalRequest(removalForm({ relationship: "landlord" })).errors).toMatchObject({
      relationship: expect.any(String),
    });
  });

  it("rejects a listing id that is not a uuid", () => {
    expect(validateRemovalRequest(removalForm({ listingId: "nope" })).errors).toMatchObject({
      listingId: expect.any(String),
    });
  });

  it("rejects a reason longer than the cap", () => {
    expect(validateRemovalRequest(removalForm({ reason: "x".repeat(1001) })).errors).toMatchObject({
      reason: expect.any(String),
    });
  });

  it("strips CR and LF from the name, which reaches an email header", () => {
    const { values } = validateRemovalRequest(
      removalForm({ requesterName: "Alex\r\nBcc: someone@example.com" }),
    );
    expect(values?.requesterName).toBe("Alex Bcc: someone@example.com");
  });
});
