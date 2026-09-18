import { describe, it, expect, vi } from "vitest";
import { elements, links } from "@/test/elements";

/**
 * The public badge page is ISR. It used to declare `revalidate = 3600` and
 * then read `searchParams`, which makes the route dynamic in Next 16 and
 * turned the promise into a dead export. The owner-specific half now lives at
 * /advertise/badge/mine; this page takes no request input at all.
 */

vi.mock("@/lib/db/client", () => ({
  db: {
    get select() {
      throw new Error("the public badge page must not read the database");
    },
  },
}));

describe("/advertise/badge", () => {
  it("is a static route: revalidates hourly and takes no request input", async () => {
    const mod = await import("./page");
    expect(mod.revalidate).toBe(3600);
    expect(mod.default.length).toBe(0);
  });

  it("renders the worked example and points an owner at the signed-in page", async () => {
    const { BadgeGallery } = await import("@/components/advertise/BadgeGallery");
    const { default: page } = await import("./page");
    const tree = await page();

    const gallery = [...elements(tree)].find((el) => el.type === BadgeGallery);
    expect(gallery).toBeDefined();
    expect((gallery!.props as { base: { listingId: string } }).base.listingId).toBe(
      "00000000-0000-4000-8000-000000000000",
    );
    expect(links(tree).some((l) => l.href === "/advertise/badge/mine")).toBe(true);
  });
});
