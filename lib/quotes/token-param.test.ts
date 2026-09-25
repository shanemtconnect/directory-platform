import { describe, expect, it } from "vitest";
import { decodeTokenParam } from "./token-param";

describe("decodeTokenParam", () => {
  it("decodes an escaped token and passes a plain one through", () => {
    expect(decodeTokenParam("a%2Bb%2Fc")).toBe("a+b/c");
    expect(decodeTokenParam("abc_-123")).toBe("abc_-123");
  });

  it("turns a malformed escape into the empty (unknown) token instead of throwing", () => {
    expect(decodeTokenParam("%E0%A4%A")).toBe("");
    expect(decodeTokenParam("%")).toBe("");
  });
});
