import { describe, it, expect, beforeAll } from "vitest";
import { reviewVerification, reviewToAdmin, reviewToOwner } from "./review";

beforeAll(() => { process.env.NEXT_PUBLIC_SITE_URL = "https://example.test"; });

const data = {
  listingName: "The Old Barn",
  listingUrl: "https://example.test/leeds/the-old-barn",
  reviewsUrl: "https://example.test/leeds/the-old-barn/reviews",
  verifyUrl: "https://example.test/review/verify/abc123",
  author: "Sam P",
  rating: 4,
  title: "Did what they said",
  body: "Straightforward from the first reply to the final invoice.",
  flaggedReason: null as string | null,
};

describe("reviewVerification", () => {
  it("carries the link that publishes the review", () => {
    const mail = reviewVerification(data);
    expect(mail.html).toContain(data.verifyUrl);
    expect(mail.text).toContain(data.verifyUrl);
  });

  it("names what is being confirmed", () => {
    const mail = reviewVerification(data);
    expect(mail.subject).toContain("The Old Barn");
  });

  it("never carries a reply-to that would send the reviewer's answer to the business", () => {
    expect(reviewVerification(data).replyTo).toBeUndefined();
  });

  it("does not promise that opening the link publishes anything", () => {
    // Mail scanners, gateway link rewriters, chat previewers and the browser's
    // own prefetcher all GET every URL they see, so opening the link is no
    // longer the last step — there is a Confirm button behind it. Copy that
    // says "one click and it goes live" would be describing the old route.
    const mail = reviewVerification(data);
    expect(mail.text.toLowerCase()).toContain("confirm");
    expect(mail.text.toLowerCase()).not.toContain("click here to publish");
    expect(mail.text.toLowerCase()).not.toContain("one click and your review goes live");
  });

  it("says how long the link lasts", () => {
    expect(reviewVerification(data).text).toContain("7 days");
  });

  it("escapes the review body — mail clients render HTML", () => {
    const mail = reviewVerification({ ...data, body: '<img src=x onerror="alert(1)">' });
    expect(mail.html).not.toContain("<img");
    expect(mail.html).toContain("&lt;img");
  });
});

describe("reviewToAdmin", () => {
  it("says a clean review published itself", () => {
    const mail = reviewToAdmin(data);
    expect(mail.text).toContain("published");
  });

  it("says why a held review is waiting", () => {
    const mail = reviewToAdmin({ ...data, flaggedReason: "link" });
    expect(mail.text).toContain("link");
    expect(mail.subject.toLowerCase()).toContain("held");
  });
});

describe("reviewToOwner", () => {
  it("links the owner to the page their answer goes on", () => {
    const mail = reviewToOwner(data);
    expect(mail.html).toContain(data.reviewsUrl);
  });

  it("does not reply to the reviewer, whose address we do not publish", () => {
    expect(reviewToOwner(data).replyTo).toBeUndefined();
  });
});
