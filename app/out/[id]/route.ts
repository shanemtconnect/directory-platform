import { after } from "next/server";
import { db } from "@/lib/db/client";
import { now } from "@/lib/clock";
import { cleanTargetUrl } from "@/lib/ads/out";
import { claimDailyClick, recordSponsorStat } from "@/lib/ads/counters";
import { isBotUserAgent } from "@/lib/stats/bots";
import { clientIp } from "@/lib/spam/client-ip";
import { sponsorCampaignForClick } from "@/lib/db/queries/ads";
import { PUBLIC_VIEWER } from "@/lib/db/viewer";
import { isUuid } from "@/lib/stats/keys";
import { SPONSOR_CLICK_RATE_LIMIT, limitPublicWrite } from "@/lib/spam/write-limit";
import type { TestDb } from "@/lib/db/types";

/**
 * The link every sponsor card carries. Counts the click, then 302s to the
 * campaign's target with other platforms' click ids stripped. Unknown or
 * not-live id → 404, and the same 404 for a malformed one: a redirect that
 * distinguishes "no such row" from "not a uuid" is a probe.
 */
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function text(body: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...NO_STORE, "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}

interface Ctx {
  params: Promise<{ id: string }>;
}

export async function GET(request: Request, ctx: Ctx): Promise<Response> {
  const { id } = await ctx.params;
  if (!isUuid(id)) return text("Not found", 404);

  const limit = await limitPublicWrite("sponsor-click", request.headers, SPONSOR_CLICK_RATE_LIMIT);
  if (!limit.allowed) {
    return text("Too many requests", 429, { "Retry-After": String(limit.retryAfterSeconds) });
  }

  const campaign = await sponsorCampaignForClick(db as unknown as TestDb, PUBLIC_VIEWER, id.toLowerCase(), now());
  if (!campaign) return text("Not found", 404);
  const target = cleanTargetUrl(campaign.targetUrl);
  if (target === null) return text("Not found", 404);

  // Count once per address per campaign per day, and never a crawler, a link
  // unfurler or a mail scanner — but send every one of them on their way.
  const bot = isBotUserAgent(request.headers.get("user-agent"));
  const ip = clientIp(request.headers);
  if (!bot) {
    after(async () => {
      try {
        if (ip !== null && !(await claimDailyClick(ip, campaign.id))) return;
        await recordSponsorStat(campaign.id, "click");
      } catch {
        // A lost count is always better than a failed redirect.
      }
    });
  }

  return new Response(null, {
    status: 302,
    headers: {
      Location: target,
      ...NO_STORE,
      // The advertiser sees the referring page, not the reader's path through it.
      "Referrer-Policy": "strict-origin",
    },
  });
}
