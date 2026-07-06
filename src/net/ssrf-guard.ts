import { lookup as dnsLookup } from "node:dns/promises";
import { BlockList, isIPv4, isIPv6 } from "node:net";

/**
 * SSRF guard for outbound fetches of attacker-influenceable URLs (careers pages from the public
 * directory or user-tracked companies, and any host they redirect to). It rejects URLs that target
 * private, loopback, link-local, or other non-public addresses — including hostnames that *resolve*
 * to such addresses — so a malicious directory entry can't make the scanner probe internal services
 * (e.g. 127.0.0.1, 169.254.169.254 cloud metadata, or LAN hosts).
 */

export class BlockedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedUrlError";
  }
}

// Non-public ranges. net.BlockList handles the CIDR math (and IPv4/IPv6) for us.
const blocked = new BlockList();
// IPv4
blocked.addSubnet("0.0.0.0", 8, "ipv4"); // "this" network / unspecified
blocked.addSubnet("10.0.0.0", 8, "ipv4"); // private
blocked.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
blocked.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
blocked.addSubnet("169.254.0.0", 16, "ipv4"); // link-local (incl. 169.254.169.254 metadata)
blocked.addSubnet("172.16.0.0", 12, "ipv4"); // private
blocked.addSubnet("192.168.0.0", 16, "ipv4"); // private
blocked.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
blocked.addSubnet("240.0.0.0", 4, "ipv4"); // reserved
// IPv6
blocked.addAddress("::1", "ipv6"); // loopback
blocked.addAddress("::", "ipv6"); // unspecified
blocked.addSubnet("fc00::", 7, "ipv6"); // unique-local
blocked.addSubnet("fe80::", 10, "ipv6"); // link-local
blocked.addSubnet("ff00::", 8, "ipv6"); // multicast

/** True if `ip` (an IPv4 or IPv6 literal) is a non-public address we refuse to fetch. */
export function isBlockedAddress(ip: string): boolean {
  if (isIPv4(ip)) return blocked.check(ip, "ipv4");
  if (isIPv6(ip)) {
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) tunnels an IPv4 address; check the embedded v4 too.
    const mappedV4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip)?.[1];
    if (mappedV4 && blocked.check(mappedV4, "ipv4")) return true;
    return blocked.check(ip, "ipv6");
  }
  return false;
}

export type ResolvedAddress = { address: string; family: 4 | 6 };
export type LookupAddresses = (hostname: string) => Promise<ResolvedAddress[]>;

const defaultLookup: LookupAddresses = async (hostname) => {
  const results = await dnsLookup(hostname, { all: true });
  // node's LookupAddress types `family` as `number`; narrow to the 4|6 our pin path expects.
  return results.map(({ address, family }) => ({ address, family: family === 6 ? 6 : 4 }));
};

/** The validated addresses a hostname resolved to, so the caller can pin the connection to exactly
 *  these — closing the DNS-rebinding TOCTOU where a re-resolution at connect time returns a
 *  different (internal) address than the one we checked. Empty for IP-literal URLs (nothing to pin;
 *  the literal itself was checked). */
export type AllowedUrl = {
  hostname: string;
  /** Resolved public addresses, in DNS order. Empty when the URL host is already an IP literal. */
  addresses: ResolvedAddress[];
};

/**
 * Throw `BlockedUrlError` unless `url` is an `http(s)` URL targeting a public address. A hostname is
 * resolved and rejected if *any* of its addresses is non-public (so a name pointed at 127.0.0.1
 * can't slip through). Returns the validated addresses so the caller can pin its connection to them.
 * `lookup` is injectable for tests.
 */
export async function assertAllowedUrl(
  url: string,
  lookup: LookupAddresses = defaultLookup,
): Promise<AllowedUrl> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new BlockedUrlError(`invalid URL: ${url}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new BlockedUrlError(`blocked URL protocol: ${parsed.protocol}`);
  }

  const host = parsed.hostname.replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  if (isIPv4(host) || isIPv6(host)) {
    if (isBlockedAddress(host)) throw new BlockedUrlError(`blocked address: ${host}`);
    return { hostname: host, addresses: [] };
  }

  let addresses: ResolvedAddress[];
  try {
    addresses = await lookup(host);
  } catch {
    throw new BlockedUrlError(`cannot resolve host: ${host}`);
  }
  if (addresses.length === 0) throw new BlockedUrlError(`cannot resolve host: ${host}`);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new BlockedUrlError(`host ${host} resolves to a blocked address: ${address}`);
    }
  }
  return { hostname: host, addresses };
}
