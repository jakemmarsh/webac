/**
 * AGENT.hosted-mcp-connector — the tab's relay link across a bridge deploy
 * (docs/hosted-agent-connector.md §4.5).
 *
 * The relay normally rides the game WebSocket. A bridge deploy drains the old
 * container for hours: the game keeps playing there, but every new request,
 * Claude's /mcp calls included, reaches the new deployment, which has never
 * seen this tab. Claude then answered "your game is not open" for the rest of
 * the drain (prod, 2026-10-12 23:13Z).
 *
 * So the draining bridge tells the tab ({"bridgeDraining":true}); the tab asks
 * it for a relay-link ticket (a short-lived token sealed with the secret both
 * deployments hold, naming the account the server logged in), opens a second
 * WebSocket to the bridge URL (which now lands on the new deployment) and
 * presents it ({"relayHello":ticket}). That socket then carries the relay:
 * calls, the tab's state, pairing codes. The game socket keeps draining.
 * The link ends when the game session does (its reconnect lands on a live bridge).
 */
import type { AgentCallFrame, PairingReply, RelayLinkNotice } from '@ac/network';
import { parseAgentCall, parsePairingReply } from '@ac/network';

/** The few WebSocket members the link uses (a browser WebSocket fits; tests pass a fake). */
export interface LinkSocket {
  readonly readyState: number;
  send(text: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

const OPEN = 1;
/** Retry delays while the game's bridge still drains and the link is down (the last one repeats). */
export const RELINK_DELAYS_MS = [2_000, 5_000, 10_000, 30_000];

/** The link's URL: the game's bridge URL without a server (a relay link forwards no game traffic). */
export function relayLinkUrl(gameUrl: string): string {
  try {
    const u = new URL(gameUrl);
    u.searchParams.delete('server');
    u.searchParams.set('relay', '1');
    return u.toString();
  } catch { return gameUrl; }
}

export interface RelayLinkOptions {
  /** The game session's bridge URL. */
  gameUrl(): string;
  /** Ask the game session's bridge for a ticket ('relayTicket' on the game socket). */
  requestTicket(): void;
  open(url: string): LinkSocket;
  /** A relay call that came down the link; `reply` answers on that same link. */
  onCall(call: AgentCallFrame, reply: (text: string) => void): void;
  /** The answer to a pairing code or an unpair sent over the link. */
  onPairing(r: PairingReply): void;
  /** The link is up: send the tab's state over it. */
  onLinked(): void;
  /** Whether this tab wants Claude's relay (Claude switched on): only then does a drain notice open a link. */
  wanted?(): boolean;
  log?(text: string): void;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

export class RelayLink {
  /** The game session's bridge is draining (it said so, or its ticket answer did). */
  draining = false;
  private sock: LinkSocket | null = null;
  private waitingTicket = false;
  private retry: unknown = null;
  private attempts = 0;
  /** Every socket still open (the previous link stays until the new one is linked). */
  private readonly socks = new Set<LinkSocket>();
  private readonly dropped = new WeakSet<LinkSocket>();
  private queued: string[] = [];

  constructor(private readonly o: RelayLinkOptions) {}

  get linked(): boolean { return !!this.sock && this.sock.readyState === OPEN; }

  /** A notice from the game socket's bridge. */
  onNotice(n: RelayLinkNotice): void {
    if (n.kind === 'draining') { this.draining = true; if (this.o.wanted?.() ?? true) this.relink(); return; }
    if (n.draining) this.draining = true;
    if (!this.waitingTicket) return;
    this.waitingTicket = false;
    // A live bridge: the game socket carries the relay, nothing to link.
    if (!this.draining) return;
    if (!n.ticket) { this.o.log?.('the bridge is handing over to a new deployment but can\'t vouch for this tab there (no shared secret)'); return; }
    this.connect(n.ticket);
  }

  /** Link afresh (the drain notice, `/automation claude on`): asks the game's bridge, which answers whether it drains. */
  relink(): void {
    this.cancelRetry();
    this.waitingTicket = true;
    this.o.requestTicket();
  }

  /** Send on the link when it is up (state, pairing frames). False: not linked, use the game socket. */
  send(text: string): boolean {
    if (!this.linked) return false;
    this.sock!.send(text);
    return true;
  }

  /**
   * A pairing frame: over the link when it is up; while the game's bridge drains with no link yet, held until
   * one is (the connect page's code waits on the new deployment). False: send it on the game socket.
   */
  sendPairing(text: string): boolean {
    if (this.send(text)) return true;
    if (!this.draining) return false;
    this.queued.push(text);
    if (!this.waitingTicket) this.relink();
    return true;
  }

  /** The game session ended: its reconnect lands on a live bridge, so the link goes. */
  reset(): void {
    this.draining = false;
    this.waitingTicket = false;
    this.queued = [];
    this.attempts = 0;
    this.cancelRetry();
    this.sock = null;
    for (const s of [...this.socks]) this.drop(s);
  }

  private cancelRetry(): void {
    if (this.retry !== null) (this.o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.retry);
    this.retry = null;
  }

  private scheduleRetry(): void {
    if (!this.draining || this.retry !== null || this.waitingTicket) return;
    const ms = RELINK_DELAYS_MS[Math.min(this.attempts, RELINK_DELAYS_MS.length - 1)];
    this.attempts++;
    this.retry = (this.o.setTimer ?? ((fn, t) => setTimeout(fn, t)))(() => { this.retry = null; if (this.draining && !this.linked) this.relink(); }, ms);
  }

  private connect(ticket: string): void {
    let ws: LinkSocket;
    try { ws = this.o.open(relayLinkUrl(this.o.gameUrl())); } catch { this.scheduleRetry(); return; }
    this.socks.add(ws);
    ws.onopen = () => { try { ws.send(JSON.stringify({ relayHello: ticket })); } catch { /* closing */ } };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') return;
      const text = ev.data;
      if (text.startsWith('{"relayLinked"')) {
        let ok = false;
        try { ok = (JSON.parse(text) as { relayLinked?: { ok?: unknown } }).relayLinked?.ok === true; } catch { /* not JSON */ }
        if (!ok) { this.o.log?.('the new bridge refused the relay link'); this.drop(ws); return; }
        const prev = this.sock;
        this.sock = ws;
        this.attempts = 0;
        if (prev && prev !== ws) this.drop(prev);
        this.o.onLinked();
        for (const q of this.queued.splice(0)) ws.send(q);
        return;
      }
      // The link's own bridge drains too (another deploy): link again.
      if (text.startsWith('{"bridgeDraining"')) { if (ws === this.sock) this.relink(); return; }
      const call = parseAgentCall(text);
      if (call) { this.o.onCall(call, (t) => { if (ws.readyState === OPEN) ws.send(t); }); return; }
      const pairing = parsePairingReply(text);
      if (pairing) this.o.onPairing(pairing);
    };
    ws.onerror = () => { /* onclose follows */ };
    ws.onclose = () => {
      this.socks.delete(ws);
      if (ws === this.sock) this.sock = null;
      // A link we dropped (refused, or replaced by a newer one), or one that closed while another is up: nothing to do.
      if (this.dropped.has(ws) || this.linked) return;
      this.scheduleRetry();
    };
  }

  private drop(ws: LinkSocket): void {
    this.dropped.add(ws);
    this.socks.delete(ws);
    if (this.sock === ws) this.sock = null;
    try { ws.close(); } catch { /* already closed */ }
  }
}
