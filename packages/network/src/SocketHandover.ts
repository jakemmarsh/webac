/**
 * The tab's side of a planned handover (bridge services/ws-tcp-bridge/src/
 * handover.ts; docs/bridge-handover.md): move the live game session from a
 * draining bridge to the new deployment by swapping only the WebSocket.
 *
 * The game protocol (sequences, ISAAC, acks, retransmits) lives here in the
 * tab, and the server knows the session only by its UDP endpoint, which the
 * new bridge takes over. So nothing about the session changes: no logout, no
 * login, the character never leaves the world. A datagram either way during
 * the switch (a few ms) is lost like any UDP loss and recovered by the
 * protocol's own NAK / retransmit.
 *
 *   1. old socket: 'handoverTicket' → {"handoverTicket":{"ticket":…}}
 *   2. new socket (same URL + handover=1): {"adopt":ticket} → {"adopt":{"ok":true}}
 *   3. old socket: 'handoverRelease' (the old bridge closes the UDP socket, no Disconnect)
 *   4. new socket: {"adopted":{"ok":true}} once it holds the port → the connection swaps sockets.
 *
 * Any refusal before step 3 leaves the session where it was (released:
 * false). A failure after it (released: true) means the session's socket is
 * gone: the connection reports the session ended, and the page's usual
 * resume (re-login) takes over.
 */

/** The part of a WebSocket the handover drives (a browser WebSocket, or a fake in tests). */
export interface HandoverSocket {
  readonly readyState: number;
  binaryType?: string;
  send(data: string | ArrayBufferLike | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: unknown) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export const HANDOVER_TICKET_REQUEST = 'handoverTicket';
export const HANDOVER_RELEASE = 'handoverRelease';

/** Step limits: the old bridge's ticket, the new socket's open + adopt answer, the new bridge's bind. */
export const HANDOVER_TICKET_TIMEOUT_MS = 3000;
export const HANDOVER_ADOPT_TIMEOUT_MS = 6000;
export const HANDOVER_BIND_TIMEOUT_MS = 5000;

export type HandoverStage = 'ticket' | 'connect' | 'adopt' | 'bind';

export type HandoverResult =
  | { ok: true; ms: number }
  | { ok: false; stage: HandoverStage; reason: string; released: boolean; ms: number };

/** The handover socket's URL: the session's own, marked so the new bridge expects a ticket. */
export function handoverUrl(url: string): string {
  if (/[?&]handover=/.test(url)) return url;
  return `${url}${url.includes('?') ? '&' : '?'}handover=1`;
}

const OPEN = 1;

export interface SocketHandoverOptions {
  /** The session's live socket on the draining bridge. */
  old: HandoverSocket;
  /** The session's bridge URL (the same one the session opened). */
  url: string;
  open(url: string): HandoverSocket;
  /** The new socket holds the session: install it (its handlers), then take the frames it already carried. */
  switchTo(ws: HandoverSocket, early: unknown[]): void;
  done(r: HandoverResult): void;
  now?(): number;
  setTimer?(fn: () => void, ms: number): unknown;
  clearTimer?(t: unknown): void;
}

export class SocketHandover {
  private stage: HandoverStage = 'ticket';
  private ws: HandoverSocket | null = null;
  private timer: unknown = null;
  private finished = false;
  private released = false;
  private readonly started: number;
  private readonly early: unknown[] = [];

  constructor(private readonly o: SocketHandoverOptions) {
    this.started = this.now();
  }

  private now(): number { return this.o.now ? this.o.now() : Date.now(); }

  private arm(ms: number): void {
    this.disarm();
    this.timer = (this.o.setTimer ?? ((fn, t) => setTimeout(fn, t)))(() => { this.timer = null; this.fail('timeout'); }, ms);
  }

  private disarm(): void {
    if (this.timer !== null) (this.o.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>)))(this.timer);
    this.timer = null;
  }

  get active(): boolean { return !this.finished; }

  start(): void {
    if (this.o.old.readyState !== OPEN) { this.fail('not_connected'); return; }
    this.arm(HANDOVER_TICKET_TIMEOUT_MS);
    this.o.old.send(HANDOVER_TICKET_REQUEST);
  }

  /** A text frame on the old socket: true when it was the ticket answer. */
  onOldText(text: string): boolean {
    if (!text.startsWith('{"handoverTicket"')) return false;
    if (this.finished || this.stage !== 'ticket') return true;
    let ticket: string | null = null;
    let reason = 'no_ticket';
    try {
      const t = (JSON.parse(text) as { handoverTicket?: { ticket?: unknown; reason?: unknown } }).handoverTicket;
      if (typeof t?.ticket === 'string' && t.ticket) ticket = t.ticket;
      if (typeof t?.reason === 'string') reason = t.reason;
    } catch { /* malformed */ }
    if (!ticket) { this.fail(reason); return true; }
    this.connect(ticket);
    return true;
  }

  private connect(ticket: string): void {
    this.stage = 'connect';
    this.arm(HANDOVER_ADOPT_TIMEOUT_MS);
    let ws: HandoverSocket;
    try { ws = this.o.open(handoverUrl(this.o.url)); } catch { this.fail('cant_socket'); return; }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    ws.onopen = () => {
      if (this.finished) return;
      this.stage = 'adopt';
      ws.send(JSON.stringify({ adopt: ticket }));
    };
    ws.onmessage = (ev) => {
      if (this.finished) return;
      if (typeof ev.data !== 'string') { this.early.push(ev.data); return; }
      if (ev.data.startsWith('{"adopt"')) this.onAdopt(ev.data);
      else if (ev.data.startsWith('{"adopted"')) this.onAdopted(ev.data);
    };
    ws.onerror = () => { /* the close follows */ };
    ws.onclose = () => { if (!this.finished) this.fail('closed'); };
  }

  private onAdopt(text: string): void {
    const a = parseAnswer(text, 'adopt');
    if (!a.ok) { this.fail(a.reason); return; }
    // The new bridge holds the ticket: the old one lets go of the socket now. Its close is ours, not a drop.
    this.stage = 'bind';
    this.released = true;
    this.arm(HANDOVER_BIND_TIMEOUT_MS);
    const old = this.o.old;
    old.onclose = null;
    old.onerror = null;
    try { old.send(HANDOVER_RELEASE); } catch { /* it is closing: the bind still goes ahead */ }
  }

  private onAdopted(text: string): void {
    const a = parseAnswer(text, 'adopted');
    if (!a.ok) { this.fail(a.reason); return; }
    this.disarm();
    this.finished = true;
    const ws = this.ws!;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onclose = null;
    ws.onerror = null;
    this.o.switchTo(ws, this.early.splice(0));
    this.o.done({ ok: true, ms: Math.round(this.now() - this.started) });
  }

  /** The session is ending some other way (a disconnect, a new login): stop without a result. */
  cancel(): void {
    if (this.finished) return;
    this.finished = true;
    this.disarm();
    this.dropNew();
  }

  private dropNew(): void {
    const ws = this.ws;
    if (!ws) return;
    ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
    try { ws.close(); } catch { /* closing */ }
  }

  private fail(reason: string): void {
    if (this.finished) return;
    this.finished = true;
    this.disarm();
    this.dropNew();
    this.o.done({ ok: false, stage: this.stage, reason, released: this.released, ms: Math.round(this.now() - this.started) });
  }
}

function parseAnswer(text: string, key: 'adopt' | 'adopted'): { ok: boolean; reason: string } {
  try {
    const a = (JSON.parse(text) as Record<string, { ok?: unknown; reason?: unknown } | undefined>)[key];
    return { ok: a?.ok === true, reason: typeof a?.reason === 'string' ? a.reason : 'refused' };
  } catch { return { ok: false, reason: 'malformed' }; }
}
