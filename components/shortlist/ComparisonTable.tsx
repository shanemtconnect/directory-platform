import { siteConfig } from "@/config/site.config";
import type { ShortlistEntry } from "@/lib/db/queries/shortlist";
import { comparisonFields, readField } from "./fields";
import { RemoveButton } from "./RemoveButton";
import { SaveButton } from "./SaveButton";

/**
 * The comparison itself: one column per saved listing, one row per attribute,
 * so the eye runs across a single line to answer one question at a time. A
 * stack of cards is not a comparison — it is the pillar page again.
 *
 * The attribute rows are the ones a shortlist exists to settle: where it is,
 * what it is, and whatever `showInCard` custom fields this niche put on the
 * card. Nothing here is hardcoded to a niche.
 */
export function ComparisonTable({
  entries, mode,
}: { entries: readonly ShortlistEntry[]; mode: "own" | "shared" }) {
  const e = siteConfig.entity;

  return (
    // Many columns will exceed the viewport. Scroll the table, never the page.
    <div className="table-scroll" data-testid="shortlist-comparison">
      <table>
        <caption>
          {entries.length} {entries.length === 1 ? e.singular : e.plural} compared
        </caption>
        <thead>
          <tr>
            <th scope="col">{e.Singular}</th>
            {entries.map((entry) => (
              <th key={entry.itemId} scope="col" data-tier={entry.tier}>
                <a href={`/${entry.citySlug}/${entry.slug}`}>{entry.name}</a>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">Location</th>
            {entries.map((entry) => (
              <td key={entry.itemId}>
                <a href={`/${entry.citySlug}`}>{entry.cityName}</a>
              </td>
            ))}
          </tr>
          <tr>
            <th scope="row">Type</th>
            {entries.map((entry) => <td key={entry.itemId}>{entry.categoryName}</td>)}
          </tr>

          {comparisonFields.map((field) => (
            <tr key={field.key}>
              <th scope="row">{field.label}</th>
              {entries.map((entry) => {
                const value = readField(field, entry.customFields, entry.tier);
                return (
                  <td key={entry.itemId} data-field={field.key}>
                    {value ?? <span aria-label="Not given">—</span>}
                  </td>
                );
              })}
            </tr>
          ))}

          <tr>
            <th scope="row">Summary</th>
            {entries.map((entry) => (
              <td key={entry.itemId}>
                {entry.shortDescription ?? <span aria-label="Not given">—</span>}
              </td>
            ))}
          </tr>
        </tbody>
        <tfoot>
          <tr>
            <th scope="row">{mode === "own" ? "Remove" : "Save"}</th>
            {entries.map((entry) => (
              <td key={entry.itemId}>
                {mode === "own" ? (
                  <RemoveButton listingId={entry.listingId} listingName={entry.name} />
                ) : (
                  <SaveButton
                    listingId={entry.listingId}
                    listingName={entry.name}
                    savedLabel="On your list"
                  />
                )}
              </td>
            ))}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}
