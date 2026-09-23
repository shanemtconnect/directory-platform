import type { Metadata } from "next";
import { guardFeature } from "@/lib/features/guard";
import { features } from "@/lib/features/flags";
import { jobsBoardMetadata, renderJobsBoard } from "./board";

/**
 * /jobs — the board, page 1, unfiltered. Every other spelling is
 * app/jobs/[...segments]. Static route file on purpose: the navigation test
 * pins every advertised href to a route file on disk, and a catch-all does
 * not count.
 */
export const revalidate = 300;

const ROOT = { citySlug: null, categorySlug: null, page: 1 } as const;

export async function generateMetadata(): Promise<Metadata> {
  if (!features.jobBoard) return {};
  return jobsBoardMetadata(ROOT);
}

export default async function JobsPage() {
  guardFeature("jobBoard");
  return renderJobsBoard(ROOT);
}
