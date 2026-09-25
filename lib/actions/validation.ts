import { siteConfig } from "@/config/site.config";
import type { TierName } from "@/config/types";
import type { SubmissionInput } from "@/lib/db/queries/submissions";
import { countryProfile, validatePostcode } from "@/lib/geo/countries";

/**
 * Form validation for the two public server actions.
 *
 * It lives outside the "use server" modules on purpose: those may only export
 * async functions, and validation that cannot be unit tested is validation
 * nobody checks.
 *
 * Two rules apply to every field here, and both exist because the value came
 * from a stranger:
 *
 *  - Anything compared against a uuid column is shape-checked first. Postgres
 *    answers `invalid input syntax for type uuid` with an exception, which
 *    leaves the action as a 500 instead of a field error.
 *  - CR and LF are removed from every single-line field (name, email, phone,
 *    postcode, and the rest of the header-bound fields). Today they would
 *    only make a mess of an admin screen; the moment any of this reaches an
 *    email header they are an injection.
 *  - The two free-text body fields — the enquiry `message` and the listing
 *    `description` — get `normaliseBody` instead: CRLF is normalised to LF
 *    and a lone CR is dropped, but a paragraph break survives. Those fields
 *    are never read into a header, so there is nothing to inject; collapsing
 *    them to a single line just destroys formatting a visitor typed on
 *    purpose.
 */

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

/** Collapses CR/LF runs to a single space, so words either side stay apart. */
export function stripCrlf(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

/**
 * For free-text body fields only (`message`, `description`). Normalises
 * CRLF to a bare LF and drops a lone CR, but leaves LF alone — so a
 * paragraph break a visitor typed on purpose survives, unlike `stripCrlf`.
 */
export function normaliseBody(value: string): string {
  return value.replace(/\r\n/g, "\n").replace(/\r/g, "");
}

function field(form: FormData, key: string): string {
  return stripCrlf(String(form.get(key) ?? "")).trim();
}

function bodyField(form: FormData, key: string): string {
  return normaliseBody(String(form.get(key) ?? "")).trim();
}

type Result<T> = { values: T; errors?: undefined } | { values?: undefined; errors: Record<string, string> };

/* ------------------------------------------------------------------ enquiry */

export interface EnquiryValues {
  listingId: string;
  name: string;
  email: string;
  phone: string | null;
  message: string;
}

const ENQUIRY_MAX = { name: 120, email: 254, phone: 40, message: 2000 } as const;

export function validateEnquiry(form: FormData): Result<EnquiryValues> {
  const errors: Record<string, string> = {};
  const listingId = field(form, "listingId");
  const name = field(form, "name");
  const email = field(form, "email");
  const phone = field(form, "phone");
  const message = bodyField(form, "message");

  // A hidden field, so this is never a typo — it is a tampered form or a bot.
  if (!isUuid(listingId)) errors.listingId = "That listing could not be found.";

  if (name.length < 2) errors.name = "Please give your name.";
  if (name.length > ENQUIRY_MAX.name) errors.name = "That name is too long.";
  // Deliberately permissive: over-strict email regexes reject valid addresses,
  // and the address is verified by whether the reply arrives, not by us.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = "Please give a valid email address.";
  if (email.length > ENQUIRY_MAX.email) errors.email = "That email address is too long.";
  if (phone.length > ENQUIRY_MAX.phone) errors.phone = "That phone number is too long.";
  if (message.length < 10) errors.message = "Please write a little more.";
  if (message.length > ENQUIRY_MAX.message) errors.message = "Please keep it under 2000 characters.";

  if (Object.keys(errors).length > 0) return { errors };
  return { values: { listingId, name, email, phone: phone || null, message } };
}

/* --------------------------------------------------------------- submission */

/**
 * A public form is not a paid form. The description cap here is far below
 * siteConfig.listing.maxDescriptionChars: an owner writing their own page in
 * the portal gets the full allowance, but 500 characters is plenty for a
 * submission an admin has to read, and it starves the essay-length spam that
 * an unauthenticated form otherwise attracts.
 */
const DESCRIPTION_MIN = 50;
export const DESCRIPTION_MAX = 500;

const SUBMISSION_MAX = {
  name: 200,
  city: 120,
  region: 120,
  address: 200,
  postcode: 16,
  phone: 40,
  website: 300,
  submitterName: 120,
  submitterEmail: 254,
} as const;

const TIER_NAMES = Object.keys(siteConfig.tiers) as TierName[];

function isTier(value: string): value is TierName {
  return (TIER_NAMES as string[]).includes(value);
}

/**
 * Accepts a bare domain and stores a usable URL. Rejecting "example.co.uk"
 * because it lacks a scheme is a self-inflicted drop-off on a field most
 * people type from memory.
 */
function normaliseWebsite(raw: string): string | null {
  if (raw === "") return null;
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(withScheme);
    if (url.hostname.includes(".") === false) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/**
 * The public submission form's fields by `name`, as the strings the form
 * posts. What `SubmitListingForm` can be prefilled with (`initialValues`).
 */
export interface SubmissionFormValues {
  name: string;
  categoryId: string;
  description: string;
  addressLine1: string;
  region: string;
  city: string;
  postcode: string;
  phone: string;
  website: string;
  submitterName: string;
  submitterEmail: string;
}

export function validateSubmission(form: FormData): Result<Omit<SubmissionInput, "ip">> {
  const errors: Record<string, string> = {};

  const country = countryProfile(siteConfig.country);
  const name = field(form, "name");
  const categoryId = field(form, "categoryId");
  const region = field(form, "region");
  const city = field(form, "city");
  const addressLine1 = field(form, "addressLine1");
  const postcode = field(form, "postcode");
  const phone = field(form, "phone");
  const websiteRaw = field(form, "website");
  const description = bodyField(form, "description");
  const submitterName = field(form, "submitterName");
  const submitterEmail = field(form, "submitterEmail");
  const tier = field(form, "tier");

  if (name.length < 2) errors.name = "Please give the business name.";
  if (name.length > SUBMISSION_MAX.name) errors.name = "That name is too long.";
  // Both cases read the same to the submitter: they picked nothing, or they
  // sent something that was never on the select.
  if (!isUuid(categoryId)) errors.categoryId = "Please choose a category.";
  if (region === "") errors.region = `Please choose a ${country.regionLabel}.`;
  if (region.length > SUBMISSION_MAX.region) errors.region = "That is not a valid choice.";
  if (city.length < 2) errors.city = "Please give the town or city.";
  if (city.length > SUBMISSION_MAX.city) errors.city = "That town name is too long.";
  if (addressLine1.length < 3) errors.addressLine1 = "Please give the street address.";
  if (addressLine1.length > SUBMISSION_MAX.address) errors.addressLine1 = "That address is too long.";

  if (postcode === "") {
    errors.postcode = `Please give the ${country.postcodeLabel}.`;
  } else if (
    postcode.length > SUBMISSION_MAX.postcode ||
    !validatePostcode(siteConfig.country, postcode)
  ) {
    errors.postcode = `That does not look like a ${country.postcodeLabel}. Example: ${country.postcodeExample}.`;
  }

  if (phone.length < 6) errors.phone = "Please give a phone number people can call.";
  if (phone.length > SUBMISSION_MAX.phone) errors.phone = "That phone number is too long.";

  const website = normaliseWebsite(websiteRaw.slice(0, SUBMISSION_MAX.website));
  if (websiteRaw !== "" && website === null) errors.website = "That does not look like a web address.";

  if (description.length < DESCRIPTION_MIN) {
    errors.description = `Please write at least ${DESCRIPTION_MIN} characters.`;
  } else if (description.length > DESCRIPTION_MAX) {
    errors.description = `Please keep it under ${DESCRIPTION_MAX} characters.`;
  }

  if (submitterName.length < 2) errors.submitterName = "Please give your name.";
  if (submitterName.length > SUBMISSION_MAX.submitterName) {
    errors.submitterName = "That name is too long.";
  }
  // Deliberately permissive, as on the enquiry form: an over-strict pattern
  // rejects valid addresses, and delivery is the real test.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(submitterEmail)) {
    errors.submitterEmail = "Please give a valid email address.";
  }
  if (submitterEmail.length > SUBMISSION_MAX.submitterEmail) {
    errors.submitterEmail = "That email address is too long.";
  }
  if (!isTier(tier)) errors.tier = "Please choose an option.";

  if (Object.keys(errors).length > 0) return { errors };

  return {
    values: {
      name,
      categoryId,
      region,
      city,
      addressLine1,
      postcode,
      phone,
      website,
      description,
      submitterName,
      submitterEmail,
      requestedTier: tier as TierName,
    },
  };
}
