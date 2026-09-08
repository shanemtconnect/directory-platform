import type { TierName, TierSpec } from "@/config/types";
import { annualSaving, formatMoney, isFree, priceFor, type Interval } from "@/lib/pricing";

/**
 * Everything on this card is read off the TierSpec. Nothing here knows how many
 * plans exist, what they are called, or what they cost.
 */
export function PricingCard({
  name,
  tier,
  interval,
  locale,
  currency,
  ownerNoun,
}: {
  name: TierName;
  tier: TierSpec;
  interval: Interval;
  locale: string;
  currency: string;
  ownerNoun: string;
}) {
  const free = isFree(tier);
  const price = priceFor(tier, interval);
  const saving = annualSaving(tier);
  const perLabel = interval === "annual" ? "per year" : "per month";

  return (
    <li data-tier={name} data-testid={`plan-${name}`}>
      <h2>{tier.label}</h2>
      <p data-testid="strapline">{tier.strapline}</p>

      <p data-testid="price">
        <strong>{formatMoney(price, locale, currency)}</strong>
        {!free && <span> {perLabel}</span>}
      </p>

      {!free && interval === "annual" && saving && (
        <p data-testid="saving">
          Saves {formatMoney(saving.amount, locale, currency)} a year — {saving.months}{" "}
          {saving.months === 1 ? "month" : "months"} free compared with paying monthly.
        </p>
      )}

      {!free && interval === "monthly" && (
        <p data-testid="switch-hint">
          <a href="/pricing?interval=annual" rel="nofollow">
            Pay yearly to spend less
          </a>
        </p>
      )}

      {tier.trialDays > 0 && (
        <p data-testid="trial">
          Starts with a {tier.trialDays}-day free trial. Nothing is charged until it ends, and
          you can cancel before then.
        </p>
      )}

      <ul data-testid="bullets">
        {tier.bullets.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>

      {tier.verificationIncluded && (
        <p data-testid="verification-note">
          Includes our verification check. Paying does not by itself put the Verified badge on
          your listing — the {ownerNoun} still has to pass the check that proves they control
          the business.
        </p>
      )}
    </li>
  );
}
