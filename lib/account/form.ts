import { siteConfig } from "@/config/site.config";
import { normaliseBody, stripCrlf } from "@/lib/actions/validation";
import type { OwnerListingPatch } from "@/lib/db/queries/owner";

/**
 * What the owner's edit form is allowed to send.
 *
 * Outside the "use server" module, like the other validators, so it can be
 * unit tested: an action module may only export async functions.
 *
 * The important rule here is the link check. An owner's website and social
 * links are rendered as `href`s on a public page, and `javascript:` in an
 * href is stored XSS with the owner's own hands on the keyboard. Only http
 * and https survive.
 */

type Result<T> = { values: T; errors?: undefined } | { values?: undefined; errors: Record<string, string> };

/** Monday first. Keys are stable; the labels are the component's business. */
export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const MAX = { phone: 40, website: 300, social: 300, socials: 8, day: 60 } as const;

function field(form: FormData, key: string): string {
  return stripCrlf(String(form.get(key) ?? "")).trim();
}

function isWebLink(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function validateOwnerListing(form: FormData): Result<OwnerListingPatch> {
  const errors: Record<string, string> = {};

  // The description is a body field: a paragraph break the owner typed is
  // content, not something to collapse into a space.
  const description = normaliseBody(String(form.get("description") ?? "")).trim();
  const phone = field(form, "phone");
  const website = field(form, "website");

  const maxDescription = siteConfig.listing.maxDescriptionChars;
  if (description.length > maxDescription) {
    errors.description = `Please keep the description under ${maxDescription} characters.`;
  }
  if (phone.length > MAX.phone) errors.phone = "That phone number is too long.";
  if (website.length > MAX.website) errors.website = "That address is too long.";
  if (website !== "" && !isWebLink(website)) {
    errors.website = "Please give a full web address starting http:// or https://.";
  }

  const socials = normaliseBody(String(form.get("socials") ?? ""))
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (socials.length > MAX.socials) errors.socials = `Please list at most ${MAX.socials} links.`;
  if (socials.some((s) => s.length > MAX.social || !isWebLink(s))) {
    errors.socials = "Each line must be a full web address starting http:// or https://.";
  }

  const openingHours: Record<string, string> = {};
  for (const day of DAY_KEYS) {
    const value = field(form, `hours-${day}`);
    if (value === "") continue;
    if (value.length > MAX.day) {
      errors.openingHours = `Please keep each day under ${MAX.day} characters.`;
      continue;
    }
    openingHours[day] = value;
  }

  if (Object.keys(errors).length > 0) return { errors };
  return {
    values: {
      description: description || null,
      phone: phone || null,
      website: website || null,
      socials,
      openingHours,
    },
  };
}
