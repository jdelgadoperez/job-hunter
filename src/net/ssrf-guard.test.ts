import { describe, expect, it } from "vitest";
import { assertAllowedUrl, BlockedUrlError, isBlockedAddress } from "./ssrf-guard";

describe("isBlockedAddress", () => {
  it("blocks loopback, private, link-local, and reserved IPv4", () => {
    for (const ip of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud metadata
      "100.64.0.1", // CGNAT
      "0.0.0.0",
      "224.0.0.1", // multicast
    ]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it("allows public IPv4", () => {
    for (const ip of ["8.8.8.8", "1.1.1.1", "93.184.216.34", "172.32.0.1", "11.0.0.1"]) {
      expect(isBlockedAddress(ip)).toBe(false);
    }
  });

  it("blocks loopback/link-local/unique-local IPv6 and IPv4-mapped internal", () => {
    for (const ip of ["::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "::ffff:127.0.0.1"]) {
      expect(isBlockedAddress(ip)).toBe(true);
    }
  });

  it("allows public IPv6", () => {
    expect(isBlockedAddress("2606:4700:4700::1111")).toBe(false);
    expect(isBlockedAddress("2001:4860:4860::8888")).toBe(false);
  });

  it("treats non-IP strings as not-an-address (handled by URL resolution instead)", () => {
    expect(isBlockedAddress("example.com")).toBe(false);
  });
});

describe("assertAllowedUrl", () => {
  const lookupTo =
    (...addresses: string[]) =>
    async () =>
      addresses.map((address) => ({ address, family: 4 as const }));

  it("rejects non-http(s) protocols", async () => {
    for (const url of ["ftp://example.com", "file:///etc/passwd", "gopher://x"]) {
      await expect(assertAllowedUrl(url, lookupTo("1.1.1.1"))).rejects.toBeInstanceOf(
        BlockedUrlError,
      );
    }
  });

  it("rejects an invalid URL", async () => {
    await expect(assertAllowedUrl("not a url")).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("rejects internal IP-literal hosts without a DNS lookup", async () => {
    const fail = () => {
      throw new Error("lookup should not run for an IP literal");
    };
    await expect(assertAllowedUrl("http://127.0.0.1/x", fail)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(assertAllowedUrl("http://[::1]:8080/x", fail)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(
      assertAllowedUrl("http://169.254.169.254/latest/meta-data", fail),
    ).rejects.toThrow();
  });

  it("allows public IP-literal hosts and reports no addresses to pin", async () => {
    // An IP literal is checked directly (no DNS), so there is nothing to pin against rebinding.
    await expect(assertAllowedUrl("https://1.1.1.1/x", lookupTo())).resolves.toEqual({
      hostname: "1.1.1.1",
      addresses: [],
    });
  });

  it("allows a hostname that resolves to a public address and returns the validated addresses", async () => {
    // The returned addresses let the fetcher pin its connection to exactly what was validated.
    await expect(
      assertAllowedUrl("https://example.com/jobs", lookupTo("93.184.216.34")),
    ).resolves.toEqual({
      hostname: "example.com",
      addresses: [{ address: "93.184.216.34", family: 4 }],
    });
  });

  it("rejects a hostname that resolves to an internal address (DNS-based bypass)", async () => {
    await expect(
      assertAllowedUrl("https://evil.example.com", lookupTo("127.0.0.1")),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("rejects when ANY resolved address is internal", async () => {
    await expect(
      assertAllowedUrl("https://rebind.example.com", lookupTo("93.184.216.34", "10.0.0.5")),
    ).rejects.toBeInstanceOf(BlockedUrlError);
  });

  it("rejects when the host cannot be resolved", async () => {
    const throwingLookup = async () => {
      throw new Error("ENOTFOUND");
    };
    await expect(assertAllowedUrl("https://nope.invalid", throwingLookup)).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
    await expect(assertAllowedUrl("https://empty.example.com", lookupTo())).rejects.toBeInstanceOf(
      BlockedUrlError,
    );
  });
});
