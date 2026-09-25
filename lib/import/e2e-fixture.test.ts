import { describe, it, expect } from "vitest";
import { e2eFixtureApproval, fixtureHtml, IMPORT_FIXTURE_PATH } from "./e2e-fixture";
import { extractBusiness } from "./extract";
import { SsrfRefusal } from "@/lib/net/safe-fetch";

const PUBLIC = async () => ["93.184.216.34"];
const E2E = { E2E_DEMO_MODE: "true", NEXT_PUBLIC_DEMO_MODE: "true", PORT: "3255" };

describe("e2eFixtureApproval", () => {
  it("is off unless the e2e suite AND demo mode are both on", () => {
    expect(e2eFixtureApproval({})).toBeUndefined();
    expect(e2eFixtureApproval({ NEXT_PUBLIC_DEMO_MODE: "true", PORT: "3255" })).toBeUndefined();
    expect(e2eFixtureApproval({ E2E_DEMO_MODE: "true", PORT: "3255" })).toBeUndefined();
    expect(e2eFixtureApproval({ ...E2E, PORT: undefined })).toBeUndefined();
  });

  it("approves exactly the fixture on this server's own port, pinned to loopback", async () => {
    const approve = e2eFixtureApproval(E2E)!;
    const approved = await approve(`http://localhost:3255${IMPORT_FIXTURE_PATH}?name=x`, PUBLIC);
    expect(approved.addresses).toEqual(["127.0.0.1"]);
    expect(approved.url.pathname).toBe(IMPORT_FIXTURE_PATH);
  });

  it.each([
    "http://localhost:3255/",
    "http://localhost:3255/e2e/import-fixture/../admin",
    "http://localhost:5432/e2e/import-fixture",
    "https://localhost:3255/e2e/import-fixture",
    "http://127.0.0.1/",
    "http://169.254.169.254/latest/meta-data/",
  ])("still refuses %s", async (raw) => {
    await expect(e2eFixtureApproval(E2E)!(raw, PUBLIC)).rejects.toBeInstanceOf(SsrfRefusal);
  });

  it("hands every other URL to the ordinary guard", async () => {
    const approved = await e2eFixtureApproval(E2E)!("https://client.example/", PUBLIC);
    expect(approved.addresses).toEqual(["93.184.216.34"]);
  });
});

describe("fixtureHtml", () => {
  it("is a page the extractor reads back field for field", () => {
    const params = new URLSearchParams({
      name: "Harbour Light 123", phone: "01632 960123", city: "Porthaven",
      region: "Cornwall", postcode: "TR1 1AA",
    });
    expect(extractBusiness(fixtureHtml(params), "http://localhost:3255/e2e/import-fixture")).toMatchObject({
      name: "Harbour Light 123",
      phone: "01632 960123",
      city: "Porthaven",
      region: "Cornwall",
      postcode: "TR1 1AA",
      addressLine1: expect.any(String),
      description: expect.stringMatching(/.{50,}/),
    });
  });

  it("cannot be used to inject markup", () => {
    const html = fixtureHtml(new URLSearchParams({ name: `</script><script>alert(1)</script>"><b>` }));
    expect(html).not.toContain("</script><script>");
    expect(html).not.toContain(`"><b>`);
  });
});
