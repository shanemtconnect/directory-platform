import { describe, it, expect } from "vitest";
import { elements, links, text } from "@/test/elements";
import { PageHeader } from "./PageHeader";

describe("PageHeader", () => {
  it("renders exactly one h1 holding only the title", () => {
    const h1s = [...elements(PageHeader({ title: "Claims", lede: "What is waiting." }))].filter(
      (e) => e.type === "h1",
    );
    expect(h1s).toHaveLength(1);
    expect(text(h1s[0])).toBe("Claims");
  });

  it("renders the back link as a real anchor with its test id", () => {
    const el = PageHeader({
      title: "x",
      back: { href: "/admin/claims", label: "Claims", testId: "back" },
    });
    expect(links(el)).toContainEqual({ href: "/admin/claims", text: "← Claims" });
    const a = [...elements(el)].find((e) => e.type === "a");
    expect((a?.props as Record<string, unknown>)["data-testid"]).toBe("back");
  });

  it("omits the back paragraph and the lede when not given", () => {
    const el = PageHeader({ title: "x" });
    expect(links(el)).toHaveLength(0);
    expect([...elements(el)].some((e) => e.type === "p")).toBe(false);
  });
});
