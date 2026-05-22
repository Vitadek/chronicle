import ipaddr from 'ipaddr.js';

/**
 * CIDR matching for forward-auth trusted-proxy verification.
 *
 * We check the *immediate* TCP peer (req.socket.remoteAddress), not the
 * X-Forwarded-For chain — those headers are exactly what we're deciding
 * whether to trust, so they can't be used to make that decision.
 */

const PRESETS: Record<string, string[]> = {
  loopback: ['127.0.0.0/8', '::1/128'],
  linklocal: ['169.254.0.0/16', 'fe80::/10'],
  uniquelocal: [
    '10.0.0.0/8',
    '172.16.0.0/12',
    '192.168.0.0/16',
    'fc00::/7',
  ],
};

export function parseTrustedProxies(spec: string): string[] {
  if (!spec) return [];
  return spec
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => PRESETS[s] ?? [s]);
}

/** Match an IP (possibly IPv4-mapped IPv6) against a list of CIDR strings. */
export function matchesTrustedProxy(
  ip: string | undefined,
  cidrs: string[],
): boolean {
  if (!ip) return false;

  // Normalise IPv4-mapped IPv6 (::ffff:127.0.0.1 → 127.0.0.1).
  const normalized = ip.startsWith('::ffff:') ? ip.slice(7) : ip;

  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.parse(normalized);
  } catch {
    return false;
  }

  for (const cidr of cidrs) {
    try {
      const slash = cidr.indexOf('/');
      // Bare IP → exact match.
      if (slash < 0) {
        const rangeAddr = ipaddr.parse(cidr);
        if (rangeAddr.kind() === addr.kind() && rangeAddr.toString() === addr.toString()) {
          return true;
        }
        continue;
      }
      const rangeAddr = ipaddr.parse(cidr.slice(0, slash));
      const bits = parseInt(cidr.slice(slash + 1), 10);
      if (rangeAddr.kind() !== addr.kind()) continue;
      if ((addr as ipaddr.IPv4 | ipaddr.IPv6).match(rangeAddr as any, bits)) {
        return true;
      }
    } catch {
      // skip malformed entries
    }
  }
  return false;
}
