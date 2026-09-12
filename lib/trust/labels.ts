import { siteConfig } from "@/config/site.config";
import type { RemovalRelationship, ReportReason } from "@/lib/db/queries/trust";

/**
 * The words a person sees for the two enum columns, in one place.
 *
 * The form and the admin notification must not describe the same value
 * differently — a queue that says "offensive" while the visitor chose
 * "shouldn't be here" is a queue an operator has to translate in their head.
 *
 * The type imports are type-only, so a client component can render these
 * without dragging the database layer into the browser bundle. `siteConfig`
 * is a value import, not niche-specific itself: every word here comes from
 * `entity.singular` rather than naming "business" outright, so the same file
 * serves whatever the directory lists.
 */

const entity = siteConfig.entity.singular;

export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  incorrect: "Some of the details are wrong",
  closed: `This ${entity} has closed`,
  duplicate: "It is listed here twice",
  offensive: "This shouldn't be on the site",
  other: "Something else",
};

export const REMOVAL_RELATIONSHIP_LABELS: Record<RemovalRelationship, string> = {
  owner: `I own the ${entity}`,
  employee: "I work there",
  subject: "The listing is about me personally",
  other: "Something else",
};
