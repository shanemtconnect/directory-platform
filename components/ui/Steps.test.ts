import { describe, it, expect } from "vitest";
import { elements, text } from "@/test/elements";
import { Steps } from "./Steps";

const STEPS = ["Sign in", "Prove it", "Confirm", "Manage"] as const;

describe("Steps", () => {
  it("marks exactly the current step with aria-current", () => {
    const items = [...elements(Steps({ steps: STEPS, current: 2 }))].filter((e) => e.type === "li");
    expect(items).toHaveLength(4);
    const current = items.filter(
      (e) => (e.props as Record<string, unknown>)["aria-current"] === "step",
    );
    expect(current).toHaveLength(1);
    expect(text(current[0])).toContain("Confirm");
  });

  it("labels done, current and to-do states", () => {
    const items = [...elements(Steps({ steps: STEPS, current: 1 }))].filter((e) => e.type === "li");
    expect(items.map((e) => (e.props as { "data-state": string })["data-state"])).toEqual([
      "done",
      "current",
      "todo",
      "todo",
    ]);
  });

  it("says the position in words for a screen reader", () => {
    expect(text(Steps({ steps: STEPS, current: 0 }))).toContain("Step 1 of 4, current: Sign in");
  });
});
