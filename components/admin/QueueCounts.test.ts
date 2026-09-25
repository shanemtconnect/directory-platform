import { describe, it, expect } from "vitest";
import type { AdminQueueCounts } from "@/lib/db/queries/admin/dashboard";
import { elements, links, text } from "@/test/elements";
import { QueueCounts } from "./QueueCounts";

/**
 * Every tile links to the queue it counts. A tile with a number and no link
 * was the compromise for a queue whose page did not exist yet; once the page
 * exists, a number an admin cannot click through is work they cannot reach.
 */

const COUNTS: AdminQueueCounts = {
  pendingSubmissions: 3,
  citiesAwaitingIntro: 2,
  pendingClaims: 4,
  openReports: 1,
  openRemovals: 0,
  reviewsAwaitingModeration: 5,
  pendingLeadRefunds: 2,
};

describe("QueueCounts", () => {
  it.each([
    ["Submissions waiting", "/admin/submissions"],
    ["Towns without intro copy", "/admin/cities"],
    ["Claims pending", "/admin/claims"],
    ["Reviews awaiting moderation", "/admin/reviews"],
    ["Reports open", "/admin/reports"],
    ["Removal requests open", "/admin/removals"],
  ])("the %s tile links to %s", (label, href) => {
    const tile = links(QueueCounts({ counts: COUNTS })).find((l) => l.text.includes(label));

    expect(tile?.href).toBe(href);
  });

  it("renders no tile without a link", () => {
    const unlinked = [...elements(QueueCounts({ counts: COUNTS }))].filter(
      (el) => el.type === "div" && (el.props as { className?: string }).className === "card h-full",
    );

    expect(unlinked).toHaveLength(0);
  });

  it("shows a zero rather than hiding an empty queue", () => {
    const html = text(QueueCounts({ counts: COUNTS }));

    expect(html).toContain("Removal requests open");
    expect(html).toContain("Nothing is waiting to come down.");
  });
});
