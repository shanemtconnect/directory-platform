import { siteConfig } from "@/config/site.config";
import { saveCityIntroAction, setCityPublishedAction } from "@/lib/actions/admin";
import type { AdminCity } from "@/lib/db/queries/admin/cities";

/**
 * One town, with its two edits inline.
 *
 * The intro box is a plain textarea and what it saves is escaped into `<p>`
 * paragraphs — no markup survives the form (see `introHtmlFromText`). The
 * current copy is NOT loaded back into the box: the column may hold markup this
 * form does not accept (the seed writes links and lists), and an edit that
 * re-saved those tags would publish them as visible text. It is shown beside
 * the box instead, as the source it is, so a save replaces something the admin
 * has read rather than something they guessed at.
 */
function Flag({ on, yes, no }: { on: boolean; yes: string; no: string }) {
  return (
    <span className={on ? "pill pill-on" : "pill"}>
      {on ? yes : no}
    </span>
  );
}

export function CityRow({ city }: { city: AdminCity }) {
  const threshold = siteConfig.seo.minListingsToIndex;

  return (
    <details className="card mb-3" data-testid={`admin-city-${city.slug}`}>
      <summary className="cursor-pointer list-item">
        <strong>{city.name}</strong>
        {city.region !== null && <span className="text-muted"> · {city.region}</span>}
        <span className="ml-2 inline-flex flex-wrap gap-1 align-middle">
          <Flag on={city.isPublished} yes="published" no="hidden" />
          <Flag on={city.isIndexable} yes="indexable" no="noindex" />
          <Flag on={city.hasIntro} yes="has copy" no="no copy" />
        </span>
        <span className="text-muted">
          {" "}
          · {city.listingCount} live · created by {city.createdBy}
        </span>
      </summary>

      <p className="mt-4 text-sm text-muted">
        {siteConfig.seo.requireIntroCopyToIndex
          ? `Indexing needs ${threshold} published ${siteConfig.entity.plural} and intro copy. It is recomputed every time either changes — it is never set by hand.`
          : `Indexing needs ${threshold} published ${siteConfig.entity.plural}. Intro copy is not required to index here. The gate is recomputed every time the count changes — it is never set by hand.`}
      </p>

      {city.introHtml !== null && (
        <div className="mb-4">
          <span className="text-sm font-semibold uppercase tracking-wide text-muted">
            Currently stored
          </span>
          <pre tabIndex={0} className="mt-1 max-h-48 overflow-auto rounded border border-line bg-raised p-3 text-sm whitespace-pre-wrap">
            {city.introHtml}
          </pre>
        </div>
      )}

      <form action={saveCityIntroAction}>
        <input type="hidden" name="cityId" value={city.id} />
        <input type="hidden" name="citySlug" value={city.slug} />
        <p>
          <label htmlFor={`intro-${city.slug}`}>Intro copy for {city.name}</label>
          <textarea
            id={`intro-${city.slug}`}
            name="intro"
            rows={5}
            required
            placeholder="Plain text. Leave a blank line between paragraphs."
            className="max-w-full"
          />
          <small>
            Plain text only — it is escaped and wrapped in paragraphs on save. Saving replaces
            whatever is there; saving nothing removes it and closes the gate.
          </small>
        </p>
        <button type="submit" className="btn btn-primary">Save intro copy</button>
      </form>

      <form action={setCityPublishedAction} className="mt-4">
        <input type="hidden" name="cityId" value={city.id} />
        <input type="hidden" name="citySlug" value={city.slug} />
        <input type="hidden" name="isPublished" value={city.isPublished ? "false" : "true"} />
        <button type="submit" className="btn btn-secondary">
          {city.isPublished ? "Hide this town" : "Publish this town"}
        </button>
      </form>

      <p className="mt-4 text-sm">
        <a href={`/${city.slug}`}>View the town page</a>
      </p>
    </details>
  );
}
