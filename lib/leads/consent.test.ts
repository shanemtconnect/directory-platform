import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import { leadSharingNotice } from "./consent";

describe("leadSharingNotice", () => {
  it("says who may pay for the request and that nobody else gets it, in the site's nouns", () => {
    const notice = leadSharingNotice();
    expect(notice).toContain(`matching ${siteConfig.entity.plural}`);
    expect(notice).toMatch(/may pay us to receive it/);
    expect(notice).toMatch(/never share it with anyone else/);
    expect(notice).not.toMatch(/don.t sell/i);
  });
});
