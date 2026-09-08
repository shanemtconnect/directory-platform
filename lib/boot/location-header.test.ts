import { describe, expect, it, vi } from "vitest";
import { dedupingAppendHeader } from "./location-header";

/**
 * A stand-in for the Node ServerResponse the patch wraps: just enough of the
 * header bag for the guard to read, so the test does not need a real socket.
 */
function fakeResponse(initial: Record<string, string | string[]> = {}) {
  const headers = new Map(Object.entries(initial));
  return {
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    setHeader(name: string, value: string | string[]) {
      headers.set(name.toLowerCase(), value);
    },
    headers,
  };
}

describe("dedupingAppendHeader", () => {
  it("drops a Location identical to the one already on the response", () => {
    const original = vi.fn();
    const append = dedupingAppendHeader(original as never);
    const res = fakeResponse({ location: "/leeds" });

    append.call(res as never, "location", "/leeds");

    expect(original).not.toHaveBeenCalled();
  });

  it("matches the header name case-insensitively", () => {
    const original = vi.fn();
    const append = dedupingAppendHeader(original as never);
    const res = fakeResponse({ location: "/leeds" });

    append.call(res as never, "Location", "/leeds");

    expect(original).not.toHaveBeenCalled();
  });

  it("sets a Location that is not there yet", () => {
    const original = vi.fn();
    const append = dedupingAppendHeader(original as never);
    const res = fakeResponse();

    append.call(res as never, "location", "/leeds");

    expect(original).toHaveBeenCalledWith("location", "/leeds");
  });

  it("does not swallow a DIFFERENT Location — that is a real bug worth seeing", () => {
    const original = vi.fn();
    const append = dedupingAppendHeader(original as never);
    const res = fakeResponse({ location: "/leeds" });

    append.call(res as never, "location", "/york");

    expect(original).toHaveBeenCalledWith("location", "/york");
  });

  it("leaves every other header alone, duplicate or not", () => {
    const original = vi.fn();
    const append = dedupingAppendHeader(original as never);
    const res = fakeResponse({ vary: "rsc", "set-cookie": ["a=1"] });

    append.call(res as never, "vary", "rsc");
    append.call(res as never, "set-cookie", "a=1");

    expect(original).toHaveBeenCalledTimes(2);
  });

  it("compares against every value when Location is already an array", () => {
    const original = vi.fn();
    const append = dedupingAppendHeader(original as never);
    const res = fakeResponse({ location: ["/leeds", "/leeds"] });

    append.call(res as never, "location", "/leeds");

    expect(original).not.toHaveBeenCalled();
  });
});
