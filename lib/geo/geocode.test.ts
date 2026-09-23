import { describe, it, expect } from "vitest";
import { GEOCODER_UNCONFIGURED, geocodeCity, isGeocodingAvailable } from "./geocode";

describe("geocodeCity", () => {
  it("resolves nothing and says why, rather than throwing", async () => {
    const out = await geocodeCity({ name: "Otley", region: "West Yorkshire", country: "GB" });
    expect(out.point).toBeNull();
    expect(out.reason).toBe(GEOCODER_UNCONFIGURED);
  });

  it("reports itself unavailable, so callers branch on the flag not on a null", () => {
    expect(isGeocodingAvailable()).toBe(false);
  });
});
