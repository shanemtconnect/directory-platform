import type { Metadata } from "next";
import CatchAllPage, { generateMetadata as generateCatchAllMetadata } from "../../[...segments]/page";

/**
 * Task 53: the `verified=1` pillar view.
 *
 * `/leeds?verified=1` never actually renders this file directly — the
 * browser's URL bar and every link on the site still say `/leeds?verified=1`.
 * next.config.ts rewrites that request here (only when the first path
 * segment is not a reserved static route, via `RESERVED_SLUGS`), so this is
 * the ONLY place `verified` ever becomes true.
 *
 * Deliberately no `generateStaticParams` and no `revalidate`: exactly the
 * "fully dynamic, renders on every request" mode the sibling route's own
 * comment warns about — which is what a filtered, noindexed view is supposed
 * to be. The rendering logic itself is the sibling page's, unchanged; this
 * file only supplies the one flag that route can never read for itself.
 */
interface Props {
  params: Promise<{ segments: string[] }>;
}

export default async function VerifiedCatchAllPage(props: Props) {
  return CatchAllPage(props, { verified: true });
}

export async function generateMetadata(props: Props): Promise<Metadata> {
  return generateCatchAllMetadata(props, { verified: true });
}
