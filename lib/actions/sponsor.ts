"use server";

import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db/client";
import { currentViewer } from "@/lib/auth/viewer";
import { ensureProfile } from "@/lib/auth/profile";
import { clientIp } from "@/lib/spam/client-ip";
import { SPONSOR_SUBMIT_RATE_LIMIT, limitPublicWrite, retryMessage } from "@/lib/spam/write-limit";
import { getPayPalClient } from "@/lib/billing/paypal";
import { startSponsorCheckout } from "@/lib/ads/billing";
import { LOGO_MAX_BYTES, processSponsorLogo, sponsorLogosConfigured, storeSponsorLogo } from "@/lib/ads/logo";
import {
  createSponsorCampaign,
  setSponsorLogo,
  updateSponsorCampaign,
  type SponsorField,
} from "@/lib/db/queries/ads";
import { notifySponsorSubmitted } from "@/lib/email/notify";
import { isUuid } from "@/lib/actions/validation";
import type { TestDb } from "@/lib/db/types";

const SPONSOR_PAGE = "/advertise/sponsor";

export interface SponsorFormState {
  status: "idle" | "submitted" | "error";
  message?: string;
  field?: SponsorField | "logo";
}

const GENERIC = "Something went wrong saving your campaign. Please try again.";

const FIELD_MESSAGES: Record<SponsorField | "logo", string> = {
  name: "Tell us the business name (up to 80 characters).",
  title: "The headline is required and must be 60 characters or fewer.",
  blurb: "The blurb is required and must be 120 characters or fewer.",
  targetUrl: "The link must be a full web address starting with https://.",
  placements: "Pick at least one place for the campaign to show.",
  logo: "The logo must be a JPEG, PNG or WebP under 2 MB.",
};

function str(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

async function readLogo(form: FormData): Promise<Buffer | null | "invalid"> {
  const file = form.get("logo");
  if (!(file instanceof File) || file.size === 0) return null;
  if (file.size > LOGO_MAX_BYTES) return "invalid";
  try {
    return await processSponsorLogo(Buffer.from(await file.arrayBuffer()));
  } catch {
    return "invalid";
  }
}

export async function createSponsorCampaignAction(
  _prev: SponsorFormState,
  form: FormData,
): Promise<SponsorFormState> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { status: "error", message: "Please sign in to sponsor." };

  const requestHeaders = await headers();
  const limit = await limitPublicWrite("sponsor-submit", requestHeaders, SPONSOR_SUBMIT_RATE_LIMIT);
  if (!limit.allowed) return { status: "error", message: retryMessage(limit) };

  const logo = await readLogo(form);
  if (logo === "invalid") return { status: "error", field: "logo", message: FIELD_MESSAGES.logo };

  const profile = await ensureProfile(db, viewer);
  const ip = clientIp(requestHeaders);
  const input = {
    profileId: profile.id,
    name: str(form, "name"),
    title: str(form, "title"),
    blurb: str(form, "blurb"),
    targetUrl: str(form, "targetUrl"),
    placements: form.getAll("placements").filter((p): p is string => typeof p === "string"),
    logoPath: null,
    ip,
  };

  let campaignId: string;
  try {
    const created = await db.transaction(async (tx) => {
      const handle = tx as unknown as TestDb;
      const result = await createSponsorCampaign(handle, viewer, input);
      if (result.outcome === "created") await notifySponsorSubmitted(handle, viewer, result.campaignId);
      return result;
    });
    if (created.outcome === "invalid") {
      return { status: "error", field: created.field, message: FIELD_MESSAGES[created.field] };
    }
    campaignId = created.campaignId;
  } catch (e) {
    console.error("[ads] sponsor submit failed:", e);
    return { status: "error", message: GENERIC };
  }

  if (logo !== null && sponsorLogosConfigured()) {
    try {
      const key = await storeSponsorLogo(campaignId, logo);
      if (key !== null) {
        await setSponsorLogo(db as unknown as TestDb, viewer, { campaignId, profileId: profile.id, logoPath: key });
      }
    } catch (e) {
      // The campaign stands; the card shows the initial until a logo is stored.
      console.error("[ads] sponsor logo not stored:", e);
    }
  }

  revalidatePath(SPONSOR_PAGE);

  const client = getPayPalClient();
  let approveUrl: string | null = null;
  try {
    const checkout = await db.transaction(async (tx) =>
      startSponsorCheckout(tx as unknown as TestDb, {
        client,
        viewer,
        profileId: profile.id,
        campaignId,
      }),
    );
    if (checkout.outcome === "approval") approveUrl = checkout.approveUrl;
  } catch (e) {
    console.error("[ads] sponsor checkout failed:", e);
  }
  if (approveUrl !== null) redirect(approveUrl);
  return { status: "submitted" };
}

export async function updateSponsorCampaignAction(
  _prev: SponsorFormState,
  form: FormData,
): Promise<SponsorFormState> {
  const viewer = await currentViewer();
  if (viewer.role === "public") return { status: "error", message: "Please sign in." };
  const campaignId = str(form, "campaignId");
  if (!isUuid(campaignId)) return { status: "error", message: GENERIC };
  const requestHeaders = await headers();
  const profile = await ensureProfile(db, viewer);
  const outcome = await db.transaction(async (tx) =>
    updateSponsorCampaign(tx as unknown as TestDb, viewer, {
      campaignId,
      profileId: profile.id,
      title: str(form, "title"),
      blurb: str(form, "blurb"),
      targetUrl: str(form, "targetUrl"),
      ip: clientIp(requestHeaders),
    }),
  );
  switch (outcome) {
    case "unknown":
      return { status: "error", message: "That campaign is not yours to edit, or it has finished." };
    case "invalid":
      return { status: "error", message: "Check the headline (≤ 60), blurb (≤ 120) and the link (https://…)." };
    case "updated":
      revalidatePath(SPONSOR_PAGE);
      return { status: "submitted", message: "Saved. It goes back on the rails once an admin has looked at the change." };
  }
}
