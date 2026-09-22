import { siteConfig } from "@/config/site.config";
import { countryProfile } from "@/lib/geo/countries";
import { siteUrl } from "@/lib/schema/builders";
import { prune, type JsonLd } from "@/lib/schema/types";
import type { PublicJob } from "@/lib/db/queries/job-board";

const SCHEMA = "https://schema.org";

/**
 * What the job page RENDERS, and therefore what its markup may say.
 *
 * Global constraint 11: if it is not on the page it is not in the JSON-LD.
 * The builder takes the same object the page renders from plus the two
 * things the page decided — whether it showed the description and whether it
 * showed a budget — so the markup cannot claim a salary the visitor never
 * saw. A closed job gets no JobPosting at all: Google treats a posting whose
 * `validThrough` has passed as expired and a page that keeps emitting one as
 * misleading, and the page renders a "closed" notice instead.
 */
export interface JobPostingInput {
  readonly job: PublicJob;
  /** The description as rendered, or null when the page showed none. */
  readonly description: string | null;
  /** True only when the page rendered the budget line. */
  readonly budgetShown: boolean;
}

export function jobPostingSchema(input: JobPostingInput): JsonLd | null {
  const { job } = input;
  if (!job.open || job.publishedAt === null) return null;

  const profile = countryProfile(siteConfig.country);
  const min = input.budgetShown && job.budgetMin !== null ? Number(job.budgetMin) : null;
  const max = input.budgetShown && job.budgetMax !== null ? Number(job.budgetMax) : null;

  return prune({
    "@context": SCHEMA,
    "@type": "JobPosting",
    title: job.title,
    description: input.description ?? undefined,
    datePosted: job.publishedAt.toISOString(),
    validThrough: job.expiresAt?.toISOString(),
    url: siteUrl(job.path),
    hiringOrganization: job.companyName
      ? { "@type": "Organization", name: job.companyName }
      : undefined,
    jobLocation: job.cityName
      ? {
          "@type": "Place",
          address: {
            "@type": "PostalAddress",
            addressLocality: job.cityName,
            addressRegion: job.cityRegion ?? undefined,
            addressCountry: profile.code,
          },
        }
      : undefined,
    baseSalary:
      min !== null || max !== null
        ? {
            "@type": "MonetaryAmount",
            currency: siteConfig.currency,
            value: {
              "@type": "QuantitativeValue",
              minValue: min ?? undefined,
              maxValue: max ?? undefined,
            },
          }
        : undefined,
    directApply: false,
  });
}
