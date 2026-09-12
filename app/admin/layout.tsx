import { notFound, redirect } from "next/navigation";
import type { ReactNode } from "react";
import { currentViewer } from "@/lib/auth/viewer";

/**
 * The gate for every /admin route. Role comes from our own profiles table, never
 * from the session or anything a client can influence.
 *
 * A signed-in non-admin gets a 404, not a 403: confirming that /admin exists
 * tells an attacker where to point their effort.
 *
 * This gate covers PAGES only. Every server action the console uses re-checks
 * with `requireAdmin()` — a layout is not a security boundary for an endpoint
 * that can be called directly (global constraint 23).
 */
export default async function AdminLayout({ children }: { children: ReactNode }) {
  const viewer = await currentViewer();
  if (viewer.role === "public") redirect("/login?next=/admin");
  if (viewer.role !== "admin") notFound();
  return <>{children}</>;
}
