import "server-only";
import { chromium } from "playwright-core";

/**
 * Scrape a lander through Browserless.
 *
 * The anti-bot ladder is two rungs on one protocol. Measured against the real
 * targets, protection is user-agent filtering only: a default fetcher UA gets 403, a
 * normal desktop Chrome UA gets 200 on the identical URL. So rung 1 clears them
 * provided it sends a realistic UA — which is required anyway for density
 * reproducibility.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const NAV_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 5_000;

export type ScrapeOutcome =
  | { status: "ok"; html: string }
  | { status: "blocked" }
  | { status: "failed"; reason: string };

export async function scrape(url: string): Promise<ScrapeOutcome> {
  const base = process.env.BROWSERLESS_URL ?? "wss://production-sfo.browserless.io";
  const token = process.env.BROWSERLESS_TOKEN ?? "";

  // Both rungs speak CDP. /chromium/playwright is the Playwright-native route and a
  // connectOverCDP client cannot fall back to it.
  const rungs = [
    `${base}/chromium?token=${token}`,
    `${base}/chromium/stealth?token=${token}&proxy=residential&proxyCountry=us`,
  ];

  let lastReason = "unknown";
  for (const endpoint of rungs) {
    try {
      const html = await fetchThrough(endpoint, url);
      if (looksLikeChallenge(html)) {
        lastReason = "bot challenge";
        continue;
      }
      return { status: "ok", html };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
      if (isPermanent(lastReason)) return { status: "failed", reason: lastReason };
    }
  }
  return lastReason === "bot challenge"
    ? { status: "blocked" }
    : { status: "failed", reason: lastReason };
}

async function fetchThrough(endpoint: string, url: string): Promise<string> {
  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = await browser.newContext({
      userAgent: UA,
      // Pinned so density measurements are reproducible across scrapes.
      viewport: { width: 1366, height: 900 },
    });
    const page = await context.newPage();

    // Never networkidle: advertorial landers carry analytics beacons, pixels, chat
    // widgets and long-polling, so it either never fires or fires late and burns the
    // step budget. Playwright's own docs discourage it.
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS });
    await page.waitForSelector("h1", { timeout: SETTLE_TIMEOUT_MS }).catch(() => {});
    await autoScroll(page);
    return await page.content();
  } finally {
    // Leaked sessions count against the concurrent-session cap.
    await browser.close().catch(() => {});
  }
}

/** Fire lazy-load observers: below-fold testimonial blocks are what the brief needs. */
async function autoScroll(page: { evaluate: (fn: () => Promise<void>) => Promise<void> }) {
  await page
    .evaluate(async () => {
      await new Promise<void>((resolve) => {
        let y = 0;
        const timer = setInterval(() => {
          window.scrollBy(0, 900);
          y += 900;
          if (y >= document.body.scrollHeight) {
            clearInterval(timer);
            resolve();
          }
        }, 80);
        setTimeout(() => {
          clearInterval(timer);
          resolve();
        }, 4000);
      });
    })
    .catch(() => {});
}

function looksLikeChallenge(html: string): boolean {
  return /just a moment|cf-browser-verification|checking your browser/i.test(html);
}

function isPermanent(reason: string): boolean {
  return /ENOTFOUND|ERR_NAME_NOT_RESOLVED|404|410/i.test(reason);
}
