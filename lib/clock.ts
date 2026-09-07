let frozen: Date | null = null;

/**
 * The only sanctioned source of current time.
 *
 * Never call `new Date()` elsewhere in application code. Phase 5 has to prove
 * that a subscription bought today expires cleanly in 12 months by moving the
 * clock rather than waiting a year, and that is only possible if every expiry,
 * revalidation and scheduled job reads its time from here.
 */
export function now(): Date {
  return frozen ? new Date(frozen) : new Date();
}

/** Test-only. Freezes `now()` at the given instant. */
export function setClock(d: Date): void {
  frozen = new Date(d);
}

/** Test-only. Returns `now()` to real time. */
export function resetClock(): void {
  frozen = null;
}
