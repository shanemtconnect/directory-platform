import { encodeTerritory } from "@/lib/leads/market";
import { formatCredit } from "@/lib/credits/format";
import type { Territory } from "@/lib/db/schema/lead-market";
import type { TerritoryOptions } from "@/lib/db/queries/lead-market";

/**
 * The places, categories and price of a standing order — the same fields
 * for a new order and for editing one. Plain `<select multiple>`s, so the
 * form works with no JavaScript.
 */
export function StandingOrderFields({
  idPrefix, options, floorCents, territories = [], categoryIds = null, priceCents,
}: {
  idPrefix: string;
  options: TerritoryOptions;
  floorCents: number;
  territories?: readonly Territory[];
  categoryIds?: readonly string[] | null;
  priceCents?: number;
}) {
  const chosen = territories.map(encodeTerritory);
  const price = ((priceCents ?? floorCents) / 100).toFixed(2).replace(/\.00$/, "");
  return (
    <>
      <p className="mb-3">
        <label htmlFor={`${idPrefix}-territories`} className="block font-semibold">
          Where
        </label>
        <select
          id={`${idPrefix}-territories`}
          name="territories"
          multiple
          required
          size={8}
          defaultValue={chosen}
          aria-describedby={`${idPrefix}-territories-hint`}
          className="w-full"
          data-testid="order-territories"
        >
          <option value="national">Everywhere</option>
          {options.regions.length > 0 && (
            <optgroup label="Regions">
              {options.regions.map((r) => (
                <option key={r.slug} value={encodeTerritory({ kind: "region", id: r.slug })}>
                  {r.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Towns">
            {options.cities.map((c) => (
              <option key={c.id} value={encodeTerritory({ kind: "city", id: c.id })}>
                {c.region ? `${c.name}, ${c.region}` : c.name}
              </option>
            ))}
          </optgroup>
        </select>
        <span id={`${idPrefix}-territories-hint`} className="text-muted text-sm">
          Hold Ctrl or Cmd to choose more than one.
        </span>
      </p>
      <p className="mb-3">
        <label htmlFor={`${idPrefix}-categories`} className="block font-semibold">
          Categories
        </label>
        <select
          id={`${idPrefix}-categories`}
          name="categories"
          multiple
          size={6}
          defaultValue={categoryIds ?? []}
          aria-describedby={`${idPrefix}-categories-hint`}
          className="w-full"
          data-testid="order-categories"
        >
          {options.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <span id={`${idPrefix}-categories-hint`} className="text-muted text-sm">
          Choose none to buy leads in every category.
        </span>
      </p>
      <p className="mb-3">
        <label htmlFor={`${idPrefix}-price`} className="block font-semibold">
          Price per lead
        </label>
        <input
          id={`${idPrefix}-price`}
          name="price"
          type="text"
          inputMode="decimal"
          required
          defaultValue={price}
          pattern="[0-9]{1,6}([.][0-9]{1,2})?"
          aria-describedby={`${idPrefix}-price-hint`}
          className="w-32"
          data-testid="order-price"
        />{" "}
        <span id={`${idPrefix}-price-hint`} className="text-muted text-sm">
          At least {formatCredit(floorCents)} (the floor). When several orders want the same lead, the highest price
          gets it.
        </span>
      </p>
    </>
  );
}
