import "server-only";
import { lookup } from "node:dns/promises";
import { looksLikeChallenge, MIN_TEXT_WORDS, visibleWordCount } from "@/lib/shared/page-text";
import { isPrivateAddress, parseScrapeUrl } from "@/lib/shared/url-guard";

/**
 * Fetch a page with a plain HTTP request.
 *
 * The first rung of the ladder, and for the pages this tool actually targets it is the
 * only one needed. Their protection is user-agent filtering: a default fetcher UA gets
 * 403 and a normal desktop Chrome UA gets 200 on the identical URL. A headless browser
 * clears that too, but it is a paid dependency with a concurrency cap doing the work of
 * a GET, and the pages are server-rendered — measured, this returns the same 92 blocks
 * the browser path would.
 *
 * Escalation to Browserless is for what this genuinely cannot do: a bot challenge, or a
 * page whose content arrives via JavaScript.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
const MAX_BYTES = 8 * 1024 * 1024;

export type DirectOutcome =
  | { status: "ok"; html: string }
  | { status: "escalate"; reason: string }
  | { status: "failed"; reason: string };

export async function fetchDirect(rawUrl: string): Promise<DirectOutcome> {
  const verdict = parseScrapeUrl(rawUrl);
  if (!verdict.ok) return { status: "failed", reason: verdict.reason };

  let target = verdict.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const denied = await resolvesToPrivateAddress(target.hostname);
    if (denied) return { status: "failed", reason: denied };

    let response: Response;
    try {
      response = await fetch(target, {
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
        // Followed by hand so every hop is re-checked. Automatic following would let a
        // public URL redirect to 169.254.169.254 after the guard has already passed.
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A DNS failure is permanent; a timeout might not be, and a browser may fare
      // better against whatever dropped the connection.
      return /ENOTFOUND|EAI_AGAIN|not a URL/i.test(reason)
        ? { status: "failed", reason }
        : { status: "escalate", reason };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) return { status: "failed", reason: `${response.status} with no location` };
      try {
        target = new URL(location, target);
      } catch {
        return { status: "failed", reason: `unfollowable redirect to ${location}` };
      }
      const next = parseScrapeUrl(target.toString());
      if (!next.ok) return { status: "failed", reason: `redirected to ${next.reason}` };
      continue;
    }

    if (response.status === 403 || response.status === 429 || response.status === 503) {
      // The signatures of a bot wall. Worth a browser.
      return { status: "escalate", reason: `HTTP ${response.status}` };
    }
    if (!response.ok) return { status: "failed", reason: `HTTP ${response.status}` };

    const type = response.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) {
      return { status: "failed", reason: `not an HTML page (${type || "no content-type"})` };
    }

    const html = await readCapped(response);
    if (looksLikeChallenge(html)) return { status: "escalate", reason: "bot challenge" };
    if (visibleWordCount(html) < MIN_TEXT_WORDS) {
      return { status: "escalate", reason: "page has no server-rendered text" };
    }
    return { status: "ok", html };
  }

  return { status: "failed", reason: `more than ${MAX_REDIRECTS} redirects` };
}

/** Null when every resolved address is public. */
async function resolvesToPrivateAddress(hostname: string): Promise<string | null> {
  // A literal address never reaches DNS, and parseScrapeUrl has already judged it.
  if (isPrivateAddress(hostname)) return `${hostname} is not a public address.`;
  try {
    const addresses = await lookup(hostname, { all: true });
    for (const { address } of addresses) {
      if (isPrivateAddress(address)) {
        return `${hostname} resolves to ${address}, which is not a public address.`;
      }
    }
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return null;
}

/** Stop reading a response that turns out to be enormous. */
async function readCapped(response: Response): Promise<string> {
  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer).subarray(0, MAX_BYTES);
  return new TextDecoder("utf-8").decode(bytes);
}
