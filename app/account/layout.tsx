import { redirect } from "next/navigation";
import type { ReactNode } from "react";
import { currentViewer } from "@/lib/auth/viewer";

/**
 * The gate for every /account route.
 *
 * A layout, not middleware: middleware runs in the Edge runtime, which in this
 * standalone build cannot resolve node:crypto and 500s every matched request —
 * even a middleware that imports nothing. Server components run in Node, so
 * the session can be read and the role checked properly here.
 */
export default async function AccountLayout({ children }: { children: ReactNode }) {
  const viewer = await currentViewer();
  if (viewer.role === "public") redirect("/login?next=/account");
  return <>{children}</>;
}
