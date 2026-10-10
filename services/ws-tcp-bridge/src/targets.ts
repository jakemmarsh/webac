/**
 * Target resolution for the multi-server bridge: a server id from the
 * allowlist is resolved to ONE public IPv4 address at connect time, and the
 * session is pinned to that address for its lifetime (so a DNS answer that
 * changes mid-session cannot redirect it). Private, loopback, link-local,
 * CGNAT, multicast and reserved addresses are refused unless the operator
 * set BRIDGE_ALLOW_PRIVATE_TARGETS (local development only) — otherwise a
 * hosted bridge could be aimed at the hosting provider's internal network.
 *
 * IPv4 only: each session's UDP socket is udp4, as it always was.
 */
import * as dns from 'dns';

export function parseIPv4(s: string): [number, number, number, number] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s.trim());
  if (!m) return null;
  const o = m.slice(1).map(Number);
  if (o.some(x => x > 255)) return null;
  return o as [number, number, number, number];
}

/** [network, prefix length] blocks that are never a public game server. */
const NON_PUBLIC_V4: [string, number][] = [
  ['0.0.0.0', 8],        // "this network"
  ['10.0.0.0', 8],       // RFC 1918
  ['100.64.0.0', 10],    // CGNAT (RFC 6598) — also some cloud internal ranges
  ['127.0.0.0', 8],      // loopback
  ['169.254.0.0', 16],   // link-local, incl. cloud metadata 169.254.169.254
  ['172.16.0.0', 12],    // RFC 1918
  ['192.0.0.0', 24],     // IETF protocol assignments
  ['192.0.2.0', 24],     // TEST-NET-1
  ['192.88.99.0', 24],   // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16],   // RFC 1918
  ['198.18.0.0', 15],    // benchmarking
  ['198.51.100.0', 24],  // TEST-NET-2
  ['203.0.113.0', 24],   // TEST-NET-3
  ['224.0.0.0', 4],      // multicast
  ['240.0.0.0', 4],      // reserved + broadcast
];

function toU32(o: [number, number, number, number]): number {
  return ((o[0] << 24) | (o[1] << 16) | (o[2] << 8) | o[3]) >>> 0;
}

/** True only for a syntactically valid, globally routable unicast IPv4 address. */
export function isPublicIPv4(ip: string): boolean {
  const o = parseIPv4(ip);
  if (!o) return false;
  const v = toU32(o);
  for (const [net, bits] of NON_PUBLIC_V4) {
    const mask = bits === 0 ? 0 : (0xFFFFFFFF << (32 - bits)) >>> 0;
    if ((v & mask) === (toU32(parseIPv4(net)!) & mask)) return false;
  }
  return true;
}

export type LookupFn = (host: string) => Promise<string[]>;

/** Default resolver: every IPv4 address for `host` (literals pass through). */
export const systemLookup: LookupFn = async (host) => {
  const addrs = await dns.promises.lookup(host, { all: true, family: 4 });
  return addrs.map(a => a.address);
};

export type ResolveResult =
  | { ok: true; address: string }
  | { ok: false; reason: 'dns_failed' | 'private_target' | 'ipv6_unsupported'; detail: string };

/**
 * Resolve `host` to the address a session will use: the first public IPv4
 * address it resolves to (or the first address of any kind when
 * `allowPrivate`). Fails closed on DNS errors and timeouts.
 */
export async function resolveTarget(
  host: string,
  opts: { allowPrivate: boolean; lookup?: LookupFn; timeoutMs?: number },
): Promise<ResolveResult> {
  if (host.includes(':')) return { ok: false, reason: 'ipv6_unsupported', detail: host };
  const lookup = opts.lookup ?? systemLookup;
  let addrs: string[];
  try {
    addrs = await withTimeout(lookup(host), opts.timeoutMs ?? 5000);
  } catch (err) {
    return { ok: false, reason: 'dns_failed', detail: (err as Error).message };
  }
  const v4 = addrs.filter(a => parseIPv4(a) !== null);
  if (v4.length === 0) return { ok: false, reason: 'dns_failed', detail: `no IPv4 address for ${host}` };
  if (opts.allowPrivate) return { ok: true, address: v4[0] };
  const pub = v4.find(isPublicIPv4);
  if (!pub) return { ok: false, reason: 'private_target', detail: `${host} → ${v4.join(',')}` };
  return { ok: true, address: pub };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}
