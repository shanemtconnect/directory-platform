import { describe, it, expect } from "vitest";
import { flagReview, MIN_BODY_CHARS, FLAG_REASONS } from "./moderation";

/**
 * These heuristics decide whether a verified review goes live on its own or
 * waits for a person. Every case below is a real pattern a directory gets.
 */

const ok = {
  title: "Exactly what we needed",
  body: "Booked through here and the whole thing went smoothly. They answered every question before we committed, turned up when they said they would, and the final bill matched the quote.",
  displayName: "Sam P",
};

describe("flagReview", () => {
  it("lets a normal review through", () => {
    expect(flagReview(ok)).toBeNull();
  });

  it("holds a body under the minimum", () => {
    expect(flagReview({ ...ok, body: "Great, thanks." })).toBe("too-short");
  });

  it("measures length after trimming, so padding cannot buy a pass", () => {
    expect(flagReview({ ...ok, body: `   Great.${" ".repeat(200)}` })).toBe("too-short");
  });

  it("counts the minimum in characters", () => {
    expect("a".repeat(MIN_BODY_CHARS - 1).length).toBeLessThan(MIN_BODY_CHARS);
    expect(flagReview({ ...ok, body: "a".repeat(MIN_BODY_CHARS - 1) })).toBe("too-short");
  });

  it.each([
    ["an http link", "https://example.com/offer"],
    ["a bare www host", "see www.example.com for more"],
    ["a bare domain", "we found them at example.co.uk and booked"],
    ["a scheme-less link with a path", "example.com/deals is where the offer is"],
  ])("holds %s in the body", (_label, fragment) => {
    expect(flagReview({ ...ok, body: `${ok.body} ${fragment}` })).toBe("link");
  });

  it("holds a link in the title as well as the body", () => {
    expect(flagReview({ ...ok, title: "Go to example.com" })).toBe("link");
  });

  it("does not read an ordinary sentence as a domain", () => {
    expect(flagReview({ ...ok, body: `${ok.body} We would use them again.No complaints at all.` }))
      .toBeNull();
  });

  it("holds an email address", () => {
    expect(flagReview({ ...ok, body: `${ok.body} Contact me on someone@example.com` }))
      .toBe("contact-details");
  });

  it("holds a phone number, spaced or not", () => {
    expect(flagReview({ ...ok, body: `${ok.body} Call 01748 000000` })).toBe("contact-details");
    expect(flagReview({ ...ok, body: `${ok.body} Call 07700900123` })).toBe("contact-details");
  });

  it("does not read a price or a year as a phone number", () => {
    expect(flagReview({ ...ok, body: `${ok.body} We paid 2400 in March 2026.` })).toBeNull();
  });

  it("holds profanity, whole word only", () => {
    expect(flagReview({ ...ok, body: `${ok.body} Absolute shit.` })).toBe("profanity");
    expect(flagReview({ ...ok, body: `${ok.body} Absolute SHIT.` })).toBe("profanity");
  });

  it("does not flag a word that merely contains a banned one", () => {
    expect(flagReview({ ...ok, body: `${ok.body} The assessment was thorough.` })).toBeNull();
  });

  it("holds a review written in capitals", () => {
    expect(flagReview({ ...ok, body: ok.body.toUpperCase() })).toBe("shouting");
  });

  it("does not call a short all-caps acronym shouting", () => {
    expect(flagReview({ ...ok, body: `${ok.body} The ETA was spot on.` })).toBeNull();
  });

  it("holds an empty body rather than publishing a bare rating", () => {
    expect(flagReview({ ...ok, body: "" })).toBe("too-short");
    expect(flagReview({ ...ok, body: null })).toBe("too-short");
  });

  it("reports the first reason in a fixed order, so the same review always reads the same", () => {
    // Short AND a link: length is checked first.
    expect(flagReview({ ...ok, body: "see example.com" })).toBe("too-short");
    expect(FLAG_REASONS.indexOf("too-short")).toBeLessThan(FLAG_REASONS.indexOf("link"));
  });

  it("returns only reasons it declares", () => {
    const reason = flagReview({ ...ok, body: "no" });
    expect(reason).not.toBeNull();
    expect(FLAG_REASONS).toContain(reason);
  });

  it("reads the display name too — a name is a place to put a URL", () => {
    expect(flagReview({ ...ok, displayName: "best-deals.example.com" })).toBe("link");
  });
});
