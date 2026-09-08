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
    <li data-tier={name} data-testid={`plan-${name}`} className="card flex flex-col">
      <h2 className="mt-0 mb-1 text-[length:var(--text-h3)]">{tier.label}</h2>
      <p data-testid="strapline" className="text-sm text-muted">{tier.strapline}</p>

      <p data-testid="price" className="mt-2">
        <strong className="font-heading text-3xl">{formatMoney(price, locale, currency)}</strong>
        {!free && <span className="text-muted"> {perLabel}</span>}
      </p>

      {!free && interval === "annual" && saving && (
        <p data-testid="saving" className="text-sm text-muted">
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
        <p data-testid="trial" className="text-sm text-muted">
          Starts with a {tier.trialDays}-day free trial. Nothing is charged until it ends, and
          you can cancel before then.
        </p>
      )}

      <ul data-testid="bullets" className="mt-2 mb-0 list-disc space-y-1 pl-5 text-sm">
        {tier.bullets.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>

      {tier.verificationIncluded && (
        <p data-testid="verification-note" className="mt-4 mb-0 border-t border-line pt-4 text-sm text-muted">
          Includes our verification check. Paying does not by itself put the Verified badge on
          your listing — the {ownerNoun} still has to pass the check that proves they control
          the business.
        </p>
      )}
    </li>
  );
}
