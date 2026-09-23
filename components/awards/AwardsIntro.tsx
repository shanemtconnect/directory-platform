import { siteConfig } from "@/config/site.config";
import { AWARDS_MIN_RATED_LISTINGS, awardsMinReviews } from "@/lib/db/queries/awards";

/**
 * How the awards work, in the words the pages share (Task 50). One place, so
 * the index, the year page and the town page cannot describe three different
 * methods — and every number comes from the code that applies it.
 */
export function AwardsIntro() {
  const e = siteConfig.entity;
  return (
    <p className="text-muted">
      Each year, every town and category with at least {AWARDS_MIN_RATED_LISTINGS} rated {e.plural}{" "}
      gets one winner: the {e.singular} with the highest rating from at least {awardsMinReviews()}{" "}
      published reviews. Computed, never voted on, never sold.
    </p>
  );
}
