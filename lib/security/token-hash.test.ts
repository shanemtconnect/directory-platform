import { describe, expect, it } from "vitest";
import { hashToken } from "./token-hash";

describe("hashToken", () => {
  it("is 64 lowercase hex characters whatever the input", () => {
    expect(hashToken("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(hashToken("x".repeat(500))).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic, so a lookup can hash what it is handed", () => {
    expect(hashToken("the-same-token")).toBe(hashToken("the-same-token"));
  });

  it("does not collide on the differences a lookup must tell apart", () => {
    expect(hashToken("token-1")).not.toBe(hashToken("token-2"));
    expect(hashToken("token")).not.toBe(hashToken("token "));
  });

  it("does not contain the token", () => {
    const raw = "QUITE-recognisable-TOKEN";
    expect(hashToken(raw)).not.toContain(raw);
  });
});
