import { describe, it, expect, afterEach } from "vitest";
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
    ["/admin/reviews", "Reviews"],
    ["/admin/cities", "Towns"],
    ["/admin/reports", "Reports"],
    ["/admin/removals", "Removals"],
    ["/admin/quotes", "Quotes"],
    ["/admin/sponsors", "Sponsors"],
    ["/admin/spots", "Featured"],
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

describe("AdminNav counts", () => {
  it("shows a count beside a queue that has work, and none beside one that does not", () => {
    const el = AdminNav({ current: "/admin", counts: { "/admin/claims": 4 } });
    const claims = links(el).find((l) => l.href === "/admin/claims");
    const reviews = links(el).find((l) => l.href === "/admin/reviews");

    expect(claims?.text).toBe("Claims44 waiting");
    expect(reviews?.text).toBe("Reviews");
  });

  it("renders the same links with no counts at all", () => {
    expect(links(AdminNav({ current: "/admin" })).map((l) => l.text)).toEqual([
      "Dashboard", "Submissions", "Claims", "Reviews", "Towns", "Reports", "Removals", "Quotes", "Sponsors", "Featured", "Audit log",
    ]);
  });
});

describe("AdminNav — neighbourhoods (Task 52)", () => {
  const ENV = { ...process.env };
  afterEach(() => {
    process.env = { ...ENV };
  });

  it("links /admin/neighbourhoods only while the module is on", () => {
    process.env.NEIGHBOURHOODS_ENABLED = "true";
    expect(links(AdminNav({ current: "/admin" }))).toContainEqual({ href: "/admin/neighbourhoods", text: "Neighbourhoods" });
    process.env.NEIGHBOURHOODS_ENABLED = "false";
    expect(links(AdminNav({ current: "/admin" })).map((l) => l.href)).not.toContain("/admin/neighbourhoods");
  });
});

