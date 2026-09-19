import { describe, it, expect } from "vitest";
import { siteConfig } from "@/config/site.config";
import { validateReview, REVIEW_MAX } from "./validate";

const LISTING = "11111111-2222-3333-4444-555555555555";

function form(overrides: Record<string, string> = {}): FormData {
  const f = new FormData();
  const base: Record<string, string> = {
    listingId: LISTING,
    rating: "4",
    title: "Did what they said",
    body: "We used them in March and the whole thing was straightforward from the first reply to the final invoice.",
    displayName: "Sam P",
    email: "sam@example.com",
  };
  for (const [k, v] of Object.entries({ ...base, ...overrides })) f.set(k, v);
  return f;
}

describe("validateReview", () => {
  it("accepts a complete review", () => {
    const result = validateReview(form());
    expect(result.errors).toBeUndefined();
    expect(result.values).toMatchObject({
      listingId: LISTING,
      rating: 4,
      title: "Did what they said",
      displayName: "Sam P",
      email: "sam@example.com",
    });
  });

  it("lowercases the email, because the one-review-per-email index is exact", () => {
    expect(validateReview(form({ email: "  Sam@Example.COM " })).values?.email)
      .toBe("sam@example.com");
  });

  it("rejects a listing id that is not a uuid", () => {
    expect(validateReview(form({ listingId: "nope" })).errors?.listingId).toBeTruthy();
  });

  it.each(["0", "6", "", "4.5", "four", "1e0"])("rejects a rating of %o", (rating) => {
    expect(validateReview(form({ rating })).errors?.rating).toBeTruthy();
  });

  it.each(["1", "2", "3", "4", "5"])("accepts a rating of %o", (rating) => {
    const result = validateReview(form({ rating }));
    expect(result.errors).toBeUndefined();
    expect(result.values?.rating).toBe(Number(rating));
  });

  it("keeps sub-ratings that match a configured criterion", () => {
    const key = siteConfig.reviewCriteria[0]!.key;
    const result = validateReview(form({ [`sub_${key}`]: "5" }));
    expect(result.values?.subRatings).toEqual({ [key]: 5 });
  });

  it("drops a sub-rating for a criterion this site does not have", () => {
    const result = validateReview(form({ sub_notacriterion: "5" }));
    expect(result.values?.subRatings).toBeNull();
  });

  it("rejects an out-of-range sub-rating rather than silently dropping it", () => {
    const key = siteConfig.reviewCriteria[0]!.key;
    expect(validateReview(form({ [`sub_${key}`]: "9" })).errors?.[`sub_${key}`]).toBeTruthy();
  });

  it("treats an unanswered sub-rating as no answer", () => {
    const key = siteConfig.reviewCriteria[0]!.key;
    const result = validateReview(form({ [`sub_${key}`]: "" }));
    expect(result.errors).toBeUndefined();
    expect(result.values?.subRatings).toBeNull();
  });

  it("requires something to read", () => {
    expect(validateReview(form({ body: "" })).errors?.body).toBeTruthy();
  });

  it("caps the body", () => {
    expect(validateReview(form({ body: "a".repeat(REVIEW_MAX.body + 1) })).errors?.body)
      .toBeTruthy();
  });

  it("caps the title and the display name", () => {
    expect(validateReview(form({ title: "a".repeat(REVIEW_MAX.title + 1) })).errors?.title)
      .toBeTruthy();
    expect(
      validateReview(form({ displayName: "a".repeat(REVIEW_MAX.displayName + 1) }))
        .errors?.displayName,
    ).toBeTruthy();
  });

  it("requires a display name — an anonymous review is not a review", () => {
    expect(validateReview(form({ displayName: "" })).errors?.displayName).toBeTruthy();
  });

  it("requires a plausible email, because the address is what verifies it", () => {
    expect(validateReview(form({ email: "not-an-address" })).errors?.email).toBeTruthy();
  });

  it("strips CR and LF from the single-line fields", () => {
    const result = validateReview(form({ displayName: "Sam\r\nBcc: someone@example.com" }));
    expect(result.values?.displayName ?? "").not.toMatch(/[\r\n]/);
  });

  it("keeps paragraph breaks in the body", () => {
    const body = `${"First paragraph of a review that is long enough to pass."}\r\n\r\nSecond.`;
    expect(validateReview(form({ body })).values?.body).toContain("\n\n");
    expect(validateReview(form({ body })).values?.body).not.toContain("\r");
  });

  it("returns an empty title as null rather than an empty string", () => {
    expect(validateReview(form({ title: "" })).values?.title).toBeNull();
  });
});
