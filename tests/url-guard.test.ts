import { describe, expect, it } from "vitest";
import { isPrivateAddress, parseScrapeUrl } from "@/lib/shared/url-guard";

/**
 * Scraping moved from Browserless's network onto our own server, which turns the URL
 * field into a server-side request forgery surface. Every case here is an address that
 * looks like an ordinary URL and is not.
 */
describe("scrape URL guard", () => {
  it("accepts an ordinary public page", () => {
    const verdict = parseScrapeUrl("https://buybarkcontrol.com/trending/some-lander");
    expect(verdict.ok).toBe(true);
  });

  it("rejects the cloud metadata endpoint", () => {
    // The single most valuable target of an SSRF: instance credentials.
    expect(parseScrapeUrl("http://169.254.169.254/latest/meta-data/").ok).toBe(false);
  });

  it("rejects loopback in every spelling", () => {
    for (const target of [
      "http://localhost:3000/",
      "http://127.0.0.1:54322/",
      "http://127.1.1.1/",
      "http://[::1]/",
      "http://app.localhost/",
    ]) {
      expect(parseScrapeUrl(target).ok, target).toBe(false);
    }
  });

  it("rejects the private ranges", () => {
    for (const target of [
      "http://10.0.0.5/",
      "http://172.16.0.1/",
      "http://172.31.255.254/",
      "http://192.168.1.1/",
      "http://100.64.0.1/",
      "http://[fd00::1]/",
      "http://[fe80::1]/",
    ]) {
      expect(parseScrapeUrl(target).ok, target).toBe(false);
    }
  });

  it("does not mistake a public address inside a private-looking range for private", () => {
    expect(parseScrapeUrl("http://172.32.0.1/").ok).toBe(true);
    expect(parseScrapeUrl("http://11.0.0.1/").ok).toBe(true);
  });

  it("sees through an IPv4-mapped IPv6 address", () => {
    expect(isPrivateAddress("::ffff:127.0.0.1")).toBe(true);
    expect(isPrivateAddress("::ffff:8.8.8.8")).toBe(false);
  });

  it("rejects a non-HTTP protocol", () => {
    expect(parseScrapeUrl("file:///etc/passwd").ok).toBe(false);
    expect(parseScrapeUrl("gopher://example.com/").ok).toBe(false);
  });

  it("rejects credentials in the URL", () => {
    expect(parseScrapeUrl("https://user:pass@example.com/").ok).toBe(false);
  });

  it("rejects text that is not a URL at all", () => {
    expect(parseScrapeUrl("not a url").ok).toBe(false);
    expect(parseScrapeUrl("").ok).toBe(false);
  });

  it("tolerates surrounding whitespace, which is how a paste arrives", () => {
    expect(parseScrapeUrl("  https://example.com/page  ").ok).toBe(true);
  });
});
