import { beforeEach, describe, expect, it, vi } from "vitest";
import { text } from "@/test/elements";

class NotFound extends Error {}
let quoteBroadcast = true;

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("NEXT_NOT_FOUND");
  },
}));
vi.mock("@/lib/features/flags", () => ({
  get features() {
    return { quoteBroadcast };
  },
  isEnabled: (flag: string) => flag === "quoteBroadcast" && quoteBroadcast,
}));

beforeEach(() => {
  vi.resetModules();
  quoteBroadcast = true;
});

async function render(state?: string) {
  const { default: page } = await import("./page");
  return page({ searchParams: Promise.resolve(state === undefined ? {} : { state }) });
}

describe("/get-quotes/confirmed", () => {
  it("404s with quotes off", async () => {
    quoteBroadcast = false;
    await expect(render("verified")).rejects.toThrow(NotFound);
  });

  it("says a confirmed request is on its way", async () => {
    expect(text(await render("verified"))).toMatch(/confirmed.*on its way/is);
  });

  it("says a reused link has already been confirmed", async () => {
    expect(text(await render("already"))).toMatch(/already confirmed/i);
  });

  it("says an expired link sent nothing, with the lifetime, and offers the form again", async () => {
    const out = text(await render("expired"));
    expect(out).toMatch(/48 hours/);
    expect(out).toMatch(/Nothing was sent/);
  });

  it("treats anything else as a link it does not recognise", async () => {
    expect(text(await render("bogus"))).toMatch(/cannot be used/i);
    expect(text(await render())).toMatch(/cannot be used/i);
  });
});
