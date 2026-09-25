import { countryProfile, type SupportedCountry } from "./countries";

/**
 * A phone number as a lead's identity: E.164, or null.
 *
 * Pay-per-lead (D11) refuses a lead whose phone does not normalise for the
 * site's own country, and uses the E.164 form as the key for the 30-day
 * duplicate check and the blocklist — so "020 7946 0018", "+44 20 7946 0018"
 * and "0044 (0)20 7946 0018" must be the same string, and a number a buyer
 * cannot ring (too short, letters, a premium or personal-numbering range, a
 * reserved fiction range) must not be a lead anyone pays for.
 *
 * Deliberately not a phone library (wave G: no new heavy deps). It knows the
 * numbering plans of the countries in lib/geo/countries.ts well enough to
 * say "diallable, ordinary number" — not every short code and not every
 * special service. Anything it is unsure of is refused: a refused lead is a
 * lead not sold, a wrong one is a refund.
 *
 * Refused ranges:
 *  - GB: 09 (premium rate), 070 (personal numbering — the classic scam
 *    number that looks like a mobile). 0800/0808 freephone is accepted.
 *  - NANP (US, CA): area code 900 (premium) and 555-01xx (fiction).
 *  - AU: 19xx (premium).
 */

type Plan = (nsn: string) => boolean;

/** National significant number rules, after the trunk prefix is gone. */
const PLANS: Record<SupportedCountry, { trunk: string; valid: Plan }> = {
  GB: {
    trunk: "0",
    valid: (nsn) =>
      /^[123578]\d{8,9}$/.test(nsn) &&
      !nsn.startsWith("70"),
  },
  US: { trunk: "1", valid: nanp },
  CA: { trunk: "1", valid: nanp },
  AU: {
    trunk: "0",
    valid: (nsn) => /^[23478]\d{8}$/.test(nsn) || /^1[38]00\d{6}$/.test(nsn),
  },
};

function nanp(nsn: string): boolean {
  if (!/^[2-9]\d{2}[2-9]\d{6}$/.test(nsn)) return false;
  if (nsn.startsWith("900")) return false;
  if (nsn.slice(3, 6) === "555" && nsn.slice(6, 8) === "01") return false;
  return true;
}

export function normalisePhone(raw: string | null | undefined, country: string): string | null {
  if (raw === null || raw === undefined) return null;
  const s = raw.trim();
  if (s === "") return null;
  // Digits and the punctuation people type between them. A letter is a
  // vanity number or not a number at all; either way nobody can dial it.
  if (/[^\d\s().+\-]/.test(s)) return null;
  if (s.lastIndexOf("+") > 0) return null;

  const profile = countryProfile(country);
  const plan = PLANS[profile.code];
  const cc = profile.phoneCountryCode.replace(/^\+/, "");
  const digits = s.replace(/\D/g, "");

  let nsn: string;
  if (s.startsWith("+") || digits.startsWith("00")) {
    const international = s.startsWith("+") ? digits : digits.slice(2);
    // Another country's number on this site's lead: not one a local buyer rings.
    if (!international.startsWith(cc)) return null;
    nsn = international.slice(cc.length);
    // "+44 (0)20 …" — the bracketed trunk people write after the code.
    if (plan.trunk === "0" && nsn.startsWith("0")) nsn = nsn.slice(1);
  } else if (plan.trunk === "1") {
    nsn = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  } else {
    // AU's 1300/1800 numbers are dialled with no trunk prefix at all.
    nsn = digits.startsWith(plan.trunk) ? digits.slice(plan.trunk.length) : digits;
  }

  return plan.valid(nsn) ? `+${cc}${nsn}` : null;
}
