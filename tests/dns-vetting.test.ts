import { describe, expect, it } from "vitest";
import { type Resolver, vetResolvedAddress } from "@/lib/shared/url-guard";

/**
 * The DNS half of the SSRF guard.
 *
 * A hostname cannot be judged by its spelling — `evil.test` may resolve to 127.0.0.1 —
 * so the resolved addresses have to be checked, and then the socket has to go to the
 * address that was checked. The resolver is injectable so both halves are testable
 * without a name server.
 */
const resolvesTo = (...addresses: string[]): Resolver => {
  return async (_hostname) =>
    addresses.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
};

describe("resolved-address vetting", () => {
  it("accepts a hostname that resolves to a public address", async () => {
    const result = await vetResolvedAddress("example.com", resolvesTo("93.184.216.34"));
    expect(result.ok).toBe(true);
    expect(result.ok && result.hosts[0]?.address).toBe("93.184.216.34");
  });

  it("refuses a public-looking hostname that resolves to loopback", async () => {
    // The whole reason hostnames cannot be judged by spelling.
    const result = await vetResolvedAddress("totally-fine.example", resolvesTo("127.0.0.1"));
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("127.0.0.1");
  });

  it("refuses the cloud metadata address", async () => {
    const result = await vetResolvedAddress("meta.example", resolvesTo("169.254.169.254"));
    expect(result.ok).toBe(false);
  });

  it("refuses when ANY answer is private, not just the first", async () => {
    // Picking the first address would make a mixed answer a coin toss, which is
    // exactly what an attacker wants.
    const result = await vetResolvedAddress(
      "mixed.example",
      resolvesTo("93.184.216.34", "10.0.0.5"),
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("10.0.0.5");
  });

  it("refuses a private IPv6 answer", async () => {
    expect((await vetResolvedAddress("v6.example", resolvesTo("::1"))).ok).toBe(false);
    expect((await vetResolvedAddress("v6.example", resolvesTo("fd00::1"))).ok).toBe(false);
  });

  it("returns the addresses it approved, so the socket can be pinned to them", async () => {
    // The addresses checked and the address connected to must be one resolution, or
    // the guard is a suggestion.
    const result = await vetResolvedAddress("example.com", resolvesTo("93.184.216.34"));
    expect(result.ok && result.hosts).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  it("keeps every vetted address, so IPv6/IPv4 fallback still works", async () => {
    // A Cloudflare-fronted host answers with both families; dropping all but the first
    // would pin to an address this machine may not be able to route.
    const result = await vetResolvedAddress(
      "cf.example",
      resolvesTo("2606:4700:3037::6815:4ad6", "104.21.74.214"),
    );
    expect(result.ok && result.hosts).toHaveLength(2);
  });

  it("refuses a hostname that resolves to nothing", async () => {
    expect((await vetResolvedAddress("void.example", resolvesTo())).ok).toBe(false);
  });

  it("refuses when resolution fails, rather than proceeding", async () => {
    const failing: Resolver = async () => {
      throw new Error("ENOTFOUND");
    };
    const result = await vetResolvedAddress("gone.example", failing);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toContain("ENOTFOUND");
  });

  it("still refuses a literal private address without consulting DNS", async () => {
    const exploding: Resolver = async () => {
      throw new Error("DNS should not have been consulted");
    };
    expect((await vetResolvedAddress("127.0.0.1", exploding)).ok).toBe(false);
  });
});
