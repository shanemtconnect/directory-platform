import { isUuid, normaliseBody, stripCrlf } from "@/lib/actions/validation";

/**
 * The /post-a-job form, checked before anything is spent (Task 49).
 *
 * Same discipline as lib/actions/validation.ts: single-line fields lose their
 * CR/LF (they reach an email subject and a JSON-LD title), the description
 * keeps its paragraph breaks, and every uuid is shape-checked before it is
 * compared against a column. Nothing here touches the database — the listing
 * a free post names is checked for ownership in the query, not here.
 */

export interface JobFormValues {
  readonly title: string;
  readonly description: string;
  readonly companyName: string;
  readonly posterName: string;
  readonly posterEmail: string;
  readonly cityId: string;
  readonly categoryId: string;
  readonly budgetMin: number | null;
  readonly budgetMax: number | null;
  readonly applyMethod: "email" | "url";
  readonly applyEmail: string | null;
  readonly applyUrl: string | null;
  /** Hidden field: the Verified listing to post free on behalf of, or null. */
  readonly listingId: string | null;
}

export type JobFormResult =
  | { values: JobFormValues; errors?: undefined }
  | { values?: undefined; errors: Record<string, string> };

export const JOB_TITLE_MAX = 120;
export const JOB_DESCRIPTION_MIN = 50;
export const JOB_DESCRIPTION_MAX = 3000;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function field(form: FormData, key: string): string {
  return stripCrlf(String(form.get(key) ?? "")).trim();
}

function money(raw: string): number | null | undefined {
  if (raw === "") return null;
  const value = Number(raw.replace(/[,\s]/g, ""));
  if (!Number.isFinite(value) || value < 0 || value > 10_000_000) return undefined;
  return Math.round(value * 100) / 100;
}

function httpUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function validateJobForm(form: FormData): JobFormResult {
  const errors: Record<string, string> = {};

  const title = field(form, "title");
  if (title.length < 5 || title.length > JOB_TITLE_MAX) {
    errors.title = `Please give the job a title of 5 to ${JOB_TITLE_MAX} characters.`;
  }

  const description = normaliseBody(String(form.get("description") ?? "")).trim();
  if (description.length < JOB_DESCRIPTION_MIN || description.length > JOB_DESCRIPTION_MAX) {
    errors.description = `Please describe the role in ${JOB_DESCRIPTION_MIN} to ${JOB_DESCRIPTION_MAX} characters.`;
  }

  const companyName = field(form, "companyName");
  if (companyName.length < 2 || companyName.length > 120) {
    errors.companyName = "Please say who is hiring.";
  }

  const posterName = field(form, "posterName");
  if (posterName.length < 2 || posterName.length > 100) errors.posterName = "Please give your name.";

  const posterEmail = field(form, "posterEmail").toLowerCase();
  if (!EMAIL.test(posterEmail) || posterEmail.length > 254) {
    errors.posterEmail = "Please give a valid email address.";
  }

  const cityId = field(form, "cityId");
  if (!isUuid(cityId)) errors.cityId = "Please choose a town.";
  const categoryId = field(form, "categoryId");
  if (!isUuid(categoryId)) errors.categoryId = "Please choose a category.";

  const budgetMin = money(field(form, "budgetMin"));
  const budgetMax = money(field(form, "budgetMax"));
  if (budgetMin === undefined) errors.budgetMin = "Please give a number, or leave it blank.";
  if (budgetMax === undefined) errors.budgetMax = "Please give a number, or leave it blank.";
  if (
    typeof budgetMin === "number" &&
    typeof budgetMax === "number" &&
    budgetMin > budgetMax
  ) {
    errors.budgetMax = "The top of the range is below the bottom.";
  }

  const applyMethodRaw = field(form, "applyMethod");
  const applyMethod: JobFormValues["applyMethod"] | null =
    applyMethodRaw === "email" || applyMethodRaw === "url" ? applyMethodRaw : null;
  if (applyMethod === null) errors.applyMethod = "Please say how people should apply.";

  let applyEmail: string | null = null;
  let applyUrl: string | null = null;
  if (applyMethod === "email") {
    applyEmail = field(form, "applyEmail").toLowerCase();
    if (!EMAIL.test(applyEmail) || applyEmail.length > 254) {
      errors.applyEmail = "Please give the address applications should go to.";
    }
  } else if (applyMethod === "url") {
    applyUrl = httpUrl(field(form, "applyUrl"));
    if (applyUrl === null || applyUrl.length > 2000) {
      errors.applyUrl = "Please give the full web address, starting with https://.";
    }
  }

  const listingRaw = field(form, "listingId");
  const listingId = listingRaw === "" ? null : listingRaw;
  if (listingId !== null && !isUuid(listingId)) errors.listingId = "That listing could not be read.";

  if (Object.keys(errors).length > 0) return { errors };
  return {
    values: {
      title,
      description,
      companyName,
      posterName,
      posterEmail,
      cityId,
      categoryId,
      budgetMin: budgetMin ?? null,
      budgetMax: budgetMax ?? null,
      applyMethod: applyMethod!,
      applyEmail,
      applyUrl,
      listingId,
    },
  };
}
