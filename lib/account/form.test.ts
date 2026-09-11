import { describe, expect, it } from "vitest";
import { siteConfig } from "@/config/site.config";
import { DAY_KEYS, validateOwnerListing } from "./form";

function form(values: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(values)) f.set(k, v);
  return f;
}

describe("validateOwnerListing", () => {
  it("keeps paragraph breaks in the description and trims the single-line fields", () => {
    const { values, errors } = validateOwnerListing(form({
      description: "One.\r\n\r\nTwo.",
      phone: " 01632 960000 ",
      website: " https://oldmill.example ",
    }));
    expect(errors).toBeUndefined();
    expect(values?.description).toBe("One.\n\nTwo.");
    expect(values?.phone).toBe("01632 960000");
    expect(values?.website).toBe("https://oldmill.example");
  });

  it("stores an empty field as null rather than an empty string", () => {
    const { values } = validateOwnerListing(form({ description: "", phone: "  ", website: "" }));
    expect(values?.description).toBeNull();
    expect(values?.phone).toBeNull();
    expect(values?.website).toBeNull();
  });

  it("takes one social URL per line and drops the blanks", () => {
    const { values } = validateOwnerListing(form({
      socials: "https://instagram.com/oldmill\n\n https://facebook.com/oldmill \n",
    }));
    expect(values?.socials).toEqual([
      "https://instagram.com/oldmill",
      "https://facebook.com/oldmill",
    ]);
  });

  it("refuses a link that is not http or https", () => {
    expect(validateOwnerListing(form({ website: "javascript:alert(1)" })).errors?.website)
      .toBeTruthy();
    expect(validateOwnerListing(form({ socials: "javascript:alert(1)" })).errors?.socials)
      .toBeTruthy();
  });

  it("holds the description to the configured cap, not a number in a component", () => {
    const max = siteConfig.listing.maxDescriptionChars;
    expect(validateOwnerListing(form({ description: "a".repeat(max) })).errors).toBeUndefined();
    expect(validateOwnerListing(form({ description: "a".repeat(max + 1) })).errors?.description)
      .toBeTruthy();
  });

  it("collects the seven days into one object and omits the ones left blank", () => {
    const { values } = validateOwnerListing(form({
      "hours-mon": "09:00-17:00", "hours-tue": " ", "hours-sun": "Closed",
    }));
    expect(values?.openingHours).toEqual({ mon: "09:00-17:00", sun: "Closed" });
    expect(DAY_KEYS).toHaveLength(7);
  });

  it("caps a day's text, since it is free text on a public page", () => {
    expect(validateOwnerListing(form({ "hours-mon": "a".repeat(80) })).errors?.openingHours)
      .toBeTruthy();
  });
});
