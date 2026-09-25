import { countryProfile, type SupportedCountry } from "./countries";

/**
 * A phone number as a lead's identity: E.164, or null.
 *
 * Pay-per-lead (D11) refuses a lead whose phone does not normalise for the
 * site's own country, and uses the E.164 form as the key for the 30-day
 * duplicate check and the blocklist — so "020 7946 1018", "+44 20 7946 1018"
 * and "0044 (0)20 7946 1018" must be the same string, and a number a buyer
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
 *    number that looks like a mobile), and Ofcom's drama ranges
 *    (`FICTIONAL_RANGES.GB`). 0800/0808 freephone is otherwise accepted.
 *  - NANP (US, CA): area code 900 (premium) and 555-01xx (fiction).
 *  - AU: 19xx (premium) and ACMA's fiction ranges (`FICTIONAL_RANGES.AU`).
 *
 * The fiction ranges are the numbers seed data and demos are told to use
 * (`reservedPhoneExample` in lib/geo/countries.ts), which is exactly why a
 * lead carrying one is not a person: it is a test, a demo, or somebody
 * copying the example.
 */

/**
 * Numbers reserved for fiction, as prefixes of the national significant
 * number (after the trunk 0). Every number that starts with one is refused.
 */
export const FICTIONAL_RANGES: Partial<Record<SupportedCountry, readonly string[]>> = {
  // Ofcom: 01632 960xxx, 020 7946 0xxx, 07700 900xxx, 0808 157 0xxx,
  // 0909 879 0xxx, 03069 990xxx, 0191 498 0xxx, 0113/0114/0115/0116/0117/
  // 0118/0121/0131/0141/0161 496 0xxx, 028 9018 0xxx, 029 2018 0xxx.
  GB: [
    "1632960", "2079460", "7700900", "8081570", "9098790", "3069990", "1914980",
    "1134960", "1144960", "1154960", "1164960", "1174960", "1184960",
    "1214960", "1314960", "1414960", "1614960", "2890180", "2920180",
  ],
  // ACMA: 02/03/07/08 5550 xxxx and 7010 xxxx, 0491 570 xxx, 1800 160 xxx,
  // 1900 654 xxx.
  AU: [
    "25550", "35550", "75550", "85550", "27010", "37010", "77010", "87010",
    "491570", "1800160", "1900654",
  ],
};

function fictional(code: SupportedCountry, nsn: string): boolean {
  return (FICTIONAL_RANGES[code] ?? []).some((prefix) => nsn.startsWith(prefix));
}

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

  if (!plan.valid(nsn) || fictional(profile.code, nsn)) return null;
  return `+${cc}${nsn}`;
}
