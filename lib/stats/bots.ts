/**
 * The bot filter in front of `/api/beacon`.
 *
 * A view count an owner is asked to renew on has to mean "a person looked at
 * this". Crawlers, previewers, uptime checks and someone's scraper are not
 * that, and a directory is crawled far more than it is read — unfiltered, the
 * number would be mostly robots and the ROI argument would be a lie.
 *
 * Deliberately a substring list rather than anything clever: it is checked on
 * a request path, it must never throw, and a false negative costs one inflated
 * count while a false positive costs a real person's view. Nothing here
 * pretends to be a defence against a determined faker — it is not possible to
 * build one client-side, and the honest position is that these numbers are
 * indicative, not audited.
 */

/**
 * Beyond this a user agent is not a browser's. Capped before any scanning so a
 * multi-megabyte header cannot buy CPU on a public endpoint.
 */
const MAX_UA_LENGTH = 512;

const BOT_MARKERS = [
  // Generic — catches the long tail, which is most of it.
  "bot", "crawl", "spider", "scrap", "fetcher", "archiver", "monitor", "checker",
  "validator", "preview", "analyzer", "search engine",
  // Link previewers and social unfurlers, which do not say "bot".
  "facebookexternalhit", "slackbot", "whatsapp", "telegrambot", "discordbot",
  "embedly", "quora link preview", "pinterest", "vkshare", "skypeuripreview",
  "redditbot", "linkedinbot", "tumblr", "flipboard", "outbrain", "nuzzel",
  // HTTP clients and headless runners.
  "curl", "wget", "libwww", "httpunit", "python-requests", "python-urllib",
  "aiohttp", "go-http-client", "okhttp", "java/", "axios", "node-fetch",
  "got (https", "postman", "insomnia", "guzzle", "restsharp",
  "headlesschrome", "phantomjs", "playwright", "puppeteer", "selenium",
  "cypress", "lighthouse", "pagespeed", "gtmetrix", "pingdom", "uptimerobot",
  // Assistant and AI fetchers that identify themselves but omit "bot".
  "gptbot", "chatgpt-user", "oai-searchbot", "perplexity", "anthropic",
  "claude-web", "cohere", "bytespider", "amazonbot", "applebot",
];

export function isBotUserAgent(userAgent: string | null | undefined): boolean {
  if (typeof userAgent !== "string") return true;
  const ua = userAgent.trim();
  // Nothing that can call `navigator.sendBeacon` omits a user agent, so an
  // absent one is a script — treated as a bot rather than as a person.
  if (ua === "") return true;
  if (ua.length > MAX_UA_LENGTH) return true;

  const lower = ua.toLowerCase();
  return BOT_MARKERS.some((m) => lower.includes(m));
}
