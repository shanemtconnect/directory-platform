import { describe, it, expect } from "vitest";
import { text } from "@/test/elements";
import { SubmitButton } from "./SubmitButton";

describe("SubmitButton", () => {
  it("is a primary submit with its label when idle", () => {
    const el = SubmitButton({ children: "Save", pendingLabel: "Saving…", pending: false });
    const props = el.props as Record<string, unknown>;
    expect(props.type).toBe("submit");
    expect(props.disabled).toBe(false);
    expect(props["aria-busy"]).toBeUndefined();
    expect(String(props.className)).toBe("btn btn-primary");
    expect(text(el)).toBe("Save");
  });

  it("is disabled, busy and relabelled while pending", () => {
    const el = SubmitButton({ children: "Save", pendingLabel: "Saving…", pending: true });
    const props = el.props as Record<string, unknown>;
    expect(props.disabled).toBe(true);
    expect(props["aria-busy"]).toBe(true);
    expect(text(el)).toBe("Saving…");
  });

  it("supports the secondary variant, block width, a test id and a name/value pair", () => {
    const el = SubmitButton({
      children: "Reject",
      pendingLabel: "…",
      pending: false,
      variant: "secondary",
      block: true,
      testId: "reject",
      name: "decision",
      value: "rejected",
    });
    const props = el.props as Record<string, unknown>;
    expect(String(props.className)).toBe("btn btn-secondary w-full");
    expect(props["data-testid"]).toBe("reject");
    expect(props.name).toBe("decision");
    expect(props.value).toBe("rejected");
  });
});
