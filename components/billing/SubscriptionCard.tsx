import { siteConfig } from "@/config/site.config";
import type { OwnerSubscription } from "@/lib/db/queries/billing";
import { CancelButton } from "./CancelButton";

/**
 * One subscription, in the owner's own words.
 *
 * `status` comes out of the database as a provider-neutral string; it is
 * translated here rather than shown raw, because "past_due" on a page is a
 * support email and "We could not take the last payment" is a fixed card.
 */

const STATUS_LABELS: Record<string, string> = {
  approval_pending: "Waiting for PayPal to confirm",
  active: "Active",
  past_due: "Payment failed — please check your PayPal account",
  cancelled: "Cancelled",
  suspended: "Paused by PayPal after a failed payment",
  expired: "Ended",
};

function formatDate(value: Date | null, locale: string, timezone: string): string | null {
  if (value === null) return null;
  return new Intl.DateTimeFormat(locale, {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: timezone,
  }).format(value);
}

export function SubscriptionCard({
  subscription,
  manageUrl,
}: {
  subscription: OwnerSubscription;
  manageUrl: string;
}) {
  const { locale, timezone } = siteConfig;
  const spec = siteConfig.tiers[subscription.tier];
  const periodEnd = formatDate(subscription.currentPeriodEnd, locale, timezone);
  const trialEnd = formatDate(subscription.trialEndsAt, locale, timezone);
  const cancelling = subscription.cancelAtPeriodEnd;
  const live = subscription.status === "active" || subscription.status === "past_due";

  return (
    <li
      data-testid="subscription"
      data-status={subscription.status}
      data-tier={subscription.tier}
      className="card list-none"
    >
      <h2 className="mt-0 text-[length:var(--text-h3)]">
        <a href={subscription.listingPath}>{subscription.listingName}</a>
      </h2>
      <dl>
        <dt>Plan</dt>
        <dd data-testid="sub-plan">
          {spec.label}, billed {subscription.interval === "annual" ? "yearly" : "monthly"}
        </dd>

        <dt>Status</dt>
        <dd data-testid="sub-status">
          {STATUS_LABELS[subscription.status] ?? subscription.status}
        </dd>

        {trialEnd !== null && (
          <>
            <dt>Free trial ends</dt>
            <dd data-testid="sub-trial-end">{trialEnd}</dd>
          </>
        )}

        {periodEnd !== null && (
          <>
            <dt>{cancelling ? "Access ends" : "Next payment"}</dt>
            <dd data-testid="sub-period-end">{periodEnd}</dd>
          </>
        )}
      </dl>

      {cancelling ? (
        <p data-testid="sub-cancelling">
          This subscription is cancelled and will not renew
          {periodEnd === null ? "." : `, so it ends on ${periodEnd}.`}
        </p>
      ) : (
        live && <CancelButton subscriptionId={subscription.id} periodEndLabel={periodEnd} />
      )}

      <p className="text-sm text-muted">
        <a href={manageUrl} rel="noopener noreferrer nofollow" target="_blank">
          Change the payment method at PayPal
        </a>
        {" — "}the card lives on your PayPal account, so we neither see nor store it.
      </p>
    </li>
  );
}
