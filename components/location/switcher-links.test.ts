import { describe, it, expect } from "vitest";
import { cityScopedHref, searchCityHref } from "./switcher-links";

describe("cityScopedHref", () => {
  it("is the city pillar when nothing is scoped under it", () => {
    expect(cityScopedHref("leeds")).toBe("/leeds");
  });

  it("keeps the current category when there is one, so the switcher switches place only", () => {
    expect(cityScopedHref("leeds", "barn-halls")).toBe("/leeds/barn-halls");
  });
});

describe("searchCityHref", () => {
  it("sets the city facet and keeps every other filter", () => {
    expect(searchCityHref("leeds", { q: "barn", category: "halls", capacity_seated: "80" }))
      .toBe("/search?q=barn&category=halls&capacity_seated=80&city=leeds");
  });

  it("replaces the city already being filtered on rather than adding a second", () => {
    expect(searchCityHref("york", { city: "leeds", q: "barn" })).toBe("/search?q=barn&city=york");
  });

  it("drops the page number: page 3 of one city is not page 3 of another", () => {
    expect(searchCityHref("york", { q: "barn", page: "3" })).toBe("/search?q=barn&city=york");
  });

  it("drops empty filters instead of writing bare keys into the URL", () => {
    expect(searchCityHref("york", { q: "", category: undefined })).toBe("/search?city=york");
  });

  it("escapes what it is given", () => {
    expect(searchCityHref("leeds", { q: "a&b c" })).toBe("/search?q=a%26b+c&city=leeds");
  });
});
