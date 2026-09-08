import type { TierName, TierSpec } from "@/config/types";
import { comparisonRows, orderedTiers } from "@/lib/pricing";

/**
 * The rows come from the keys of TierSpec itself, so this table cannot drift
 * out of step with what the code actually enforces — the usual failure mode of
 * a hand-maintained pricing grid.
 */
export function ComparisonTable({
  tiers,
  caption,
}: {
  tiers: { readonly [K in TierName]: TierSpec };
  caption: string;
}) {
  const columns = orderedTiers(tiers);
  const rows = comparisonRows(tiers);
  if (rows.length === 0) return null;

  return (
    <table data-testid="comparison-table">
      <caption>{caption}</caption>
      <thead>
        <tr>
          <th scope="col">Feature</th>
          {columns.map(([name, spec]) => (
            <th scope="col" key={name} data-tier={name}>
              {spec.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={row.key} data-key={row.key}>
            <th scope="row">{row.label}</th>
            {row.cells.map(({ tier, cell }) => (
              <td key={tier} data-tier={tier}>
                {cell.kind === "bool" ? (
                  <>
                    <span aria-hidden="true">{cell.value ? "✓" : "—"}</span>
                    <span className="sr-only">{cell.value ? "Included" : "Not included"}</span>
                  </>
                ) : (
                  cell.text
                )}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
