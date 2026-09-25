import { describe, expect, it } from "vitest";
import { isLeadTarget } from "./lead-target";

describe("isLeadTarget", () => {
  it("is an unclaimed listing with no email, only with the lead marketplace on", () => {
    expect(isLeadTarget(true, { claimStatus: "unclaimed", email: null })).toBe(true);
    expect(isLeadTarget(true, { claimStatus: "unclaimed", email: "   " })).toBe(true);
    expect(isLeadTarget(false, { claimStatus: "unclaimed", email: null })).toBe(false);
    expect(isLeadTarget(true, { claimStatus: "unclaimed", email: "hall@example.com" })).toBe(false);
    expect(isLeadTarget(true, { claimStatus: "claimed", email: null })).toBe(false);
    expect(isLeadTarget(true, { claimStatus: "verified", email: null })).toBe(false);
  });
});
