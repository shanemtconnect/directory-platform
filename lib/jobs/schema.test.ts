import { describe, expect, it } from "vitest";
import type { PublicJob } from "@/lib/db/queries/job-board";
import { jobPostingSchema } from "./schema";

const ID = "6f1c1e6e-2f2b-4d7d-9b1a-3c4d5e6f7a8b";

function job(patch: Partial<PublicJob> = {}): PublicJob {
  return {
    id: ID,
    title: "Weekend coordinator",
    companyName: "The Old Mill",
    cityName: "Leeds",
    citySlug: "leeds",
    cityRegion: "West Yorkshire",
    categoryName: "Barn Venues",
    categorySlug: "barn-venues",
    budgetMin: "18000.00",
    budgetMax: "22000.00",
    publishedAt: new Date("2026-09-22T10:00:00Z"),
    expiresAt: new Date("2026-10-22T10:00:00Z"),
    liveAt: new Date("2026-09-22T10:00:00Z"),
    path: `/jobs/${ID}`,
    description: "Run the Saturday diary.",
    applyMethod: "email",
    applyEmail: "jobs@example.co.uk",
    applyUrl: null,
    open: true,
    ...patch,
  };
}

describe("jobPostingSchema", () => {
  it("emits only what the page rendered, with validThrough from expires_at", () => {
    const node = jobPostingSchema({ job: job(), description: "Run the Saturday diary.", budgetShown: true });
    expect(node).toMatchObject({
      "@type": "JobPosting",
      title: "Weekend coordinator",
      description: "Run the Saturday diary.",
      datePosted: "2026-09-22T10:00:00.000Z",
      validThrough: "2026-10-22T10:00:00.000Z",
      hiringOrganization: { "@type": "Organization", name: "The Old Mill" },
      jobLocation: { address: { addressLocality: "Leeds", addressRegion: "West Yorkshire", addressCountry: "GB" } },
      baseSalary: { currency: "GBP", value: { minValue: 18000, maxValue: 22000 } },
      directApply: false,
    });
    expect(node?.url).toMatch(new RegExp(`/jobs/${ID}$`));
  });

  it("drops the salary when the page did not show a budget, and the description when none was rendered", () => {
    const node = jobPostingSchema({ job: job(), description: null, budgetShown: false });
    expect(node).not.toHaveProperty("baseSalary");
    expect(node).not.toHaveProperty("description");
    // A budget the row holds but the page hid is still not in the markup.
    expect(JSON.stringify(node)).not.toContain("18000");
  });

  it("emits nothing for a closed job — the page shows a notice instead", () => {
    expect(jobPostingSchema({ job: job({ open: false }), description: "x", budgetShown: true })).toBeNull();
    expect(jobPostingSchema({ job: job({ publishedAt: null }), description: "x", budgetShown: true })).toBeNull();
  });

  it("carries no organisation or location it cannot name", () => {
    const node = jobPostingSchema({
      job: job({ companyName: null, cityName: null, cityRegion: null }),
      description: "x",
      budgetShown: false,
    });
    expect(node).not.toHaveProperty("hiringOrganization");
    expect(node).not.toHaveProperty("jobLocation");
  });
});
