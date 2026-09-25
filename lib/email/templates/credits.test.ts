import { describe, expect, it } from "vitest";
import { topupReceipt } from "./credits";

describe("topupReceipt", () => {
  it("states the amount added and the new balance, and links the credit page", () => {
    const m = topupReceipt({ name: "Pat", amount: "£50", balance: "£75", creditUrl: "https://example.co.uk/account/credit" });
    expect(m.subject).toContain("£50");
    expect(m.text).toContain("£50");
    expect(m.text).toContain("£75");
    expect(m.text).toContain("Pat");
    expect(m.text).toContain("https://example.co.uk/account/credit");
    expect(m.html).toContain('href="https://example.co.uk/account/credit"');
    // A receipt, not a sales email: PayPal sends the payment receipt.
    expect(m.text).toContain("PayPal");
  });
});
