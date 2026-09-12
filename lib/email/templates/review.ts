import { siteConfig } from "@/config/site.config";
import { layout, type Block, type EmailContent } from "./layout";
import { REVIEW_TOKEN_TTL_DAYS } from "@/lib/db/queries/reviews";

/**
 * The three review notifications.
 *
 * None of them sets `replyTo`. On the enquiry emails a reply should reach the
 * person who wrote, because an enquiry is a conversation; a review is not, and
 * the reviewer's address is the one thing this module promises never to hand
 * to the business being reviewed.
 */

export interface ReviewEmailData {
  listingName: string;
  /** Absolute URL of the public listing page. */
  listingUrl: string;
  /** Absolute URL of the listing's reviews page. */
  reviewsUrl: string;
  /** Absolute URL of the single-use verification link. */
  verifyUrl: string;
  author: string;
  rating: number;
  title: string | null;
  body: string | null;
  /** Why the review was held, or null if it published itself. */
  flaggedReason: string | null;
}

/**
 * Stated in the copy because a link that stops working without warning reads
 * as a broken site rather than as a deadline. One source: the query layer that
 * enforces it.
 */
const REVIEW_LINK_DAYS = REVIEW_TOKEN_TTL_DAYS;

function stars(rating: number): string {
  return `${rating} out of 5`;
}

function reviewBlocks(data: ReviewEmailData): Block[] {
  const blocks: Block[] = [
    { label: siteConfig.entity.Singular, value: data.listingName, href: data.listingUrl },
    { label: "Rating", value: stars(data.rating) },
  ];
  if (data.title !== null && data.title.trim() !== "") {
    blocks.push({ label: "Title", value: data.title });
  }
  if (data.body !== null && data.body.trim() !== "") {
    blocks.push({ label: "Review", value: data.body });
  }
  return blocks;
}

/**
 * The only email that matters to the module working: without the click the
 * review is never published and never counts towards a rating.
 */
export function reviewVerification(data: ReviewEmailData): EmailContent {
  const subject = `Confirm your review of ${data.listingName}`;
  return {
    subject,
    ...layout({
      subject,
      heading: "Confirm your review",
      blocks: [
        { value: `Thanks for writing about ${data.listingName}. We ask everyone to confirm their email address so that every review on ${siteConfig.name} comes from a real person.` },
        { label: "Confirm your review", value: "Open this link and press Confirm", href: data.verifyUrl },
        {
          value:
            `The link works once and lasts ${REVIEW_LINK_DAYS} days. Opening it only shows ` +
            "you what you wrote — nothing is published until you press Confirm.",
        },
        ...reviewBlocks(data),
        {
          value:
            "If you did not write this, ignore this email. Nothing goes on the site unless " +
            "somebody opens the link and confirms.",
        },
      ],
    }),
  };
}

/** Our own record, and the queue for anything the heuristics held. */
export function reviewToAdmin(data: ReviewEmailData): EmailContent {
  const held = data.flaggedReason !== null;
  const subject = held
    ? `Review held for moderation: ${data.listingName}`
    : `Review published: ${data.listingName}`;

  const blocks: Block[] = [
    {
      value: held
        ? `A confirmed review is waiting for a decision. It was held because of: ${data.flaggedReason}.`
        : "A confirmed review passed the automatic checks and is published.",
    },
    { label: "Written by", value: data.author },
    ...reviewBlocks(data),
    { label: "Reviews", value: "Open the reviews page", href: data.reviewsUrl },
  ];

  return { subject, ...layout({ subject, heading: subject, blocks }) };
}

/** Sent only once a review is actually on the page, and only to a claimed listing. */
export function reviewToOwner(data: ReviewEmailData): EmailContent {
  const subject = `New review of ${data.listingName}`;
  return {
    subject,
    ...layout({
      subject,
      heading: "You have a new review",
      blocks: [
        ...reviewBlocks(data),
        { label: "Written by", value: data.author },
        {
          value: "You can reply once to any review, and your reply appears underneath it.",
        },
        { label: "Reply", value: "Open your reviews page", href: data.reviewsUrl },
      ],
    }),
  };
}
