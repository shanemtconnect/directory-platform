import { describe, expect, it } from "vitest";
import { validateJobForm } from "./validate";

const CITY = "11111111-1111-4111-8111-111111111111";
const CATEGORY = "22222222-2222-4222-8222-222222222222";

function form(over: Record<string, string> = {}): FormData {
  const f = new FormData();
  const base: Record<string, string> = {
    title: "Weekend coordinator",
    description: "Someone to run the Saturday diary and keep the suppliers in step through the season.",
    companyName: "The Old Mill",
    posterName: "Pat Owner",
    posterEmail: "Pat@Example.co.uk",
    cityId: CITY,
    categoryId: CATEGORY,
    applyMethod: "email",
    applyEmail: "jobs@example.co.uk",
    ...over,
  };
  for (const [k, v] of Object.entries(base)) f.set(k, v);
  return f;
}

describe("validateJobForm", () => {
  it("accepts a good form, lowercases the addresses and blanks the budget", () => {
    const out = validateJobForm(form());
    expect(out.errors).toBeUndefined();
    expect(out.values).toMatchObject({
      posterEmail: "pat@example.co.uk",
      applyEmail: "jobs@example.co.uk",
      applyUrl: null,
      budgetMin: null,
      budgetMax: null,
      listingId: null,
    });
  });

  it("reads a budget range and refuses one that is upside down or not a number", () => {
    expect(validateJobForm(form({ budgetMin: "18,000", budgetMax: "22000.50" })).values).toMatchObject({ budgetMin: 18000, budgetMax: 22000.5 });
    expect(validateJobForm(form({ budgetMin: "30000", budgetMax: "20000" })).errors).toHaveProperty("budgetMax");
    expect(validateJobForm(form({ budgetMin: "lots" })).errors).toHaveProperty("budgetMin");
    expect(validateJobForm(form({ budgetMin: "-5" })).errors).toHaveProperty("budgetMin");
  });

  it("wants a URL that is really a web address when applying by link", () => {
    const ok = validateJobForm(form({ applyMethod: "url", applyUrl: "https://example.co.uk/apply" }));
    expect(ok.values).toMatchObject({ applyMethod: "url", applyUrl: "https://example.co.uk/apply", applyEmail: null });
    expect(validateJobForm(form({ applyMethod: "url", applyUrl: "javascript:alert(1)" })).errors).toHaveProperty("applyUrl");
    expect(validateJobForm(form({ applyMethod: "url", applyUrl: "example.co.uk" })).errors).toHaveProperty("applyUrl");
    expect(validateJobForm(form({ applyMethod: "post" })).errors).toHaveProperty("applyMethod");
  });

  it("strips CR/LF from header-bound fields and keeps paragraph breaks in the description", () => {
    const out = validateJobForm(form({
      title: "Coordinator\r\nBcc: victim@example.com",
      description: "First paragraph of the role, long enough to pass.\n\nSecond paragraph, also long enough to pass.",
    }));
    expect(out.values?.title).toBe("Coordinator Bcc: victim@example.com");
    expect(out.values?.description).toContain("\n\n");
  });

  it("shape-checks every uuid before it could reach a column", () => {
    expect(validateJobForm(form({ cityId: "leeds" })).errors).toHaveProperty("cityId");
    expect(validateJobForm(form({ categoryId: "" })).errors).toHaveProperty("categoryId");
    expect(validateJobForm(form({ listingId: "not-a-uuid" })).errors).toHaveProperty("listingId");
    expect(validateJobForm(form({ listingId: CITY })).values?.listingId).toBe(CITY);
  });

  it("names every failing field at once", () => {
    const out = validateJobForm(form({ title: "x", description: "short", companyName: "", posterName: "", posterEmail: "nope" }));
    expect(Object.keys(out.errors ?? {}).sort()).toEqual(["companyName", "description", "posterEmail", "posterName", "title"]);
  });
});
