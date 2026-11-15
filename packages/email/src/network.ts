import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SendError } from "./adapter";
import type { SmtpConfig } from "./smtp";

function ipv4NonPublic([a, b, c]: number[]): boolean {
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b! >= 64 && b! <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b! >= 16 && b! <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a! >= 224
  );
}

/** Dotted-quad → 4 bytes (strict: four decimal parts 0–255, no leading zeros), else null. */
function parseIPv4(address: string): number[] | null {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const bytes: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    bytes.push(n);
  }
  return bytes;
}

/**
 * Any textual IPv6 form (compressed, uncompressed, mixed with a dotted IPv4 tail, upper case,
 * leading zeros, with a %zone) → 16 bytes, else null.
 */
export function parseIPv6(input: string): number[] | null {
  let address = input.trim().toLowerCase();
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  const zone = address.indexOf("%");
  if (zone >= 0) address = address.slice(0, zone);
  if (!/^[0-9a-f:.]+$/.test(address)) return null;

  let tail: number[] = [];
  const lastColon = address.lastIndexOf(":");
  if (address.includes(".")) {
    const v4 = parseIPv4(address.slice(lastColon + 1));
    if (!v4 || lastColon < 0) return null;
    tail = v4;
    address = address.slice(0, lastColon + 1) + "0:0"; // placeholder groups, replaced below
  }
  const halves = address.split("::");
  if (halves.length > 2) return null;
  const groupsOf = (s: string) => (s === "" ? [] : s.split(":"));
  const head = groupsOf(halves[0]!);
  const rest = halves.length === 2 ? groupsOf(halves[1]!) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const bytes: number[] = [];
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    const n = parseInt(g, 16);
    bytes.push(n >> 8, n & 0xff);
  }
  if (tail.length) bytes.splice(12, 4, ...tail);
  return bytes.length === 16 ? bytes : null;
}

function ipv6NonPublic(b: number[]): boolean {
  const zero = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (IPv4-mapped): judge the IPv4 address.
  if (zero(0, 10) && b[10] === 0xff && b[11] === 0xff) return ipv4NonPublic(b.slice(12));
  // ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-translated).
  if (zero(0, 12) || (zero(0, 8) && b[8] === 0xff && b[9] === 0xff && zero(10, 12))) return true;
  // 6to4 (2002::/16) carries an IPv4 address in bytes 2–5.
  if (b[0] === 0x20 && b[1] === 0x02) return ipv4NonPublic(b.slice(2, 6));
  // Outside 2000::/3 (global unicast) nothing is public: NAT64 64:ff9b::/96, discard 100::/64,
  // ULA fc00::/7, link-local fe80::/10, site-local fec0::/10, multicast ff00::/8, ...
  if ((b[0]! & 0xe0) !== 0x20) return true;
  // 2001::/23 (IETF protocol assignments incl. Teredo), 2001:db8::/32 and 3fff::/20 (documentation).
  if (b[0] === 0x20 && b[1] === 0x01 && b[2]! <= 0x01) return true;
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true;
  if (b[0] === 0x3f && b[1] === 0xff && b[2]! < 0x10) return true;
  return false;
}

/**
 * Loopback, private, link-local, site-local, CGNAT, benchmarking, IETF-reserved, documentation,
 * multicast, unspecified, NAT64/6to4/IPv4-mapped-to-private addresses — anything a customer's mail
 * server has no business living on. Addresses are compared as bytes, so non-canonical spellings
 * ("0:0:0:0:0:0:0:1", "::127.0.0.1", "::ffff:7f00:1") are caught. Unparseable input → true.
 */
export function isNonPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const v4 = parseIPv4(address);
    return v4 ? ipv4NonPublic(v4) : true;
  }
  const v6 = parseIPv6(address);
  return v6 ? ipv6NonPublic(v6) : true;
}

/**
 * Resolves `host` once and returns an address to connect to, or null when it doesn't resolve or
 * any of its addresses is non-public (unless private hosts are allowed, in development/test).
 */
export async function resolveSafeAddress(
  host: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<string | null> {
  if (isIP(host)) {
    return opts.allowPrivate || !isNonPublicAddress(host) ? host : null;
  }
  try {
    const addresses = await lookup(host, { all: true });
    if (!addresses.length) return null;
    if (!opts.allowPrivate && addresses.some((a) => isNonPublicAddress(a.address))) return null;
    return addresses[0]!.address;
  } catch {
    return null;
  }
}

/**
 * Pins an SMTP config to the address checked just now, so a DNS answer that changes between the
 * check and the connection (DNS rebinding) can't steer us into our own network. TLS still verifies
 * the certificate against the original host name. Throws SendError("auth") when the host is
 * unsafe or unresolvable, which pauses the mailbox instead of bouncing the contact.
 */
export async function pinSmtpConfig(
  config: SmtpConfig,
  opts: { allowPrivate?: boolean } = {},
): Promise<SmtpConfig> {
  const address = await resolveSafeAddress(config.host, opts);
  if (!address) {
    throw new SendError("The SMTP server's address isn't reachable from Openline", "auth");
  }
  return { ...config, connectAddress: address };
}

/** Second-level labels that are public suffixes under a two-letter country code (co.uk, com.au). */
const COUNTRY_SECOND_LEVELS = new Set(["ac", "co", "com", "edu", "gov", "net", "or", "org", "ne"]);

/**
 * The registrable domain of a host name ("imap.mail.example.co.uk" → "example.co.uk"), a
 * conservative approximation of the Public Suffix List without the dependency. IP literals and
 * single labels are returned as-is.
 */
export function registrableDomain(host: string): string {
  const name = host.trim().toLowerCase().replace(/\.$/, "");
  if (isIP(name) || isIP(name.replace(/^\[|\]$/g, ""))) return name;
  const labels = name.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");
  const tld = labels[labels.length - 1]!;
  const second = labels[labels.length - 2]!;
  const take = tld.length === 2 && COUNTRY_SECOND_LEVELS.has(second) ? 3 : 2;
  return labels.slice(-take).join(".");
}

/** True when both host names belong to the same registrable domain. */
export function sameRegistrableDomain(a: string, b: string): boolean {
  const x = registrableDomain(a);
  return x !== "" && x === registrableDomain(b);
}
