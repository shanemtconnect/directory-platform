/**
 * The removal SLA, in the only unit a deadline can honestly be stated in.
 *
 * /data-sources promises a removal request is actioned "within five working
 * days". Five calendar days from a Thursday is a Tuesday and nobody is at a
 * desk for two of them, so the promise on the page and the `due_at` on the row
 * have to agree about what a working day is or the queue starts reporting
 * breaches that never happened — and hiding ones that did.
 *
 * Weekends only. Bank holidays are deliberately out of scope: they are
 * per-country, they move, and the honest way to hold them is a table an
 * operator maintains, not a hardcoded list that rots after one year.
 */

/** Mon–Fri in the given zone. */
function isWorkingDay(instant: Date, timezone: string): boolean {
  const day = new Intl.DateTimeFormat("en-GB", { weekday: "short", timeZone: timezone })
    .format(instant);
  return day !== "Sat" && day !== "Sun";
}

const ONE_DAY_MS = 86_400_000;

/**
 * `days` working days after `from`, counted in `timezone`.
 *
 * The zone is an argument rather than read from siteConfig here so the
 * function stays pure and testable; callers pass `siteConfig.timezone`. It
 * matters: 23:30 UTC on a Friday is already Saturday in London, and a deadline
 * computed against the server's zone is a day out once a week.
 *
 * Days are added as fixed 24-hour steps, so across a daylight-saving change
 * the wall-clock time of the deadline moves by an hour. That is acceptable for
 * a five-day SLA and keeps the arithmetic something a reader can follow; the
 * weekday it lands on — the thing the promise is about — is exact either way.
 */
export function addWorkingDays(from: Date, days: number, timezone: string): Date {
  // Never the caller's Date: mutating it would move whatever else holds it.
  const out = new Date(from.getTime());
  let remaining = days;
  while (remaining > 0) {
    out.setTime(out.getTime() + ONE_DAY_MS);
    if (isWorkingDay(out, timezone)) remaining--;
  }
  return out;
}

/**
 * What /data-sources promises. Every mention of the SLA in copy derives from
 * this — as a digit, or through `numberWord` where prose wants a word — so
 * changing it here changes the promise everywhere at once.
 */
export const REMOVAL_SLA_WORKING_DAYS = 5;

const WORDS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];

/**
 * "five", for prose that would read oddly with a digit ("past the
 * five-working-day deadline"). Anything outside one to ten — or not an
 * integer — comes back as digits, which is what house style wants for larger
 * numbers anyway.
 */
export function numberWord(n: number): string {
  if (Number.isInteger(n) && n >= 1 && n <= 10) return WORDS[n]!;
  return String(n);
}

export function removalDueAt(from: Date, timezone: string): Date {
  return addWorkingDays(from, REMOVAL_SLA_WORKING_DAYS, timezone);
}
