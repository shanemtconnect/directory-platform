import { siteConfig } from "@/config/site.config";
import { db } from "@/lib/db/client";
import { prerenderingWithoutDatabase } from "@/lib/db/build-phase";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { listSwitcherCities } from "@/lib/db/queries/cities";
import { listCategories } from "@/lib/db/queries/indexes";
import { features } from "@/lib/features/flags";
import { LeadCaptureForm } from "./LeadCaptureForm";

/** Every indexable town, as on /get-quotes. */
const TOWN_LIMIT = 500;

export interface LeadCaptureBoxProps {
  /**
   * `home`: a full-width card below the fold on the home page. `rail`: the
   * house slot at the top of a sponsor rail — a card whose form opens in
   * place (a `<details>`, so no script is needed to open it).
   */
  variant: "home" | "rail";
}

/**
 * The lead-capture box (flag `leadMarketplace`, Task 56). A visitor who does
 * not want to browse says what they need and where; after they confirm by
 * email it becomes a lead a local business can buy (lib/actions/lead-capture.ts).
 *
 * Renders nothing with the flag off — a build-time constant, so the box is
 * absent from a flag-off build entirely — and nothing while a container build
 * prerenders without a database, or when the site has no towns or categories
 * to offer.
 */
export async function LeadCaptureBox({ variant }: LeadCaptureBoxProps) {
  if (!features.leadMarketplace) return null;
  if (prerenderingWithoutDatabase()) return null;

  const [categories, towns] = await Promise.all([
    listCategories(db as never, PUBLIC_VIEWER),
    listSwitcherCities(db as never, PUBLIC_VIEWER, { limit: TOWN_LIMIT }),
  ]);
  if (categories.length === 0 || towns.length === 0) return null;

  const e = siteConfig.entity;
  const form = (
    <LeadCaptureForm
      categories={categories.map((c) => ({ id: c.id, name: c.plural }))}
      towns={towns.map((t) => ({ id: t.id, name: t.name }))}
      turnstileSiteKey={process.env.TURNSTILE_SITE_KEY?.trim() || null}
      idPrefix={`lead-capture-${variant}`}
    />
  );

  if (variant === "rail") {
    return (
      <details className="card sponsor-card lead-capture-rail" data-testid="lead-capture" data-variant="rail">
        <summary className="sponsor-card-link">
          <span className="sponsor-label">{siteConfig.shortName}</span>
          <strong className="sponsor-title">Need a {e.singular}?</strong>
          <span className="sponsor-blurb">Tell us what you need and we&rsquo;ll find you one.</span>
        </summary>
        {form}
      </details>
    );
  }

  return (
    <section aria-labelledby="lead-capture-heading" className="card" data-testid="lead-capture" data-variant="home">
      <h2 id="lead-capture-heading" className="mt-0">Not sure who to ask?</h2>
      <p className="text-muted">
        Tell us what you need and where. Confirm by email and we&rsquo;ll pass it to a local {e.singular} that can help.
      </p>
      {form}
    </section>
  );
}
