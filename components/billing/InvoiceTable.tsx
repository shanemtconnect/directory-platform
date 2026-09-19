import { siteConfig } from "@/config/site.config";
import type { Invoice } from "@/lib/db/queries/billing";
import { EmptyState } from "@/components/ui/EmptyState";

/**
 * Payments taken, read back out of the completed-sale events PayPal sent us.
 *
 * There is no invoices table on purpose: PayPal already holds the record, and
 * a second copy maintained by hand is a second copy that can be wrong. What is
 * shown here is exactly what PayPal told us happened.
 */
export function InvoiceTable({ invoices }: { invoices: readonly Invoice[] }) {
  if (invoices.length === 0) {
    return (
      <EmptyState title="No payments yet." testId="invoices-empty">
        <p>They appear here as soon as PayPal takes the first one.</p>
      </EmptyState>
    );
  }

  const date = new Intl.DateTimeFormat(siteConfig.locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: siteConfig.timezone,
  });

  return (
    <div className="table-scroll">
      <table data-testid="invoices" className="table-cards">
        <caption>Payments taken by PayPal</caption>
        <thead>
          <tr>
            <th scope="col">Date</th>
            <th scope="col">Amount</th>
            <th scope="col">PayPal reference</th>
          </tr>
        </thead>
        <tbody>
          {invoices.map((invoice) => (
            <tr key={invoice.id} data-testid="invoice">
              <td data-label="Date">{date.format(invoice.paidAt)}</td>
              <td data-label="Amount">
                {invoice.amount} {invoice.currency}
              </td>
              <td data-label="PayPal reference">
                <code>{invoice.id}</code>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
