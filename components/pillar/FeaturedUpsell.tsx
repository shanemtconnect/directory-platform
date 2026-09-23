"use client";

import { useEffect, useState } from "react";

/**
 * "Your listing could be here" — for a signed-in owner whose listing is on
 * this page but not featured on it (Task 45, requirement 6).
 *
 * The pillar page is ISR-cached, so the strip cannot be rendered on the
 * server without writing one visitor's state into everybody's page. It is
 * therefore a client component that asks `/api/spots/upsell` after mount
 * and renders nothing until — and unless — that answers with a listing.
 * Anonymous visitors get a 204 decided from the cookie header alone.
 */

interface Upsell {
  listingId: string;
  listingName: string;
  fromCents: number;
  href: string;
}

export interface FeaturedUpsellProps {
  /** `areaKind:areaId:categoryId|-` — the spot this page is. */
  spotKey: string;
  /** The page's own noun, from the config, passed in so this file names none. */
  nounSingular: string;
  /** Formats minor units for the site: `Intl` needs the locale and currency the server knows. */
  locale: string;
  currency: string;
}

export function FeaturedUpsell({ spotKey, nounSingular, locale, currency }: FeaturedUpsellProps) {
  const [upsell, setUpsell] = useState<Upsell | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/spots/upsell?key=${encodeURIComponent(spotKey)}`, { credentials: "same-origin" })
      .then(async (res) => (res.status === 200 ? ((await res.json()) as Upsell) : null))
      .then((data) => {
        if (!cancelled && data !== null) setUpsell(data);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [spotKey]);

  if (upsell === null) return null;
  const money = new Intl.NumberFormat(locale, { style: "currency", currency, maximumFractionDigits: 0 }).format(upsell.fromCents / 100);
  return (
    <aside className="notice notice-status" role="status" data-testid="featured-upsell">
      <div className="notice-body">
        <p className="mb-0">
          Your {nounSingular} <strong>{upsell.listingName}</strong> could be featured here — from {money}/month.{" "}
          <a href={upsell.href} data-testid="featured-upsell-link">See the featured spots</a>
        </p>
      </div>
    </aside>
  );
}
