import type { Metadata } from "next";
import { guardFeature } from "@/lib/features/guard";
import { leadBoardMetadata, renderLeadBoard } from "./board";

/**
 * /leads — the lead board, page 1 (Task 58). A static route file, which the
 * navigation test requires of every advertised href. Signed-in only.
 */
export const dynamic = "force-dynamic";
export const metadata: Metadata = leadBoardMetadata;

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ buy?: string }> }) {
  guardFeature("leadMarketplace");
  const { buy } = await searchParams;
  return renderLeadBoard(1, buy);
}
