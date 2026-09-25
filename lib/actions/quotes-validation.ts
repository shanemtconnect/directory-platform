import { isUuid, normaliseBody, stripCrlf } from "./validation";

/**
 * Field validation for the get-quotes form.
 *
 * Outside the "use server" module for the same reason the other validators
 * are: those may only export async functions, and validation that cannot be
 * unit tested is validation nobody checks. The rules are the enquiry rules —
 * uuid shapes checked before Postgres sees them, CR/LF out of every
 * header-bound field, paragraph breaks kept in the one body field.
 */

function field(form: FormData, key: string): string {
  return stripCrlf(String(form.get(key) ?? "")).trim();
}

function bodyField(form: FormData, key: string): string {
  return normaliseBody(String(form.get(key) ?? "")).trim();
}

type Result<T> =
  | { values: T; errors?: undefined }
  | { values?: undefined; errors: Record<string, string> };

export interface QuoteFormValues {
  cityId: string;
  categoryId: string;
  name: string;
  email: string;
  phone: string | null;
  message: string;
}

/** The brief's cap: a job description, not an essay. */
export const QUOTE_MESSAGE_MAX = 1000;
export const QUOTE_MESSAGE_MIN = 10;

const MAX = { name: 120, email: 254, phone: 40 } as const;

export function validateQuoteRequest(form: FormData): Result<QuoteFormValues> {
  const errors: Record<string, string> = {};
  const cityId = field(form, "cityId");
  const categoryId = field(form, "categoryId");
  const name = field(form, "name");
  const email = field(form, "email");
  const phone = field(form, "phone");
  const message = bodyField(form, "message");
  const consent = form.get("consent");

  // Both are <select>s fed from the database, so a bad shape is a tampered
  // form — but the message still has to be one a person can act on.
  if (!isUuid(cityId)) errors.cityId = "Please choose a town.";
  if (!isUuid(categoryId)) errors.categoryId = "Please choose a category.";

  if (name.length < 2) errors.name = "Please give your name.";
  if (name.length > MAX.name) errors.name = "That name is too long.";
  // Deliberately permissive: the address is verified by whether the reply
  // arrives, not by us.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.email = "Please give a valid email address.";
  if (email.length > MAX.email) errors.email = "That email address is too long.";
  if (phone.length > MAX.phone) errors.phone = "That phone number is too long.";
  if (message.length < QUOTE_MESSAGE_MIN) errors.message = "Please describe the job in a little more detail.";
  if (message.length > QUOTE_MESSAGE_MAX) errors.message = `Please keep it under ${QUOTE_MESSAGE_MAX} characters.`;
  // The consent box is the visitor's permission to hand their details to
  // businesses they have not named. Without it there is nothing to send.
  if (consent !== "on" && consent !== "true") errors.consent = "Please tick the box so we can pass your details on.";

  if (Object.keys(errors).length > 0) return { errors };
  return { values: { cityId, categoryId, name, email, phone: phone || null, message } };
}

export interface QuoteFormRawValues {
  cityId: string;
  categoryId: string;
  name: string;
  email: string;
  phone: string;
  message: string;
  consent: boolean;
}

/**
 * The submitted values, unvalidated, for feeding straight back into the
 * form's `defaultValue`s after a refusal (Task 60). React resets an
 * uncontrolled form's fields to their `defaultValue` once the action
 * returns — so a refusal that answered with nothing but field errors left
 * the form empty for the person to fill in a second time.
 */
export function rawQuoteFormValues(form: FormData): QuoteFormRawValues {
  const consent = form.get("consent");
  return {
    cityId: field(form, "cityId"),
    categoryId: field(form, "categoryId"),
    name: field(form, "name"),
    email: field(form, "email"),
    phone: field(form, "phone"),
    message: bodyField(form, "message"),
    consent: consent === "on" || consent === "true",
  };
}

/**
 * The lead-capture box (Task 56): the get-quotes fields, with the phone
 * REQUIRED — a capture request becomes a lead a business pays for, and a
 * lead is a number to ring. Whether the number is diallable is the lead
 * rules' call (lib/leads/rules.ts), made inside the action's transaction.
 */
export function validateCaptureLead(form: FormData): Result<QuoteFormValues> {
  const result = validateQuoteRequest(form);
  const phone = field(form, "phone");
  if (phone === "") {
    return { errors: { ...(result.errors ?? {}), phone: "Please give a phone number we can call." } };
  }
  return result;
}
