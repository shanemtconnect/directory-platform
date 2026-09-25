import { describe, expect, it } from "vitest";
import { elements, text, links } from "@/test/elements";
import { VerifiedToggle } from "./VerifiedToggle";

const PROPS = { onHref: "/leeds?verified=1", offHref: "/leeds", nounPlural: "venues" };

/** The rendered <a>'s own `rel` prop, however deep it sits under the <p>. */
function anchorRel(el: ReturnType<typeof VerifiedToggle>): string | undefined {
  const [a] = [...elements(el)].filter((n) => n.type === "a");
  return (a?.props as { rel?: string } | undefined)?.rel;
}

describe("VerifiedToggle", () => {
  it("renders nothing when the scope has zero verified listings and the filter isn't already on", () => {
    expect(VerifiedToggle({ ...PROPS, active: false, hasVerified: false })).toBeNull();
  });

  it("still renders — as the way back — when active, even if the scope now has zero verified listings", () => {
    const el = VerifiedToggle({ ...PROPS, active: true, hasVerified: false });
    expect(el).not.toBeNull();
    expect(text(el)).toContain("show all");
  });

  it("renders the ON link, nofollowed, when the scope has a verified listing and the filter is off", () => {
    const el = VerifiedToggle({ ...PROPS, active: false, hasVerified: true });
    const [link] = links(el);
    expect(link?.href).toBe("/leeds?verified=1");
    expect(text(el)).toContain("Show verified venues only");
    expect(anchorRel(el)).toBe("nofollow");
  });

  it("renders the OFF link, not nofollowed, when active", () => {
    const el = VerifiedToggle({ ...PROPS, active: true, hasVerified: true });
    const [link] = links(el);
    expect(link?.href).toBe("/leeds");
    expect(anchorRel(el)).toBeUndefined();
  });
});
