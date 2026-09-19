import { describe, it, expect } from "vitest";
import { elements, text } from "@/test/elements";
import { Notice } from "./Notice";

/**
 * The role follows the variant and nothing else: an error interrupts, the
 * rest wait. The message is the only text in the notice — the icon is an SVG
 * with no characters in it — so a test that reads `toHaveText("Saved.")` on
 * the wrapper still passes after a bare paragraph became a Notice.
 */
describe("Notice", () => {
  it.each([
    ["status", "status", "polite"],
    ["success", "status", "polite"],
    ["error", "alert", "assertive"],
  ] as const)("%s renders role=%s and aria-live=%s", (variant, role, live) => {
    const el = Notice({ variant, children: "Hello" });
    const props = el.props as Record<string, unknown>;

    expect(props.role).toBe(role);
    expect(props["aria-live"]).toBe(live);
    expect(props["data-variant"]).toBe(variant);
    expect(String(props.className)).toContain(`notice-${variant}`);
  });

  it("defaults to a status notice", () => {
    const el = Notice({ children: "Hello" });
    expect((el.props as { role: string }).role).toBe("status");
  });

  it("passes the test id through to the wrapper", () => {
    const el = Notice({ children: "Saved.", testId: "profile-message" });
    expect((el.props as Record<string, unknown>)["data-testid"]).toBe("profile-message");
  });

  it("contains only the message and the title as text", () => {
    expect(text(Notice({ children: "Saved." }))).toBe("Saved.");
    expect(text(Notice({ title: "Done", children: "Saved." }))).toBe("DoneSaved.");
  });

  it("hides the icon from assistive technology", () => {
    const svg = [...elements(Notice({ children: "x" }))].find((e) => e.type === "svg");
    expect((svg?.props as Record<string, unknown>)["aria-hidden"]).toBe(true);
  });
});
