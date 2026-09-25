import { siteConfig } from "@/config/site.config";
import { REFUND_REASONS, noRefundReasons } from "@/lib/leads/market";

/**
 * The refund and no-refund policy (D10), printed on the board so a buyer
 * knows the terms before paying. The same reasons are the report form's
 * options, from the same list.
 */
export function RefundPolicy() {
  const days = siteConfig.leads.refundWindowDays;
  return (
    <section aria-labelledby="lead-refunds-heading" className="mt-10" data-testid="lead-refund-policy">
      <h2 id="lead-refunds-heading">Refunds</h2>
      <p>
        Refunds go back to your lead credit, never as cash. Report a bad lead from its page within {days} days of
        buying it and we will check it. We refund a lead when:
      </p>
      <ul>
        {REFUND_REASONS.map((r) => (
          <li key={r.value}>{r.label}.</li>
        ))}
      </ul>
      <p>We do not refund a lead when:</p>
      <ul data-testid="lead-no-refund">
        {noRefundReasons().map((text) => (
          <li key={text}>{text}</li>
        ))}
      </ul>
      <p className="text-muted text-sm">
        When we refund a lead because the number is dead, the person is the wrong one, the request is spam or they
        never asked, that phone number and email address cannot send us another lead for 12 months.
      </p>
    </section>
  );
}
