import { siteConfig } from "@/config/site.config";
import { IntervalToggle } from "@/components/pricing/IntervalToggle";
import { PricingCard } from "@/components/pricing/PricingCard";
import { ComparisonTable } from "@/components/pricing/ComparisonTable";
import {
  annualSaving,
  formatMoney,
  isFree,
  orderedTiers,
  type Interval,
} from "@/lib/pricing";

const INTERVAL_LABELS: Readonly<Record<Interval, string>> = {
  annual: "Pay yearly",
  monthly: "Pay monthly",
};

/**
 * Renders entirely from siteConfig.tiers. There is no plan name, price, feature
 * or benefit line written into this file — a clone edits config/site.config.ts
 * and this page follows.
 *
 * The interval arrives as a prop from the ROUTE, not from a query string.
 * Reading searchParams forces the route dynamic in Next 16, which silently
 * killed the `revalidate` on the page the money arrives through; /pricing and
 * /pricing/monthly are two static pages instead.
 */
export function PricingContent({ interval }: { interval: Interval }) {
  const e = siteConfig.entity;
  const { locale, currency } = siteConfig;

  const tiers = orderedTiers(siteConfig.tiers);
  const paid = tiers.filter(([, t]) => !isFree(t));

  // The headline saving is derived from whatever the config actually says, and
  // is only claimed when every paid plan agrees on it.
  const savings = paid.map(([, t]) => annualSaving(t));
  const first = savings[0];
  const uniform =
    first != null && savings.every((s) => s != null && s.months === first.months);
  const savingNote =
    uniform && first != null
      ? `Paying yearly costs ${first.months} ${first.months === 1 ? "month" : "months"} less than paying monthly on every paid plan.`
      : undefined;

  const trialDays = paid.length > 0 ? Math.max(...paid.map(([, t]) => t.trialDays)) : 0;
  const currencyName =
    new Intl.DisplayNames([locale], { type: "currency" }).of(currency) ?? currency;

  return (
    <main data-testid="pricing-page" data-interval={interval}>
      <h1>Pricing</h1>
      <p>
        {siteConfig.tagline}. Anyone can {e.verb} a {e.singular} here for nothing. Paid plans buy
        reach and richness — never reachability.
      </p>
      <p>
        On every plan, including free and unclaimed ones, the name, address, phone number,
        opening hours, map pin, category and enquiry form stay visible to everyone. We do not
        put a price on letting a customer contact you.
      </p>

      <IntervalToggle active={interval} labels={INTERVAL_LABELS} savingNote={savingNote} />

      <ul data-testid="plans">
        {tiers.map(([name, tier]) => (
          <PricingCard
            key={name}
            name={name}
            tier={tier}
            interval={interval}
            locale={locale}
            currency={currency}
            ownerNoun={e.ownerNoun}
          />
        ))}
      </ul>

      {trialDays > 0 && (
        <p data-testid="trial-summary">
          Paid plans start with a {trialDays}-day free trial. You are not charged during it, and
          cancelling before it ends costs nothing.
        </p>
      )}

      <h2>Compare the plans</h2>
      <ComparisonTable
        tiers={siteConfig.tiers}
        caption={`What each plan shows on your ${e.singular} listing`}
      />

      <h2>About the Verified badge</h2>
      <p>
        Verification is included with every paid plan, but the payment is not what earns the
        badge. A {e.ownerNoun} also has to pass our control check — proving they run the
        business, and that any credentials the listing claims are real. Until that check
        passes, the subscription is active and the badge is not shown.
      </p>
      <p>
        The badge is never for sale, and it is not a judgement on anyone&rsquo;s work. It
        records identity and control as at the date of the check.
        {siteConfig.verification.expiresWithSubscription && (
          <> It lapses if the subscription lapses.</>
        )}{" "}
        <a href="/trust">Read what our badges do and do not mean</a>.
      </p>

      <h2>Billing</h2>
      <p>
        Prices are shown in {currencyName} and{" "}
        {interval === "annual" ? "billed once a year" : "billed every month"}. You can change
        plan or cancel at any time from your dashboard.
        {paid.length > 0 && (
          <>
            {" "}
            The cheapest paid plan is{" "}
            {formatMoney(
              Math.min(
                ...paid.map(([, t]) => (interval === "annual" ? t.priceAnnual : t.priceMonthly)),
              ),
              locale,
              currency,
            )}
            .
          </>
        )}
      </p>
      <p>
        Questions about a plan? Email{" "}
        <a href={`mailto:${siteConfig.supportEmail}`}>{siteConfig.supportEmail}</a>.
      </p>
    </main>
  );
}
