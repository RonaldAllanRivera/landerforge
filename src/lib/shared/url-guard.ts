/**
 * Is this URL safe for the server to fetch?
 *
 * Scraping used to happen entirely inside Browserless, on their network. Fetching
 * directly means our own server makes a request to an address a user chose, which is a
 * server-side request forgery vector: `http://169.254.169.254/` is the cloud metadata
 * endpoint, `http://localhost:54322/` is the database, and neither is reachable from
 * the public internet that the URL field appears to describe.
 *
 * Two layers are needed and this is the first. A literal address can be rejected here,
 * but a hostname cannot — `evil.test` may resolve to 127.0.0.1 — so the resolved
 * addresses have to be checked too, which needs DNS and therefore lives server-side in
 * lib/scrape/direct. This half is pure so the range arithmetic can be tested.
 */

export type UrlVerdict = { ok: true; url: URL } | { ok: false; reason: string };

const ALLOWED_PROTOCOLS = new Set(["http:", "https:"]);

/** Hostnames that never legitimately appear in a lander URL. */
const BLOCKED_HOST_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa"];
const BLOCKED_HOSTS = new Set(["localhost", "metadata.google.internal"]);

export function parseScrapeUrl(raw: string): UrlVerdict {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: "That is not a URL." };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return { ok: false, reason: `Only http and https are supported, not ${url.protocol}` };
  }
  // Credentials in a scrape target are either a mistake or an attempt to reach
  // something that is not a public page.
  if (url.username || url.password) {
    return { ok: false, reason: "Remove the credentials from the URL." };
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTS.has(host) || BLOCKED_HOST_SUFFIXES.some((s) => host.endsWith(s))) {
    return { ok: false, reason: `${url.hostname} is not a public address.` };
  }
  if (isPrivateAddress(host)) {
    return { ok: false, reason: `${url.hostname} is not a public address.` };
  }

  return { ok: true, url };
}

/**
 * True for anything that is not a routable public address.
 *
 * Accepts a bare host string so it can be reused for DNS results, where the input is
 * already an address rather than a URL.
 */
export function isPrivateAddress(host: string): boolean {
  const v4 = parseIPv4(host);
  if (v4 !== null) return isPrivateIPv4(v4);
  if (host.includes(":")) return isPrivateIPv6(host);
  return false;
}

function parseIPv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  if (nums.some((n) => Number.isNaN(n) || n > 255)) return null;
  return nums;
}

function isPrivateIPv4(o: number[]): boolean {
  const [a = 0, b = 0, c = 0] = o;
  if (a === 0) return true; // "this network"
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && c === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast and reserved
  return false;
}

function isPrivateIPv6(host: string): boolean {
  const address = host.toLowerCase();
  if (address === "::" || address === "::1") return true;
  // An IPv4-mapped address is an IPv4 address wearing a hat.
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  if (/^f[cd][0-9a-f]{2}:/.test(address)) return true; // unique local
  if (/^fe[89ab][0-9a-f]:/.test(address)) return true; // link-local
  return false;
}

export interface ResolvedHost {
  address: string;
  family: number;
}

export type Resolver = (hostname: string) => Promise<Array<{ address: string; family: number }>>;

/**
 * Resolve a hostname and refuse it unless EVERY address is public.
 *
 * Every address, not the first: a hostname answering with one public and one private
 * address is an attack, and picking whichever came first would make the outcome a coin
 * toss.
 *
 * Returns the approved addresses so the caller can pin the socket to them. That return
 * value is the point — checking a hostname and then handing the same hostname to a
 * separate resolver leaves the two free to disagree, which is DNS rebinding.
 *
 * All of them, not just the first: a Cloudflare-fronted host answers with both IPv6 and
 * IPv4, and keeping the list lets Node fall back between families as it normally would.
 * Every one has been vetted, so the pin holds whichever it picks.
 *
 * The resolver is a parameter so this stays testable without a name server.
 */
export async function vetResolvedAddress(
  hostname: string,
  resolver: Resolver,
): Promise<{ ok: true; hosts: ResolvedHost[] } | { ok: false; reason: string }> {
  if (isPrivateAddress(hostname)) {
    return { ok: false, reason: `${hostname} is not a public address.` };
  }

  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await resolver(hostname);
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  if (addresses.length === 0) return { ok: false, reason: `${hostname} resolves to nothing.` };

  for (const entry of addresses) {
    if (isPrivateAddress(entry.address)) {
      return {
        ok: false,
        reason: `${hostname} resolves to ${entry.address}, which is not a public address.`,
      };
    }
  }
  return { ok: true, hosts: addresses };
}
