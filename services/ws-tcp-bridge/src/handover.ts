/**
 * Planned handover of a game session from a draining bridge to the new
 * deployment (docs/bridge-handover.md).
 *
 * The bridge is a dumb pipe: every piece of the game protocol (sequences,
 * ISAAC, acks, retransmits) runs in the browser, and the game server knows
 * the session only by the UDP endpoint it talks to (ACE, GDLE and the AC1999
 * server all key a session on the client's address and port). So a session
 * moves between two bridge processes on the same host without the server
 * noticing: the old process closes the session's UDP socket without the
 * Disconnect packet, the new one binds the same local address and port, and
 * the tab swaps its WebSocket. No logout, no re-login, no character leaving
 * the world. A re-login handover can't be fast: ACE keeps a dropped
 * character in the world for 2 s (SessionTerminationDetails) plus its
 * 5.67 s LogOut motion (Player.LogOut_Final), during which every physical
 * attack on it is a critical hit (DamageEvent.cs).
 *
 * The old bridge vouches for the session with a sealed ticket (AES-GCM under
 * the secret the two deployments share), handed only to the tab over the
 * session's own WebSocket. The ticket names the socket's local address and
 * port, the server, the wire protocol, the ids the bridge keeps for the
 * session (for its eventual Disconnect), the egress lease, and the host it
 * was made on: only a process on the same network namespace (the AWS host
 * runs every bridge container with host networking) can take the port over.
 */
import * as dgram from 'dgram';
import { createHash, randomBytes } from 'crypto';
import * as os from 'os';
import { Sealer } from './oauth.js';

/** How long a ticket stays good: the tab uses it straight away. */
export const HANDOVER_TICKET_MS = 30_000;
/** The new bridge retries the bind this often while the old one lets go of the port. */
export const HANDOVER_BIND_RETRY_MS = 5;
/** And gives up after this long (the tab then resumes the usual way). */
export const HANDOVER_BIND_MAX_MS = 3_000;

/** Tab → old bridge: a ticket for this session. */
export const HANDOVER_TICKET_REQUEST = 'handoverTicket';
/** Tab → old bridge: the new bridge accepted the ticket; let go of the socket now. */
export const HANDOVER_RELEASE = 'handoverRelease';

/** What a ticket carries. */
export interface HandoverTicket {
  /** The host it was made on (handoverHostId). */
  host: string;
  /** The session's server (Target.key). */
  target: string;
  protocol: 'eor' | 'ac1999';
  /** The UDP socket's local address and port. */
  address: string;
  port: number;
  /** The session id the server gave (the Disconnect's), and the 1999 header time byte. */
  aceSessionId: number | null;
  time1999: number;
  /** The account the server's CharacterList named, if read. */
  account: string | null;
  /** The egress lease's session id (egress.ts), when the session has one. */
  egress: string | null;
  /** The tab's trace id (session_open / session_close carry it). */
  trace: string | null;
  nonce: string;
  expires: number;
}

/**
 * The host's identity: its name and its own IPv4 addresses. Every bridge
 * container on the AWS host shares the host's network (and so these); a
 * bridge elsewhere can't bind the port, and the server would see another
 * address anyway.
 */
export function handoverHostId(): string {
  const addrs: string[] = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
  }
  addrs.sort();
  return createHash('sha256').update(`${os.hostname()}\0${addrs.join(',')}`).digest('hex').slice(0, 32);
}

export class HandoverTickets {
  private readonly sealer: Sealer;
  private readonly used = new Map<string, number>();

  constructor(secret: string, private readonly now: () => number = Date.now, readonly host: string = handoverHostId()) {
    this.sealer = new Sealer(secret);
  }

  issue(t: Omit<HandoverTicket, 'host' | 'nonce' | 'expires'>): string {
    const ticket: HandoverTicket = { ...t, host: this.host, nonce: randomBytes(9).toString('base64url'), expires: this.now() + HANDOVER_TICKET_MS };
    return this.sealer.seal('h1', ticket);
  }

  /** The ticket's contents, or why it is refused. A ticket opens once. */
  open(tok: string): { ok: true; ticket: HandoverTicket } | { ok: false; reason: string } {
    const t = this.sealer.open<HandoverTicket>('h1', tok);
    if (!t || typeof t.port !== 'number' || typeof t.address !== 'string' || typeof t.target !== 'string') return { ok: false, reason: 'bad_ticket' };
    const at = this.now();
    for (const [n, e] of this.used) if (e < at) this.used.delete(n);
    if (t.expires < at) return { ok: false, reason: 'expired' };
    if (t.host !== this.host) return { ok: false, reason: 'other_host' };
    if (this.used.has(t.nonce)) return { ok: false, reason: 'used' };
    this.used.set(t.nonce, t.expires);
    return { ok: true, ticket: t };
  }
}

/**
 * Bind a UDP socket to `address:port`, retrying while the port is still held
 * (the old bridge closes it once the tab says so). Resolves with the bound
 * socket, or null after `maxMs`.
 */
export function bindWhenFree(
  address: string, port: number,
  opts: { retryMs?: number; maxMs?: number; now?: () => number } = {},
): Promise<dgram.Socket | null> {
  const retryMs = opts.retryMs ?? HANDOVER_BIND_RETRY_MS;
  const maxMs = opts.maxMs ?? HANDOVER_BIND_MAX_MS;
  const now = opts.now ?? Date.now;
  const started = now();
  return new Promise((resolve) => {
    const attempt = () => {
      const udp = dgram.createSocket('udp4');
      const onError = (err: NodeJS.ErrnoException) => {
        try { udp.close(); } catch { /* never bound */ }
        if (err.code !== 'EADDRINUSE' || now() - started >= maxMs) { resolve(null); return; }
        setTimeout(attempt, retryMs);
      };
      udp.once('error', onError);
      udp.bind({ address, port, exclusive: true }, () => {
        udp.off('error', onError);
        resolve(udp);
      });
    };
    attempt();
  });
}
