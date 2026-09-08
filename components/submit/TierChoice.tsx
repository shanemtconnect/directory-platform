"use client";

import { siteConfig } from "@/config/site.config";
import type { TierName } from "@/config/types";

const TIERS = Object.entries(siteConfig.tiers) as [TierName, (typeof siteConfig.tiers)[TierName]][];

function priceLine(tier: (typeof siteConfig.tiers)[TierName]): string {
  if (tier.priceMonthly === 0) return "Free, forever";
  const money = new Intl.NumberFormat(siteConfig.locale, {
    style: "currency",
    currency: siteConfig.currency,
  });
  return `${money.format(tier.priceMonthly)} a month, or ${money.format(tier.priceAnnual)} a year`;
}

/**
 * The tier is a REQUEST, not a purchase. Nothing is charged here and the
 * listing is filed on the free tier either way — see lib/actions/submit-listing.ts.
 */
export function TierChoice({ error }: { error?: string }) {
  return (
    <fieldset data-testid="tier-choice">
      <legend>Which listing do you want?</legend>

      {TIERS.map(([key, tier], index) => (
        <p key={key}>
          <label htmlFor={`tier-${key}`}>
            <input
              id={`tier-${key}`}
              type="radio"
              name="tier"
              value={key}
              defaultChecked={index === 0}
              required
            />{" "}
            <strong>{tier.label}</strong> — {priceLine(tier)}
            {tier.trialDays > 0 && <> · {tier.trialDays}-day free trial</>}
          </label>
          <br />
          <small>{tier.bullets.join(" · ")}</small>
        </p>
      ))}

      {error && <span role="alert">{error}</span>}

      <p>
        <small>
          We take no payment on this form. If you pick a paid option we&rsquo;ll email you a link
          to start the free trial once your listing is approved — the subscription starts only
          when you approve it with PayPal, not when we approve your listing. Your listing goes
          live on the free option regardless.
        </small>
      </p>
    </fieldset>
  );
}
