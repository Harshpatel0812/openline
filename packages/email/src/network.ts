import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { SendError } from "./adapter";
import type { SmtpConfig } from "./smtp";

function ipv4Parts(address: string): number[] {
  return address.split(".").map(Number);
}

/**
 * Loopback, private, link-local, CGNAT, benchmarking, IETF-reserved, multicast, unspecified and
 * NAT64 addresses — anything a customer's mail server has no business living on.
 */
export function isNonPublicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b, c] = ipv4Parts(address) as [number, number, number];
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0 && c === 0) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      a >= 224
    );
  }
  const v6 = address.toLowerCase();
  if (v6.startsWith("::ffff:")) return isNonPublicAddress(v6.slice(7));
  return (
    v6 === "::" ||
    v6 === "::1" ||
    v6.startsWith("64:ff9b:") ||
    v6.startsWith("fc") ||
    v6.startsWith("fd") ||
    v6.startsWith("fe8") ||
    v6.startsWith("fe9") ||
    v6.startsWith("fea") ||
    v6.startsWith("feb") ||
    v6.startsWith("ff") ||
    v6.startsWith("2001:db8:")
  );
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
