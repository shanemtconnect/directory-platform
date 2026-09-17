import { describe, it, expect } from "vitest";
import { elements, links } from "@/test/elements";
import { AdminNav } from "./AdminNav";

/**
 * The console's sub-nav is the only way in to most admin pages: /admin is
 * behind a 404 gate and nothing public links to it. A queue page that exists
 * but is not in this list is a queue nobody opens — which is exactly how the
 * claims queue shipped unreachable once. Every console page is pinned here.
 */

describe("AdminNav", () => {
  it.each([
    ["/admin", "Dashboard"],
    ["/admin/submissions", "Submissions"],
    ["/admin/claims", "Claims"],
    ["/admin/cities", "Towns"],
    ["/admin/reports", "Reports"],
    ["/admin/removals", "Removals"],
    ["/admin/audit", "Audit log"],
  ])("links to %s as %s", (href, label) => {
    expect(links(AdminNav({ current: "/admin" }))).toContainEqual({ href, text: label });
  });

  it("marks the current page and nothing else", () => {
    const current = [...elements(AdminNav({ current: "/admin/claims" }))].filter(
      (el) => (el.props as { "aria-current"?: string })["aria-current"] === "page",
    );

    expect(current).toHaveLength(1);
    expect((current[0]!.props as { href: string }).href).toBe("/admin/claims");
  });
});
