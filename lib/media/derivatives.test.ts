import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { generateDerivatives, DERIVATIVE_SIZES } from "./derivatives";

const fixture = (w: number, h: number) =>
  sharp({ create: { width: w, height: h, channels: 3, background: "#888888" } }).jpeg().toBuffer();

describe("generateDerivatives", () => {
  it("produces all four sizes as WebP", async () => {
    const out = await generateDerivatives(await fixture(3000, 2000));
    for (const key of ["thumb", "card", "hero", "full"] as const) {
      const meta = await sharp(out[key]).metadata();
      expect(meta.format).toBe("webp");
      expect(meta.width).toBe(DERIVATIVE_SIZES[key]);
    }
  }, 20000);

  it("never upscales a small original", async () => {
    const out = await generateDerivatives(await fixture(400, 300));
    expect((await sharp(out.full).metadata()).width).toBe(400);
    expect((await sharp(out.hero).metadata()).width).toBe(400);
    expect((await sharp(out.thumb).metadata()).width).toBe(200);
  }, 20000);

  it("strips EXIF — business photos routinely carry GPS and device metadata", async () => {
    const withExif = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#111111" } })
      .withExif({ IFD0: { Copyright: "Test", Model: "iPhone" } })
      .jpeg().toBuffer();
    expect((await sharp(withExif).metadata()).exif).toBeDefined();
    const out = await generateDerivatives(withExif);
    expect((await sharp(out.hero).metadata()).exif).toBeUndefined();
  }, 20000);
});
