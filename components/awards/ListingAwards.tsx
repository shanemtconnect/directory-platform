import { awardText, type ListingAward } from "@/lib/db/queries/awards";
import { AwardPill } from "./AwardPill";

/**
 * The awards block on a listing page (Task 50). The text of each line is
 * `awardText`, the same string the page's LocalBusiness node carries as
 * `award`, so the markup can never say more than the page does. Renders
 * nothing at all when there is nothing to say.
 */
export function ListingAwards({ awards }: { awards: readonly ListingAward[] }) {
  if (awards.length === 0) return null;
  return (
    <section aria-labelledby="awards" data-testid="listing-awards" className="card bg-raised">
      <h2 id="awards" className="mt-0">Awards</h2>
      <ul className="m-0 flex list-none flex-col gap-2 p-0">
        {awards.map((a) => (
          <li key={a.awardId} className="m-0 flex flex-wrap items-center gap-2">
            <AwardPill year={a.year} href={a.awardsPath} />
            <a href={a.awardsPath}>{awardText(a)}</a>
          </li>
        ))}
      </ul>
      <p className="mb-0 text-sm text-muted">
        Computed once a year from published reviews. Never voted on, never sold.
      </p>
    </section>
  );
}
