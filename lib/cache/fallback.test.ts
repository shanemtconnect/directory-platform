import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startFallbackReminder, FALLBACK_REMINDER_INTERVAL_MS } from "@/lib/cache/fallback.mjs";

describe("startFallbackReminder", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not log immediately — only once the interval has elapsed", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const timer = startFallbackReminder(5000);

    expect(spy).not.toHaveBeenCalled();

    clearInterval(timer);
    spy.mockRestore();
  });

  it("logs the visible reminder every interval, repeatedly", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const timer = startFallbackReminder(5000);

    vi.advanceTimersByTime(5000);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenLastCalledWith(
      "[cache] STILL FALLING BACK TO LRU (no redis) — restart this container once Redis is reachable",
    );

    vi.advanceTimersByTime(15000);
    expect(spy).toHaveBeenCalledTimes(4);

    clearInterval(timer);
    spy.mockRestore();
  });

  it("defaults to the 5-minute constant when no interval is given", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const timer = startFallbackReminder();

    vi.advanceTimersByTime(FALLBACK_REMINDER_INTERVAL_MS - 1);
    expect(spy).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(spy).toHaveBeenCalledTimes(1);

    clearInterval(timer);
    spy.mockRestore();
  });

  it("is unref'd so the reminder can never hold the process open", () => {
    const timer = startFallbackReminder(5000);
    expect(timer.hasRef?.()).toBe(false);
    clearInterval(timer);
  });
});
