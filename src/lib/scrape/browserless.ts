import "server-only";
import { chromium } from "playwright-core";
import { looksLikeChallenge } from "@/lib/shared/page-text";
import { fetchDirect } from "./direct";

/**
 * Scrape a lander, cheapest rung first.
 *
 *   1. a plain HTTP GET with a realistic user agent
 *   2. Browserless
 *   3. Browserless with stealth and a residential proxy
 *
 * Measured against the real targets, protection is user-agent filtering only: a default
 * fetcher UA gets 403 and a normal desktop Chrome UA gets 200 on the identical URL. The
 * pages are server-rendered, so rung 1 returns the same blocks a browser would — this
 * used to start at rung 2, which meant a paid dependency with a concurrency cap doing
 * the work of a GET, and the whole URL path was unavailable without a Browserless token.
 *
 * Rungs 2 and 3 remain for what a GET genuinely cannot do: a bot challenge, or content
 * that only exists after JavaScript runs.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const NAV_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 5_000;

export type ScrapeVia = "fetch" | "browser" | "browser_stealth";

export type ScrapeOutcome =
  | { status: "ok"; html: string; via: ScrapeVia }
  | { status: "blocked"; reason: string }
  | { status: "failed"; reason: string };

export async function scrape(url: string): Promise<ScrapeOutcome> {
  const direct = await fetchDirect(url);
  if (direct.status === "ok") return { status: "ok", html: direct.html, via: "fetch" };
  // A bad URL, a private address or a 404 is not something a browser fixes.
  if (direct.status === "failed") return { status: "failed", reason: direct.reason };

  const token = process.env.BROWSERLESS_TOKEN ?? "";
  if (!token) {
    /**
     * Blocked rather than failed, and that distinction matters: the run continues
     * source-less with a note, and the paste fallback is offered. Reported honestly,
     * because "no token" and "the site refused us" need different responses.
     */
    return {
      status: "blocked",
      reason: `${direct.reason} — and no BROWSERLESS_TOKEN is set, so a browser could not be tried`,
    };
  }

  const base = process.env.BROWSERLESS_URL ?? "wss://production-sfo.browserless.io";
  // Both rungs speak CDP. /chromium/playwright is the Playwright-native route and a
  // connectOverCDP client cannot fall back to it.
  const rungs: Array<{ endpoint: string; via: ScrapeVia }> = [
    { endpoint: `${base}/chromium?token=${token}`, via: "browser" },
    {
      endpoint: `${base}/chromium/stealth?token=${token}&proxy=residential&proxyCountry=us`,
      via: "browser_stealth",
    },
  ];

  let lastReason = direct.reason;
  for (const rung of rungs) {
    try {
      const html = await fetchThrough(rung.endpoint, url);
      if (looksLikeChallenge(html)) {
        lastReason = "bot challenge";
        continue;
      }
      return { status: "ok", html, via: rung.via };
    } catch (error) {
      lastReason = error instanceof Error ? error.message : String(error);
      if (isPermanent(lastReason)) return { status: "failed", reason: lastReason };
    }
  }
  return lastReason === "bot challenge"
    ? { status: "blocked", reason: lastReason }
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

function isPermanent(reason: string): boolean {
  return /ENOTFOUND|ERR_NAME_NOT_RESOLVED|404|410/i.test(reason);
}
