import { siteConfig } from "@/config/site.config";

/**
 * A rating, rendered as text first and stars second.
 *
 * The visible string is "4.3 out of 5" — a screen reader, a text-only client
 * and a person who cannot tell four filled shapes from five all get the number
 * itself. The stars are decorative and marked as such, so they are never read
 * out as a row of punctuation.
 */
export function Stars({ value, size = "normal" }: { value: number; size?: "normal" | "small" }) {
  const rounded = Math.round(value * 10) / 10;
  const filled = Math.round(value);

  return (
    <span className={size === "small" ? "text-sm" : undefined}>
      <span aria-hidden="true" className="tracking-widest">
        {"★".repeat(Math.min(5, Math.max(0, filled)))}
        {"☆".repeat(Math.max(0, 5 - filled))}
      </span>{" "}
      <span>{rounded.toLocaleString(siteConfig.locale)} out of 5</span>
    </span>
  );
}
