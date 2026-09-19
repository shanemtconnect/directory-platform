import { describe, it, expect } from "vitest";
import { links, text } from "@/test/elements";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("puts the test id on the wrapper and keeps the copy readable", () => {
    const el = EmptyState({
      title: "Nothing is waiting.",
      children: "New submissions land here.",
      testId: "submission-queue-empty",
    });
    expect((el.props as Record<string, unknown>)["data-testid"]).toBe("submission-queue-empty");
    expect(text(el)).toContain("Nothing is waiting.");
    expect(text(el)).toContain("New submissions land here.");
  });

  it("renders the next action as a link", () => {
    const el = EmptyState({ title: "x", action: { href: "/search", label: "Find it" } });
    expect(links(el)).toEqual([{ href: "/search", text: "Find it" }]);
  });

  it("renders no link when there is no action", () => {
    expect(links(EmptyState({ title: "x" }))).toHaveLength(0);
  });
});
