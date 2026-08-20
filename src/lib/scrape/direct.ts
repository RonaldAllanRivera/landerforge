import "server-only";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";
import { looksLikeChallenge, MIN_TEXT_WORDS, visibleWordCount } from "@/lib/shared/page-text";
import {
  parseScrapeUrl,
  type ResolvedHost,
  type Resolver,
  vetResolvedAddress,
} from "@/lib/shared/url-guard";

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

/** The only impure part of the guard: the actual name server. */
const systemResolver: Resolver = (hostname) => lookup(hostname, { all: true });

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
    const vetted = await vetResolvedAddress(target.hostname, systemResolver);
    if (!vetted.ok) return { status: "failed", reason: vetted.reason };

    let response: RawResponse;
    try {
      response = await get(target, vetted.hosts);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // A DNS failure is permanent; a timeout might not be, and a browser may fare
      // better against whatever dropped the connection.
      return /ENOTFOUND|EAI_AGAIN/i.test(reason)
        ? { status: "failed", reason }
        : { status: "escalate", reason };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.location;
      if (!location) return { status: "failed", reason: `${response.status} with no location` };
      let next: URL;
      try {
        next = new URL(location, target);
      } catch {
        return { status: "failed", reason: `unfollowable redirect to ${location}` };
      }
      const allowed = parseScrapeUrl(next.toString());
      if (!allowed.ok) return { status: "failed", reason: `redirected to ${allowed.reason}` };
      target = next;
      continue;
    }

    if (response.status === 403 || response.status === 429 || response.status === 503) {
      // The signatures of a bot wall. Worth a browser.
      return { status: "escalate", reason: `HTTP ${response.status}` };
    }
    if (response.status < 200 || response.status >= 300) {
      return { status: "failed", reason: `HTTP ${response.status}` };
    }

    const type = response.headers["content-type"] ?? "";
    if (!/text\/html|application\/xhtml/i.test(type)) {
      return { status: "failed", reason: `not an HTML page (${type || "no content-type"})` };
    }

    const html = response.body;
    if (looksLikeChallenge(html)) return { status: "escalate", reason: "bot challenge" };
    if (visibleWordCount(html) < MIN_TEXT_WORDS) {
      return { status: "escalate", reason: "page has no server-rendered text" };
    }
    return { status: "ok", html };
  }

  return { status: "failed", reason: `more than ${MAX_REDIRECTS} redirects` };
}

interface RawResponse {
  status: number;
  headers: Record<string, string | undefined>;
  body: string;
}

/**
 * GET, pinned to an address that has already been vetted.
 *
 * `fetch` cannot express this. It resolves the hostname itself, which means the address
 * checked and the address connected to are two separate resolutions — and a name server
 * an attacker controls can answer the first with a public address and the second with
 * 169.254.169.254. That is DNS rebinding, and a guard that resolves and then hands the
 * hostname to a separate resolver does not prevent it.
 *
 * The `lookup` hook makes both stages the same resolution. The URL still carries the
 * hostname, so TLS SNI and certificate validation are unaffected — this pins where the
 * socket goes without weakening who it must prove itself to be.
 */
function get(url: URL, hosts: readonly ResolvedHost[]): Promise<RawResponse> {
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = send(
      url,
      {
        method: "GET",
        headers: {
          "user-agent": UA,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
          "accept-encoding": "gzip, deflate, br",
          host: url.host,
        },
        timeout: TIMEOUT_MS,
        /**
         * Deliberately ignores the hostname: the answer was decided above. `net` calls
         * this with `all: true` and then expects an ARRAY back — returning the
         * three-argument form instead fails with "Invalid IP address: undefined",
         * which is a confusing way to learn the contract.
         */
        lookup: (_hostname, options, callback) => {
          const answers = hosts.map((h) => ({ address: h.address, family: h.family }));
          if (options.all) {
            (callback as unknown as (e: null, a: typeof answers) => void)(null, answers);
            return;
          }
          const first = answers[0] as ResolvedHost;
          (callback as (e: null, a: string, f: number) => void)(null, first.address, first.family);
        },
      },
      (res) => {
        const encoding = (res.headers["content-encoding"] ?? "").toLowerCase();
        const stream =
          encoding === "gzip"
            ? res.pipe(createGunzip())
            : encoding === "deflate"
              ? res.pipe(createInflate())
              : encoding === "br"
                ? res.pipe(createBrotliDecompress())
                : res;

        const chunks: Buffer[] = [];
        let size = 0;
        stream.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_BYTES) {
            // Stop reading a response that turns out to be enormous.
            req.destroy();
            return;
          }
          chunks.push(chunk);
        });
        stream.on("error", reject);
        stream.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | undefined>,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );

    req.on("timeout", () => req.destroy(new Error(`timed out after ${TIMEOUT_MS}ms`)));
    req.on("error", reject);
    req.end();
  });
}
