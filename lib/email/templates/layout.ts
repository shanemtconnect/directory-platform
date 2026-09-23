import { siteConfig } from "@/config/site.config";
import { unsubscribeUrl } from "@/lib/email/unsubscribe";
import { siteUrl } from "@/lib/schema/builders";

/**
 * The shell every notification is poured into, plus the escaping that makes
 * pouring safe.
 *
 * Plain HTML strings rather than a component library: these are four short
 * transactional emails, a render dependency would ship into the worker for no
 * benefit, and mail clients ignore most of what a component would give us.
 *
 * Not one word here is niche-specific. Everything that would change in a clone
 * comes from siteConfig, so the same shell serves whatever the directory lists.
 */

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
  /** Set where a reply should reach the person who wrote, not our mailbox. */
  replyTo?: string;
}

/**
 * Every value interpolated into an email body goes through this.
 *
 * Enquiry messages and submitter names come from a public form. Mail clients
 * render HTML, so an unescaped message body is a live injection point in a
 * document sent to a business owner's inbox.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export interface Block {
  /** Rendered as a heading above the value. Omit for a plain paragraph. */
  label?: string;
  value: string;
  /** Renders the value as a link to itself. */
  href?: string;
}

const FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

function renderBlock(block: Block): string {
  const value = escapeHtml(block.value);
  const body =
    block.href === undefined
      ? value
      : `<a href="${escapeHtml(block.href)}" style="color:${siteConfig.theme.primary}">${value}</a>`;
  if (block.label === undefined) {
    return `<p style="margin:0 0 16px;line-height:1.5">${body}</p>`;
  }
  return (
    `<p style="margin:0 0 16px;line-height:1.5">` +
    `<strong style="display:block;font-size:13px;text-transform:uppercase;letter-spacing:.04em">` +
    `${escapeHtml(block.label)}</strong>${body}</p>`
  );
}

function textBlock(block: Block): string {
  const value = block.href === undefined ? block.value : `${block.value}\n${block.href}`;
  return block.label === undefined ? value : `${block.label}: ${value}`;
}

/**
 * Wraps the blocks in a document and signs it off with the site's own name and
 * support address, so a reply always has somewhere to land.
 */
export function layout(input: { subject: string; heading: string; blocks: Block[] }): {
  html: string;
  text: string;
} {
  const home = siteUrl();
  const footerText = `${siteConfig.name} — ${home}\nReply to this email or write to ${siteConfig.supportEmail}.`;

  const html =
    `<!doctype html><html lang="${siteConfig.locale}"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width"><title>${escapeHtml(input.subject)}</title>` +
    `</head><body style="margin:0;padding:24px;background:#f6f5f3;font-family:${FONT};color:#1c1917">` +
    `<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:${siteConfig.theme.radius};padding:32px">` +
    `<h1 style="margin:0 0 24px;font-size:20px;line-height:1.3">${escapeHtml(input.heading)}</h1>` +
    input.blocks.map(renderBlock).join("") +
    `<hr style="border:0;border-top:1px solid #e7e5e4;margin:32px 0 16px">` +
    `<p style="margin:0;font-size:13px;color:#57534e;line-height:1.5">` +
    `<a href="${escapeHtml(home)}" style="color:#57534e">${escapeHtml(siteConfig.name)}</a><br>` +
    `Reply to this email or write to ` +
    `<a href="mailto:${escapeHtml(siteConfig.supportEmail)}" style="color:#57534e">` +
    `${escapeHtml(siteConfig.supportEmail)}</a>.</p>` +
    `</div></body></html>`;

  const text = [input.heading, "", ...input.blocks.map(textBlock), "", "—", footerText].join("\n");

  return { html, text };
}

/**
 * The opt-out line for an email sent to an address nobody gave us for that
 * purpose (the quote broadcast to unclaimed listings, outreach). The token
 * comes from `signUnsubscribe` in lib/email/unsubscribe.ts; the link works
 * with one click and no sign-in.
 */
export function unsubscribeBlock(token: string): Block {
  return {
    label: "Don't want these emails?",
    value: "Unsubscribe with one click",
    href: unsubscribeUrl(token),
  };
}
