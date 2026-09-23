import { describe, expect, it } from "vitest";
import { BEACON_SCRIPT } from "./beacon-script";
import { MAX_BEACON_EVENTS } from "@/lib/stats/keys";

describe("BEACON_SCRIPT", () => {
  it("cannot break out of the <script> it is inlined into", () => {
    // It is written by hand and inlined with dangerouslySetInnerHTML, so the
    // one thing that would make that unsafe is a closing tag inside it.
    expect(BEACON_SCRIPT).not.toMatch(/<\/script/i);
    expect(BEACON_SCRIPT).not.toContain("<!--");
  });

  it("loads nothing from anywhere", () => {
    // No third-party analytics, ever: the whole client side of this feature is
    // this string.
    expect(BEACON_SCRIPT).not.toMatch(/https?:\/\//);
    expect(BEACON_SCRIPT).not.toContain("src=");
    expect(BEACON_SCRIPT).not.toMatch(/document\.cookie|localStorage|sessionStorage/);
  });

  it("posts only to our own beacon endpoint", () => {
    expect(BEACON_SCRIPT.match(/'\/api\/beacon'/g)).toHaveLength(2);
  });

  it("runs once per page even if it is inlined twice", () => {
    expect(BEACON_SCRIPT).toContain("if(window.__dpBeacon)return");
  });

  it("stops at the batch size the endpoint accepts", () => {
    expect(BEACON_SCRIPT).toContain(`events.length<${MAX_BEACON_EVENTS}`);
  });

  it("is small enough to inline on every page", () => {
    // 1200 before the featured-click listener (Task 45); still well under 2 KB.
    expect(BEACON_SCRIPT.length).toBeLessThan(1700);
  });

  it("sends one batched request rather than one per marker", () => {
    expect(BEACON_SCRIPT.match(/sendBeacon\(/g)).toHaveLength(1);
    expect(BEACON_SCRIPT).toContain("JSON.stringify({events:events})");
  });

  it("posts a featured click for the spot the card was in, read from the card's own marker (Task 45)", () => {
    expect(BEACON_SCRIPT).toContain("document.addEventListener('click'");
    expect(BEACON_SCRIPT).toContain("closest('[data-dp-spot] [data-position]')");
    expect(BEACON_SCRIPT).toContain("metric:'featured_click'");
    expect(BEACON_SCRIPT).toContain("spotId:ul.getAttribute('data-dp-spot')");
  });

  it("uses a null-prototype map for the dedupe keys", () => {
    expect(BEACON_SCRIPT).toContain("Object.create(null)");
  });

  it("skips a marker whose card is not rendered, so a hidden sponsor rail counts nothing (Task 43)", () => {
    // The marker itself is `hidden`; its parent (the card) is what CSS shows or
    // hides per viewport, so that is what has to have a box.
    expect(BEACON_SCRIPT).toContain("parentNode.getClientRects().length===0)continue");
  });
});
