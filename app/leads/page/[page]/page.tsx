import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { guardFeature } from "@/lib/features/guard";
import { leadBoardMetadata, renderLeadBoard } from "../../board";

/** /leads/page/<n> — the board's later pages. /leads/page/1 is /leads. */
export const dynamic = "force-dynamic";
export const metadata: Metadata = leadBoardMetadata;

interface Props {
  params: Promise<{ page: string }>;
  searchParams: Promise<{ buy?: string }>;
}

export default async function LeadsBoardPage({ params, searchParams }: Props) {
  guardFeature("leadMarketplace");
  const raw = (await params).page;
  if (!/^[1-9]\d{0,4}$/.test(raw)) notFound();
  const page = Number(raw);
  if (page === 1) permanentRedirect("/leads");
  const { buy } = await searchParams;
  return renderLeadBoard(page, buy);
}
