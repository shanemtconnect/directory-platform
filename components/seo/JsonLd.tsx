import { serialiseJsonLd, type JsonLd as JsonLdNode } from "@/lib/schema/types";

/**
 * One script tag per type, server-rendered. `serialiseJsonLd` escapes `<` so
 * listing content cannot close the script tag and inject markup.
 */
export function JsonLd({ data }: { data: JsonLdNode | null }) {
  if (!data) return null;
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: serialiseJsonLd(data) }}
    />
  );
}
