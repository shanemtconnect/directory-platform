import { describe, expect, it } from "vitest";
import { isBotUserAgent } from "./bots";

const REAL_BROWSERS = [
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.2 Mobile/15E148 Safari/604.1",
  "Mozilla/5.0 (X11; Linux x86_64; rv:135.0) Gecko/20100101 Firefox/135.0",
];

const BOTS = [
  "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
  "Mozilla/5.0 (compatible; AhrefsBot/7.0; +http://ahrefs.com/robot/)",
  "facebookexternalhit/1.1",
  "curl/8.7.1",
  "python-requests/2.32.3",
  "Go-http-client/2.0",
  "node-fetch/1.0",
  "Mozilla/5.0 (compatible; SemrushBot/7~bl)",
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot",
  "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
  "Chrome-Lighthouse",
  "HeadlessChrome/141.0.0.0",
  "Playwright/1.63",
];

describe("isBotUserAgent", () => {
  it("lets a real browser through", () => {
    for (const ua of REAL_BROWSERS) expect(isBotUserAgent(ua), ua).toBe(false);
  });

  it("filters crawlers, scrapers, previewers and HTTP libraries", () => {
    for (const ua of BOTS) expect(isBotUserAgent(ua), ua).toBe(true);
  });

  it("treats a missing or empty user agent as a bot", () => {
    // Every browser that can run `navigator.sendBeacon` sends one. Nothing
    // legitimate reaches this endpoint without a UA.
    expect(isBotUserAgent(null)).toBe(true);
    expect(isBotUserAgent("")).toBe(true);
    expect(isBotUserAgent("   ")).toBe(true);
  });

  it("matches case-insensitively", () => {
    expect(isBotUserAgent("GOOGLEBOT/2.1")).toBe(true);
  });

  it("refuses an absurdly long user agent rather than scanning it", () => {
    expect(isBotUserAgent("Mozilla/5.0 ".repeat(400))).toBe(true);
  });
});
