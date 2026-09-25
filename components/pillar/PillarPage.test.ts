import { describe, expect, it } from "vitest";
import { elements, text, links } from "@/test/elements";
import type { PillarHeading } from "@/lib/db/queries/cities";
import { PillarPage } from "./PillarPage";
import { VerifiedToggle } from "./VerifiedToggle";

/**
 * Task 53's pillar-side pieces PillarPage itself is responsible for: the
 * verified empty-state copy and mounting the toggle with the props the route
 * computed. The toggle's OWN show/hide rule has its own test file
 * (VerifiedToggle.test.ts) — this one is about what PillarPage does with it.
 */

const HEADING: PillarHeading = {
  faq: [],
  title: "Venues in Leeds",
  place: "Leeds",
  nounSingular: "venue",
  nounPlural: "venues",
  introHtml: null,
  isIndexable: true,
  listingCount: 0,
};

const BASE_PROPS = {
  heading: HEADING,
  featured: [],
  featuredBids: [],
  categories: [],
  nearby: [],
  faq: [],
  page: 1,
  totalPages: 1,
  basePath: "/leeds",
  cityPath: "/leeds",
};

describe("PillarPage — verified empty state", () => {
  it("shows the spec's exact copy with a link back to the unfiltered page when the filter empties the grid", () => {
    const el = PillarPage({ ...BASE_PROPS, listings: [], total: 0, verified: true, hasVerified: true });
    const body = text(el);
    expect(body).toContain("No verified venues in Leeds yet");
    expect(body).toContain("see all");

    const seeAll = links(el).find((l) => l.text.includes("see all"));
    expect(seeAll, "the empty state must link back to the unfiltered page").toBeTruthy();
    expect(seeAll!.href).toBe("/leeds");
  });

  it("keeps the ordinary empty-state copy when the filter is off", () => {
    const el = PillarPage({ ...BASE_PROPS, listings: [], total: 0, verified: false, hasVerified: false });
    const body = text(el);
    expect(body).toContain("No venues listed in Leeds yet.");
    expect(body).not.toContain("verified");
  });

  it("mounts VerifiedToggle with the route's own verified/hasVerified state, not a hardcoded default", () => {
    const el = PillarPage({ ...BASE_PROPS, listings: [], total: 0, verified: true, hasVerified: true });
    const toggle = [...elements(el)].find((n) => n.type === VerifiedToggle);
    expect(toggle, "PillarPage must mount VerifiedToggle").toBeTruthy();
    const props = toggle!.props as { active: boolean; hasVerified: boolean; onHref: string; offHref: string };
    expect(props.active).toBe(true);
    expect(props.hasVerified).toBe(true);
    expect(props.offHref).toBe("/leeds");
    expect(props.onHref).toBe("/leeds?verified=1");
  });
});
