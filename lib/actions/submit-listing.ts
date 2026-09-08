"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { siteConfig } from "@/config/site.config";
import type { TierName } from "@/config/types";
import { db } from "@/lib/db/client";
import {
  createSubmission,
  findSubmissionDuplicate,
  type SubmissionInput,
} from "@/lib/db/queries/submissions";
import { countryProfile, validatePostcode } from "@/lib/geo/countries";
import { rateLimit } from "@/lib/spam/rate-limit";
import { isHoneypotTripped, verifyTurnstile } from "@/lib/spam/turnstile";
import type { TestDb } from "@/test/db";

export interface SubmitListingState {
  status: "idle" | "duplicate" | "error";
  message?: string;
  fieldErrors?: Record<string, string>;
  /** Set with status 'duplicate'. The route offers a claim instead of a second row. */
  existing?: { name: string; claimPath: string };
}

/**
 * A public form is not a paid form. The description cap here is far below
 * siteConfig.listing.maxDescriptionChars: an owner writing their own page in
 * the portal gets the full allowance, but 500 characters is plenty for a
 * submission an admin has to read, and it starves the essay-length spam that
 * an unauthenticated form otherwise attracts.
 */
const DESCRIPTION_MIN = 50;
const DESCRIPTION_MAX = 500;

const MAX = {
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

type Validated =
  | { values: Omit<SubmissionInput, "ip">; errors?: undefined }
  | { values?: undefined; errors: Record<string, string> };

function validate(form: FormData): Validated {
  const errors: Record<string, string> = {};
  const get = (key: string) => String(form.get(key) ?? "").trim();

  const country = countryProfile(siteConfig.country);
  const name = get("name");
  const categoryId = get("categoryId");
  const region = get("region");
  const city = get("city");
  const addressLine1 = get("addressLine1");
  const postcode = get("postcode");
  const phone = get("phone");
  const websiteRaw = get("website");
  const description = get("description");
  const submitterName = get("submitterName");
  const submitterEmail = get("submitterEmail");
  const tier = get("tier");

  if (name.length < 2) errors.name = "Please give the business name.";
  if (name.length > MAX.name) errors.name = "That name is too long.";
  if (categoryId === "") errors.categoryId = "Please choose a category.";
  if (region === "") errors.region = `Please choose a ${country.regionLabel}.`;
  if (region.length > MAX.region) errors.region = "That is not a valid choice.";
  if (city.length < 2) errors.city = "Please give the town or city.";
  if (city.length > MAX.city) errors.city = "That town name is too long.";
  if (addressLine1.length < 3) errors.addressLine1 = "Please give the street address.";
  if (addressLine1.length > MAX.address) errors.addressLine1 = "That address is too long.";

  if (postcode === "") {
    errors.postcode = `Please give the ${country.postcodeLabel}.`;
  } else if (postcode.length > MAX.postcode || !validatePostcode(siteConfig.country, postcode)) {
    errors.postcode = `That does not look like a ${country.postcodeLabel}. Example: ${country.postcodeExample}.`;
  }

  if (phone.length < 6) errors.phone = "Please give a phone number people can call.";
  if (phone.length > MAX.phone) errors.phone = "That phone number is too long.";

  const website = normaliseWebsite(websiteRaw.slice(0, MAX.website));
  if (websiteRaw !== "" && website === null) errors.website = "That does not look like a web address.";

  if (description.length < DESCRIPTION_MIN) {
    errors.description = `Please write at least ${DESCRIPTION_MIN} characters.`;
  } else if (description.length > DESCRIPTION_MAX) {
    errors.description = `Please keep it under ${DESCRIPTION_MAX} characters.`;
  }

  if (submitterName.length < 2) errors.submitterName = "Please give your name.";
  if (submitterName.length > MAX.submitterName) errors.submitterName = "That name is too long.";
  // Deliberately permissive, as on the enquiry form: an over-strict pattern
  // rejects valid addresses, and delivery is the real test.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(submitterEmail)) {
    errors.submitterEmail = "Please give a valid email address.";
  }
  if (submitterEmail.length > MAX.submitterEmail) {
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

/**
 * Public listing submission. No account required: a login wall in front of an
 * unpaid, unclaimed listing costs more submissions than the spam it stops, so
 * the defence is Turnstile plus a honeypot plus a hard per-IP cap instead.
 */
export async function submitListing(
  _prev: SubmitListingState,
  form: FormData,
): Promise<SubmitListingState> {
  // Silent success for the honeypot: telling a bot it was caught just teaches
  // the operator to stop filling that field.
  if (isHoneypotTripped(form.get("company_website"))) {
    redirect("/add-listing/thanks");
  }

  const h = await headers();
  const ip = (h.get("x-forwarded-for") ?? "").split(",")[0]?.trim() || "unknown";

  // Three an hour. A person listing their own business does it once; three is
  // room for a genuine retry and nothing like enough for a spam run.
  const limit = await rateLimit(`submit-listing:${ip}`, { limit: 3, windowSeconds: 3600 });
  if (!limit.allowed) {
    return {
      status: "error",
      message: `Too many submissions from this connection. Please try again in ${Math.ceil(limit.retryAfterSeconds / 60)} minutes.`,
    };
  }

  const turnstile = await verifyTurnstile(
    (form.get("cf-turnstile-response") as string | null) ?? null,
    ip,
  );
  if (!turnstile.ok) {
    return { status: "error", message: "We couldn't verify that you're human. Please try again." };
  }

  const { values, errors } = validate(form);
  if (errors) {
    return { status: "error", fieldErrors: errors, message: "Please check the fields marked below." };
  }

  const result = await db.transaction(async (tx) => {
    // Same cast the test harness uses: a transaction handle and the root
    // client expose the same query surface to lib/db/queries.
    const handle = tx as unknown as TestDb;

    const duplicate = await findSubmissionDuplicate(handle, values);
    if (duplicate) return { kind: "duplicate" as const, duplicate };

    return { kind: "saved" as const, saved: await createSubmission(handle, { ...values, ip }) };
  });

  if (result.kind === "duplicate") {
    return {
      status: "duplicate",
      existing: {
        name: result.duplicate.name,
        claimPath: `/claim/${result.duplicate.slug}`,
      },
    };
  }

  if (result.saved.outcome === "unknown-category") {
    return { status: "error", fieldErrors: { categoryId: "Please choose a category." } };
  }

  // 'parked' and 'created' are the same event to the submitter: we have it and
  // an admin will look at it. The difference is only whether the town already
  // existed, which is our problem and not theirs.
  redirect("/add-listing/thanks");
}
