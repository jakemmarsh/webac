/**
 * bridgeUtil — pure helpers for the WS↔UDP bridge, extracted from bridge.ts
 * so they are importable/unit-testable (bridge.ts starts a server on import).
 */

import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { DEFAULT_SERVERS_URL, DEFAULT_SERVERS_REFRESH_MS } from './serverList.js';

// AC packet header flags
export const FLAG_CONNECT_REQUEST = 0x00040000;
export const FLAG_CONNECT_RESPONSE = 0x00080000;
export const FLAG_DISCONNECT = 0x00008000;
export const CHECKSUM_SENTINEL = 0xBADD70DD;

/** ASSESS: UDP→WS backpressure limit — if the WS socket has more than this
 *  buffered, drop the datagram (datagram-drop matches UDP semantics; letting
 *  the buffer grow unbounded stalls every session behind a slow reader). */
export const WS_BACKPRESSURE_LIMIT = 1024 * 1024; // 1 MB

/** NET.receive-validation-and-bridge-hardening — largest WebSocket message
 *  accepted from a browser. An AC client datagram is at most
 *  ClientPacket.MaxPacketSize = 1024 bytes (ACE ConnectionListener), so 64 KB
 *  is generous while stopping a peer from making ws buffer megabytes. */
export const DEFAULT_WS_MAX_PAYLOAD = 64 * 1024;
/** Concurrent WebSocket clients (each owns a UDP socket + a game session).
 *  RELEASE Phase 2 raised it from 32 for public hosting: one session is one
 *  file descriptor + a few KB, and Railway allows 10k WebSockets. */
export const DEFAULT_MAX_CONNECTIONS = 500;

/** RELEASE Phase 2 abuse-limit defaults — generous for real play. A real
 *  client sends tens of datagrams per second, each at most 484 B (GDLE's
 *  inbound cap; ACE allows 1024). */
export const DEFAULT_LIMITS: BridgeLimits = {
  maxSessionsPerIp: 8,
  connectRatePerIp: 20,
  connectRateWindowMs: 60_000,
  maxSessionsPerServer: 100,
  msgRatePerSec: 200,
  msgBurst: 400,
  byteRatePerSec: 128 * 1024,
  byteBurst: 512 * 1024,
  abuseMaxDrops: 200,
  abuseWindowMs: 10_000,
};

export interface BridgeLimits {
  /** Concurrent sessions from one client IP (BRIDGE_MAX_SESSIONS_PER_IP). */
  maxSessionsPerIp: number;
  /** New connections per IP per window (BRIDGE_CONNECT_RATE_PER_IP / _WINDOW_MS). */
  connectRatePerIp: number;
  connectRateWindowMs: number;
  /** Concurrent sessions to one target server, multi mode (BRIDGE_MAX_SESSIONS_PER_SERVER). */
  maxSessionsPerServer: number;
  /** Per-session inbound WS message rate + burst (BRIDGE_MSG_RATE / BRIDGE_MSG_BURST). */
  msgRatePerSec: number;
  msgBurst: number;
  /** Per-session inbound byte rate + burst (BRIDGE_BYTE_RATE / BRIDGE_BYTE_BURST). */
  byteRatePerSec: number;
  byteBurst: number;
  /** Close a session that has more than this many rate-limited drops inside
   *  abuseWindowMs (BRIDGE_ABUSE_MAX_DROPS / BRIDGE_ABUSE_WINDOW_MS). */
  abuseMaxDrops: number;
  abuseWindowMs: number;
}

export interface BridgeConfig {
  wsPort: number;
  /**
   * Pinned mode: the era profile of the one server (BRIDGE_ERA, e.g.
   * 'classicace-customdm'); reported by /healthz so the launcher loads that
   * era's DATs (docs/dark-majesty-support.md). null = end of retail.
   */
  era?: string | null;
  /** ASSESS: default 127.0.0.1 — the bridge forwards raw game traffic with no
   *  auth, so it must not listen on all interfaces unless explicitly asked
   *  (BRIDGE_HOST env). */
  wsHost: string;
  aceHost: string;
  aceAuthPort: number;
  aceWorldPort: number;
  /** Per-packet console logging (BRIDGE_DEBUG env) — off by default; the
   *  logging overhead is real at combat packet rates. */
  debug: boolean;
  /** Browser Origins allowed to open a session, beyond the loopback ones
   *  (BRIDGE_ALLOWED_ORIGINS, comma-separated exact origins); '*' allows any.
   *  A missing Origin header (node ws clients, CLI tools) is always allowed —
   *  browsers always send one, so the check only stops other web pages. */
  allowedOrigins: string[] | '*';
  /** ws maxPayload (BRIDGE_MAX_PAYLOAD bytes). */
  maxPayload: number;
  /** Concurrent WebSocket client cap (BRIDGE_MAX_CONNECTIONS). */
  maxConnections: number;
  /** BRIDGE_ALLOW_ANY_UDP_SOURCE=1 disables the "datagrams only from the
   *  configured ACE host + ports" check (e.g. behind an unusual NAT). */
  allowAnyUdpSource: boolean;
  /** HARNESS.bridge-network-impairment: simulated network conditions, applied
   *  to every game datagram in both directions. null = none (the default). */
  impairment: ImpairmentConfig | null;
  /** 'pinned' = one fixed target (CLI args / BRIDGE_TARGET / the 127.0.0.1
   *  default; ?server is ignored). 'multi' = BRIDGE_MODE=multi with no pinned
   *  target: the client picks an allowlisted server with ?server=<id>. */
  mode: 'pinned' | 'multi';
  /** BRIDGE_TRUST_PROXY: number of trusted proxy hops in front of the bridge
   *  (1/true = one, e.g. Railway's edge). 0 = ignore X-Forwarded-For. */
  trustProxyHops: number;
  /** BRIDGE_CLIENT_IP_HEADER: trusted single-value client-IP header set by the
   *  edge (Railway: x-real-ip); only consulted when trustProxyHops > 0. */
  clientIpHeader?: string;
  /**
   * Simple Proxy Protocol (spp.ts): servers that trust this bridge and read
   * each player's real address from a header on every datagram. Pinned mode:
   * BRIDGE_SPP=1. Multi mode: BRIDGE_SPP_SERVERS, comma-separated server ids
   * (lower-cased). Turn it on only once the server trusts the bridge's address:
   * a server that doesn't would read the header as a broken packet.
   */
  spp: { pinned: boolean; servers: Set<string> };
  limits: BridgeLimits;
  /** Multi mode: allow targets that resolve to private/loopback/link-local
   *  addresses (BRIDGE_ALLOW_PRIVATE_TARGETS=1; local development only). */
  allowPrivateTargets: boolean;
  serverList: {
    /** BRIDGE_SERVERS_URL; 'none' or '' disables the remote list. */
    url: string | null;
    refreshMs: number;
    /** BRIDGE_SERVERS_CACHE; 'none' disables the disk cache. */
    cachePath: string | null;
    /** BRIDGE_SERVERS_OVERLAY (file path) and BRIDGE_SERVERS_OVERLAY_JSON (inline). */
    overlayPath: string | null;
    overlayJson: string | null;
  };
  /** NODE_ENV === 'production'. */
  production: boolean;
  /** BRIDGE_CAPTURE file, or null. Always null in production (refused). */
  capturePath: string | null;
  /** True when BRIDGE_CAPTURE was set but refused because NODE_ENV=production. */
  captureRefused: boolean;
  /** BRIDGE_METRICS_TOKEN: bearer token required for /metrics (null = open). */
  metricsToken: string | null;
  /**
   * AGENT.routine-store-auth — where /routines keeps each account's automation
   * routines (BRIDGE_ROUTINES_DIR, else ACJS_ROUTINES_DIR, else
   * ~/.acjs-agent/routines). Production bridges keep none unless
   * BRIDGE_ROUTINES_DIR names a volume; 'none' turns the endpoint off.
   */
  routinesDir: string | null;
  /**
   * AGENT.automation-allowlist — BRIDGE_AUTOMATION_ACCOUNTS: accounts that get the automation UI on
   * production builds, comma-separated `server:account` (the routines server key, e.g. `local-eor`
   * or a Servers.xml row) or `*:account` / `account` for any server. Names compare case-insensitively
   * against the account the game server reported in its CharacterList. `*` is every account (the
   * automation UI open to all players), and `server:*` every account on that server.
   */
  automationAccounts: string[];
  /**
   * BRIDGE_PREVIEW_ACCOUNTS: accounts that see preview UI before every player does (the Virindi Views bar,
   * 2026-10-12), in BRIDGE_AUTOMATION_ACCOUNTS' format. Unset: the connector's BRIDGE_MCP_ACCOUNTS.
   * Empty: nobody.
   */
  previewAccounts: string[];
  /**
   * AGENT.hosted-mcp-connector — BRIDGE_MCP_DEV_TOKENS: `token=server:account,…`. Each bearer token
   * lets an MCP client (Claude Code) play that account's own open tab through /mcp. Empty: no /mcp.
   * (Step 1 of docs/hosted-agent-connector.md; OAuth pairing replaces these tokens later.)
   */
  mcpTokens: string;
  /**
   * AGENT.hosted-mcp-connector step 3 — BRIDGE_MCP=on serves OAuth pairing (/.well-known, /oauth/*) and
   * /mcp for paired clients. BRIDGE_PUBLIC_URL is the bridge's public https origin (metadata);
   * BRIDGE_MCP_ACCOUNTS limits pairing to `server:account` / `account` entries (empty: any);
   * BRIDGE_MCP_SECRET (≥ 32 characters) seals the tokens so pairings survive restarts (oauth.ts).
   */
  mcpOAuth: boolean;
  mcpPublicUrl: string;
  mcpAccounts: string[];
  mcpSecret: string | null;
  /** BRIDGE_CONNECT_PAGE: the game's connect screen (e.g. https://playwebac.com/); authorize redirects there. Unset: the bridge's plain page. */
  mcpConnectPage: string | null;
}

/** Whether `account` on `server` is on the automation allowlist. */
export function automationAllowed(list: readonly string[], server: string, account: string): boolean {
  const a = account.toLowerCase();
  return list.some((entry) => {
    const i = entry.lastIndexOf(':');
    const s = i < 0 ? '*' : entry.slice(0, i);
    const n = (i < 0 ? entry : entry.slice(i + 1)).toLowerCase();
    return (n === '*' || n === a) && (s === '*' || s.toLowerCase() === server.toLowerCase());
  });
}

/**
 * HARNESS.bridge-network-impairment — simulated network conditions, so the
 * client can be exercised under a remote player's latency and loss instead of
 * localhost's ~0 ms. Every value is ONE-WAY and applies separately to each
 * direction, so the round trip adds 2 × latencyMs.
 *
 *   BRIDGE_LATENCY_MS  base one-way delay
 *   BRIDGE_JITTER_MS   ± uniform spread on the delay; delays are drawn per
 *                      datagram, so jitter also reorders them, as UDP does
 *   BRIDGE_LOSS_PCT    chance (0–100) each datagram is dropped
 *   BRIDGE_IMPAIR_SEED PRNG seed (default 1) — the same seed drops and delays
 *                      the same datagrams, so a failing run can be repeated
 */
export interface ImpairmentConfig {
  latencyMs: number;
  jitterMs: number;
  lossPct: number;
  seed: number;
}

export function resolveImpairment(env: Record<string, string | undefined>): ImpairmentConfig | null {
  const num = (v: string | undefined): number => {
    const n = v === undefined ? NaN : Number(v);
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const latencyMs = num(env.BRIDGE_LATENCY_MS);
  const jitterMs = num(env.BRIDGE_JITTER_MS);
  const lossPct = Math.min(100, num(env.BRIDGE_LOSS_PCT));
  if (latencyMs === 0 && jitterMs === 0 && lossPct === 0) return null;
  const seed = Math.trunc(num(env.BRIDGE_IMPAIR_SEED)) || 1;
  return { latencyMs, jitterMs, lossPct, seed };
}

/** mulberry32 — small seeded PRNG returning [0, 1). */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** One direction's impairment: send(deliver) drops it, runs it after a delay,
 *  or (no impairment) runs it now. Returns 'dropped' | 'delayed' | 'sent'. */
export interface ImpairedLink {
  send(deliver: () => void): 'dropped' | 'delayed' | 'sent';
  /** Cancel every pending delayed delivery (session closed). */
  close(): void;
}

export function makeImpairedLink(
  config: ImpairmentConfig | null,
  schedule: (fn: () => void, ms: number) => unknown = setTimeout,
  cancel: (handle: unknown) => void = (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
): ImpairedLink {
  if (!config) return { send: (deliver) => { deliver(); return 'sent'; }, close: () => {} };
  const rand = seededRandom(config.seed);
  const pending = new Set<unknown>();
  let closed = false;
  return {
    send(deliver) {
      if (closed) return 'dropped';
      if (config.lossPct > 0 && rand() * 100 < config.lossPct) return 'dropped';
      const delay = Math.max(0, config.latencyMs + (rand() * 2 - 1) * config.jitterMs);
      const handle = schedule(() => { pending.delete(handle); if (!closed) deliver(); }, delay);
      pending.add(handle);
      return 'delayed';
    },
    close() {
      closed = true;
      for (const h of pending) cancel(h);
      pending.clear();
    },
  };
}

const DEFAULT_WS_PORT = 9090;

/** Parse "host:port" (BRIDGE_TARGET). */
export function parseHostPort(value: string): { host: string; port: number } | null {
  const m = /^\s*([^\s:]+):(\d{1,5})\s*$/.exec(value);
  if (!m) return null;
  const port = parseInt(m[2], 10);
  if (port < 1 || port > 65534) return null;
  return { host: m[1], port };
}

function truthy(v: string | undefined): boolean {
  return v === '1' || v === 'true' || v === 'yes';
}

export function resolveBridgeConfig(
  argv: string[],
  env: Record<string, string | undefined>,
): BridgeConfig {
  // Pinned target: positional args win, then BRIDGE_TARGET=host:port (handy in
  // Docker, where there are no args), then the historical 127.0.0.1 default.
  const envTarget = env.BRIDGE_TARGET ? parseHostPort(env.BRIDGE_TARGET) : null;
  if (env.BRIDGE_TARGET && !envTarget) throw new Error(`BRIDGE_TARGET must be host:port, got "${env.BRIDGE_TARGET}"`);
  const pinnedByOperator = argv[1] !== undefined || envTarget !== null;
  const mode: 'pinned' | 'multi' = !pinnedByOperator && env.BRIDGE_MODE === 'multi' ? 'multi' : 'pinned';
  const aceHost = argv[1] || envTarget?.host || '127.0.0.1';
  const aceAuthPort = parseInt(argv[2] || String(envTarget?.port ?? 9000), 10);
  const aceWorldPort = parseInt(argv[3] || String(aceAuthPort + 1), 10);

  const trustRaw = (env.BRIDGE_TRUST_PROXY ?? '').trim().toLowerCase();
  const trustProxyHops = trustRaw === 'true' || trustRaw === 'yes' ? 1 : positiveInt(trustRaw || undefined, 0);

  const production = env.NODE_ENV === 'production';
  const captureRequested = env.BRIDGE_CAPTURE || '';
  const captureRefused = production && captureRequested !== '';

  const urlRaw = env.BRIDGE_SERVERS_URL;
  const cacheRaw = env.BRIDGE_SERVERS_CACHE;
  const d = DEFAULT_LIMITS;
  return {
    wsPort: positiveInt(argv[0] || env.BRIDGE_PORT || env.PORT, DEFAULT_WS_PORT),
    era: /^[a-z0-9][a-z0-9-]{0,63}$/.test(env.BRIDGE_ERA ?? '') ? env.BRIDGE_ERA! : null,
    wsHost: env.BRIDGE_HOST || '127.0.0.1',
    aceHost,
    aceAuthPort,
    aceWorldPort,
    debug: env.BRIDGE_DEBUG === '1' || env.BRIDGE_DEBUG === 'true',
    allowedOrigins: parseAllowedOrigins(env.BRIDGE_ALLOWED_ORIGINS),
    maxPayload: positiveInt(env.BRIDGE_MAX_PAYLOAD, DEFAULT_WS_MAX_PAYLOAD),
    maxConnections: positiveInt(env.BRIDGE_MAX_CONNECTIONS, DEFAULT_MAX_CONNECTIONS),
    allowAnyUdpSource: env.BRIDGE_ALLOW_ANY_UDP_SOURCE === '1' || env.BRIDGE_ALLOW_ANY_UDP_SOURCE === 'true',
    impairment: resolveImpairment(env),
    mode,
    trustProxyHops,
    clientIpHeader: env.BRIDGE_CLIENT_IP_HEADER?.trim().toLowerCase() || undefined,
    spp: {
      pinned: truthy(env.BRIDGE_SPP),
      servers: new Set((env.BRIDGE_SPP_SERVERS ?? '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean)),
    },
    limits: {
      maxSessionsPerIp: positiveInt(env.BRIDGE_MAX_SESSIONS_PER_IP, d.maxSessionsPerIp),
      connectRatePerIp: positiveInt(env.BRIDGE_CONNECT_RATE_PER_IP, d.connectRatePerIp),
      connectRateWindowMs: positiveInt(env.BRIDGE_CONNECT_RATE_WINDOW_MS, d.connectRateWindowMs),
      maxSessionsPerServer: positiveInt(env.BRIDGE_MAX_SESSIONS_PER_SERVER, d.maxSessionsPerServer),
      msgRatePerSec: positiveInt(env.BRIDGE_MSG_RATE, d.msgRatePerSec),
      msgBurst: positiveInt(env.BRIDGE_MSG_BURST, d.msgBurst),
      byteRatePerSec: positiveInt(env.BRIDGE_BYTE_RATE, d.byteRatePerSec),
      byteBurst: positiveInt(env.BRIDGE_BYTE_BURST, d.byteBurst),
      abuseMaxDrops: positiveInt(env.BRIDGE_ABUSE_MAX_DROPS, d.abuseMaxDrops),
      abuseWindowMs: positiveInt(env.BRIDGE_ABUSE_WINDOW_MS, d.abuseWindowMs),
    },
    allowPrivateTargets: truthy(env.BRIDGE_ALLOW_PRIVATE_TARGETS),
    serverList: {
      url: urlRaw === undefined ? DEFAULT_SERVERS_URL : (urlRaw === '' || urlRaw === 'none' ? null : urlRaw),
      refreshMs: positiveInt(env.BRIDGE_SERVERS_REFRESH_MS, DEFAULT_SERVERS_REFRESH_MS),
      cachePath: cacheRaw === undefined ? join(tmpdir(), 'acjs-bridge-servers.xml') : (cacheRaw === '' || cacheRaw === 'none' ? null : cacheRaw),
      overlayPath: env.BRIDGE_SERVERS_OVERLAY || null,
      overlayJson: env.BRIDGE_SERVERS_OVERLAY_JSON || null,
    },
    production,
    capturePath: captureRefused || !captureRequested ? null : captureRequested,
    captureRefused,
    metricsToken: env.BRIDGE_METRICS_TOKEN || null,
    routinesDir: resolveRoutinesDir(env, production),
    automationAccounts: (env.BRIDGE_AUTOMATION_ACCOUNTS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    mcpTokens: env.BRIDGE_MCP_DEV_TOKENS ?? '',
    mcpOAuth: (env.BRIDGE_MCP ?? '').toLowerCase() === 'on',
    mcpPublicUrl: (env.BRIDGE_PUBLIC_URL ?? '').replace(/\/+$/, ''),
    mcpAccounts: (env.BRIDGE_MCP_ACCOUNTS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    previewAccounts: (env.BRIDGE_PREVIEW_ACCOUNTS ?? env.BRIDGE_MCP_ACCOUNTS ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    mcpSecret: env.BRIDGE_MCP_SECRET || null,
    mcpConnectPage: /^https?:\/\//.test(env.BRIDGE_CONNECT_PAGE ?? '') ? env.BRIDGE_CONNECT_PAGE! : null,
  };
}

function resolveRoutinesDir(env: NodeJS.ProcessEnv, production: boolean): string | null {
  const set = env.BRIDGE_ROUTINES_DIR?.trim();
  if (set === 'none') return null;
  if (set) return set;
  if (production) return null;
  return env.ACJS_ROUTINES_DIR?.trim() || join(homedir(), '.acjs-agent', 'routines');
}

function positiveInt(value: string | undefined, fallback: number): number {
  const n = value === undefined ? NaN : parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseAllowedOrigins(value: string | undefined): string[] | '*' {
  if (!value) return [];
  if (value.trim() === '*') return '*';
  return value.split(',').map(o => o.trim().replace(/\/+$/, '').toLowerCase()).filter(o => o.length > 0);
}

const LOOPBACK_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Whether a WebSocket upgrade's Origin may open a session: no Origin (a
 * non-browser client), any http(s) origin on a loopback host, or one listed
 * in BRIDGE_ALLOWED_ORIGINS. Stops an arbitrary web page the user visits from
 * driving the bridge (and the ACE account behind it) from their browser.
 */
export function isOriginAllowed(origin: string | undefined, allowed: string[] | '*'): boolean {
  if (origin === undefined || origin === '') return true;
  if (allowed === '*') return true;
  const normalized = origin.trim().replace(/\/+$/, '').toLowerCase();
  if (allowed.includes(normalized)) return true;
  let url: URL;
  try { url = new URL(normalized); } catch { return false; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return LOOPBACK_HOSTNAMES.has(url.hostname);
}

/** Strip the IPv4-mapped-IPv6 prefix Node reports on dual-stack sockets. */
export function normalizeAddress(address: string): string {
  const a = address.toLowerCase();
  return a.startsWith('::ffff:') ? a.slice(7) : a;
}

/** Addresses the ACE host name can arrive from, before DNS resolution. */
export function initialAceAddresses(aceHost: string): Set<string> {
  const set = new Set<string>([normalizeAddress(aceHost)]);
  if (aceHost.toLowerCase() === 'localhost') { set.add('127.0.0.1'); set.add('::1'); }
  return set;
}

/**
 * NET.receive-validation-and-bridge-hardening — only datagrams from the
 * configured ACE server reach the browser. ACE answers from its C2S or S2C
 * listener (NetworkSession SendPacketRaw: connectionC2S until the S2C
 * endpoint is set, then connectionS2C — the auth and world ports), so any
 * other source is a spoofer poking the per-session UDP port.
 */
export function isFromAce(
  rinfo: { address: string; port: number },
  aceAddresses: Set<string>,
  acePorts: number[],
): boolean {
  return acePorts.includes(rinfo.port) && aceAddresses.has(normalizeAddress(rinfo.address));
}

/** True if a UDP→WS datagram should be dropped due to WS backpressure. */
export function shouldDropForBackpressure(
  bufferedAmount: number,
  limit: number = WS_BACKPRESSURE_LIMIT,
): boolean {
  return bufferedAmount > limit;
}

/** Rate-limited warn — logs at most once per intervalMs, counting suppressed calls. */
export function makeRateLimitedWarn(intervalMs: number = 1000): (msg: string) => void {
  let lastWarnAt = 0;
  let suppressed = 0;
  return (msg: string) => {
    const now = Date.now();
    if (now - lastWarnAt >= intervalMs) {
      console.warn(suppressed > 0 ? `${msg} (+${suppressed} suppressed)` : msg);
      lastWarnAt = now;
      suppressed = 0;
    } else {
      suppressed++;
    }
  };
}

export function readPacketFlags(buf: Buffer): number {
  if (buf.length < 8) return 0;
  return buf.readUInt32LE(4);
}

/**
 * NET.bridge-disconnect-wrong-session-id — the client's ACE session id, from
 * a server ConnectRequest (flags & ConnectRequest): the payload's
 * CConnectHeader.NetID at offset 16 (ACE PacketOutboundConnectRequest writes
 * serverTime f64, cookie u64, clientId u32, seeds). It is the index ACE routes
 * the client's packets by (NetworkManager sessionMap[packet.Header.Id]) and
 * may be 0. Every OTHER server packet carries ServerId (0xB — FlushPackets
 * sets packet.Header.Id = ServerId), which is why reading the first server
 * header's Id aimed the bridge's Disconnect at the wrong session. Returns null
 * for anything that isn't a ConnectRequest.
 */
export function readConnectRequestClientId(buf: Buffer): number | null {
  if (buf.length < 20 + 20) return null;
  if ((readPacketFlags(buf) & FLAG_CONNECT_REQUEST) === 0) return null;
  return buf.readUInt32LE(20 + 16) & 0xFFFF;
}

/** Read the session Id (uint16) at header offset 12. */
export function readPacketId(buf: Buffer): number {
  if (buf.length < 14) return 0;
  return buf.readUInt16LE(12);
}

/** AC's Hash32 checksum (ported from ACE.Common.Cryptography.Hash32). */
export function hash32(data: Buffer, offset: number, length: number): number {
  let checksum = (length << 16) >>> 0;
  const fullWords = Math.floor(length / 4);
  for (let i = 0; i < fullWords; i++) {
    checksum = (checksum + data.readUInt32LE(offset + i * 4)) >>> 0;
  }
  let shift = 3;
  let j = fullWords * 4;
  while (j < length) {
    checksum = (checksum + ((data[offset + j] << (8 * shift)) >>> 0)) >>> 0;
    j++;
    shift--;
  }
  return checksum >>> 0;
}

/** Build a properly checksummed Disconnect packet with the given session ID. */
export function buildDisconnectPacket(sessionId: number): Buffer {
  const pkt = Buffer.alloc(20);
  pkt.writeUInt32LE(0, 0);              // sequence = 0
  pkt.writeUInt32LE(FLAG_DISCONNECT, 4); // flags = Disconnect
  pkt.writeUInt32LE(CHECKSUM_SENTINEL, 8); // placeholder for checksum calculation
  pkt.writeUInt16LE(sessionId, 12);      // session Id
  pkt.writeUInt16LE(0, 14);             // time = 0
  pkt.writeUInt16LE(0, 16);             // size = 0
  pkt.writeUInt16LE(0, 18);             // iteration = 0
  // Calculate header checksum (hash of header with sentinel in checksum field)
  const headerHash = hash32(pkt, 0, 20);
  // Final checksum = headerHash + payloadHash (no payload, so payloadHash = 0)
  pkt.writeUInt32LE(headerHash, 8);
  return pkt;
}
