import type { TierName, TierSpec } from "@/config/types";
import { formatMoney, priceFor, type Interval } from "@/lib/pricing";

/**
 * What the buyer is about to agree to, rendered entirely from the tier spec.
 * No plan name, price or benefit is written into this file — a clone edits
 * config/site.config.ts and this panel follows.
 */
export function PlanSummary({
  name,
  tier,
  interval,
  locale,
  currency,
  subjectName,
  discount,
}: {
  name: TierName;
  tier: TierSpec;
  interval: Interval;
  locale: string;
  currency: string;
  subjectName: string;
  /** Set when a valid code is on the URL. Major units, already discounted. */
  discount?: { code: string; firstPayment: number; summary: string } | undefined;
}) {
  const price = priceFor(tier, interval);
  const per = interval === "annual" ? "a year" : "a month";

  return (
    <div data-testid="plan-summary" data-tier={name} data-interval={interval} className="card">
      <h2 className="mt-0 text-[length:var(--text-h3)]">{tier.label}</h2>
      <p data-testid="summary-subject">For {subjectName}</p>
      <p data-testid="summary-price">
        <strong className="font-heading text-3xl">{formatMoney(price, locale, currency)}</strong>{" "}
        <span className="text-muted">{per}</span>
      </p>
      {discount !== undefined && (
        <p data-testid="summary-discount">
          Code <strong>{discount.code}</strong> applied — {discount.summary}. Your first payment
          is {formatMoney(discount.firstPayment, locale, currency)}, and it goes back to{" "}
          {formatMoney(price, locale, currency)} {per} after that.
        </p>
      )}

      {tier.trialDays > 0 && (
        <p data-testid="summary-trial" className="text-sm text-muted">
          Your first {tier.trialDays} days are free. Nothing is charged until the trial ends, and
          cancelling before then costs nothing.
        </p>
      )}
      <ul className="mt-2 mb-0 list-disc space-y-1 pl-5 text-sm">
        {tier.bullets.map((b) => (
          <li key={b}>{b}</li>
        ))}
      </ul>
    </div>
  );
}
