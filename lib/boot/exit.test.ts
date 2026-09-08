import { describe, expect, it, vi, afterEach } from "vitest";
import { fatal } from "./exit";

describe("fatal", () => {
  afterEach(() => vi.restoreAllMocks());

  it("prints the message and exits 1", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    // `never` return: the real call does not come back, so the stub has to
    // throw to keep the contract honest for anything after the call.
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation((() => {
        throw new Error("exited");
      }) as never);

    expect(() => fatal("DATABASE_URL is missing")).toThrow("exited");
    expect(err).toHaveBeenCalledWith("DATABASE_URL is missing");
    expect(exit).toHaveBeenCalledWith(1);
  });
});
