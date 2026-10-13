/**
 * Server-side feed plumbing for the stream overlay: JSONL parsing, a polling file tailer that
 * survives partial lines / truncation / rotation, a replay ring buffer and Server-Sent-Events framing.
 * Pure Node (no external deps) so tests drive it directly.
 */
import { closeSync, openSync, readSync, statSync } from 'node:fs';
import { FEED_EVENT_TYPES, FEED_VERSION, type FeedEvent } from './feed-types.ts';

/** Parse one JSONL line. Returns null for blank, malformed, wrong-version or unknown-type lines. */
export function parseFeedLine(line: string): FeedEvent | null {
  const s = line.trim();
  if (!s) return null;
  let o: unknown;
  try { o = JSON.parse(s); } catch { return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const ev = o as Record<string, unknown>;
  if (ev.v !== FEED_VERSION) return null;
  if (typeof ev.t !== 'number' || !Number.isFinite(ev.t)) return null;
  if (typeof ev.type !== 'string' || !(FEED_EVENT_TYPES as readonly string[]).includes(ev.type)) return null;
  if (ev.type !== 'session-start' && !(ev.type === 'segment-start' || ev.type === 'segment-end') && typeof ev.char !== 'string') return null;
  return ev as unknown as FeedEvent;
}

/**
 * Split a pending partial line plus a new chunk into complete lines and the new remainder.
 * Handles CRLF; the remainder is whatever follows the last '\n'.
 */
export function splitLines(pending: string, chunk: string): { lines: string[]; rest: string } {
  const all = pending + chunk;
  const parts = all.split('\n');
  const rest = parts.pop() ?? '';
  return { lines: parts.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l)), rest };
}

/** A feed event plus the server-assigned sequence number (the SSE id). */
export interface SeqEvent { seq: number; ev: FeedEvent }

/** Fixed-capacity ring of the most recent events, for replay on (re)connect. */
export class ReplayBuffer {
  private items: SeqEvent[] = [];
  private nextSeq = 1;
  constructor(readonly capacity: number) {}

  push(ev: FeedEvent): SeqEvent {
    const item = { seq: this.nextSeq++, ev };
    this.items.push(item);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
    return item;
  }

  /** The last n events (all buffered when n >= size). */
  last(n = this.capacity): SeqEvent[] { return n <= 0 ? [] : this.items.slice(-n); }

  /**
   * Events after `seq` for a reconnecting client, or null when that client can't be caught up
   * exactly (its id is unknown to this buffer: older than the buffer, or from a previous server run)
   * and needs a reset + full replay instead.
   */
  since(seq: number): SeqEvent[] | null {
    if (!Number.isFinite(seq) || seq < 0 || seq >= this.nextSeq) return null;
    if (seq === this.nextSeq - 1) return [];
    const first = this.items[0];
    if (!first || seq < first.seq - 1) return null;
    return this.items.filter((i) => i.seq > seq);
  }

  get size(): number { return this.items.length; }
  get lastSeq(): number { return this.nextSeq - 1; }
}

/** One SSE frame. Multi-line data is split across `data:` lines, as the spec requires. */
export function formatSse(frame: { event?: string; id?: number | string; data?: string; retry?: number; comment?: string }): string {
  let out = '';
  if (frame.comment !== undefined) for (const l of frame.comment.split(/\r?\n/)) out += `: ${l}\n`;
  if (frame.retry !== undefined) out += `retry: ${frame.retry}\n`;
  if (frame.event !== undefined) out += `event: ${frame.event.replace(/[\r\n]/g, '')}\n`;
  if (frame.id !== undefined) out += `id: ${String(frame.id).replace(/[\r\n]/g, '')}\n`;
  if (frame.data !== undefined) for (const l of frame.data.split(/\r\n|\r|\n/)) out += `data: ${l}\n`;
  return out + '\n';
}

/**
 * The SSE frame for a feed event: event name `feed`, id `<runId>.<seq>` (so a client reconnecting to a
 * restarted server is recognised and reset), data = the event JSON.
 */
export function feedFrame(item: SeqEvent, runId: string): string {
  return formatSse({ event: 'feed', id: `${runId}.${item.seq}`, data: JSON.stringify(item.ev) });
}

/** The seq from a Last-Event-ID header if it belongs to this server run, else null. */
export function parseLastEventId(header: string | undefined | null, runId: string): number | null {
  if (!header) return null;
  const m = /^([^.]+)\.(\d+)$/.exec(header.trim());
  if (!m || m[1] !== runId) return null;
  return Number(m[2]);
}

export interface TailerOptions {
  /** Called for every parsed event, in file order. */
  onEvent: (ev: FeedEvent) => void;
  /** Called when the file was truncated or replaced (rotation). */
  onRotate?: () => void;
  /** On first open, start at most this many bytes before the end (skipping the first partial line). Default 4 MiB. */
  maxBacklogBytes?: number;
}

/**
 * Polling tailer for an append-only JSONL file. Call {@link poll} on a timer (or {@link start}).
 * Missing file = wait for it. Size shrinking below our offset, or a new inode, = rotation:
 * the partial line is dropped and the new file is read from its start.
 */
export class FeedTailer {
  private offset = 0;
  private ino: number | null = null;
  private pending = '';
  private opened = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private decoder = new TextDecoder('utf-8');

  constructor(readonly path: string, private readonly opts: TailerOptions) {}

  /** Read whatever is new. Returns the number of events emitted. Synchronous, so tests can step it. */
  poll(): number {
    let st;
    try { st = statSync(this.path); } catch { return 0; }
    if (!st.isFile()) return 0;
    let skipFirstLine = false;
    if (!this.opened) {
      this.opened = true;
      this.ino = st.ino;
      const max = this.opts.maxBacklogBytes ?? 4 * 1024 * 1024;
      if (st.size > max) { this.offset = st.size - max; skipFirstLine = true; }
    } else if (st.ino !== this.ino || st.size < this.offset) {
      this.ino = st.ino;
      this.offset = 0;
      this.pending = '';
      this.decoder = new TextDecoder('utf-8');
      this.opts.onRotate?.();
    }
    if (st.size <= this.offset) return 0;
    const len = st.size - this.offset;
    const buf = Buffer.alloc(len);
    const fd = openSync(this.path, 'r');
    let got = 0;
    try { got = readSync(fd, buf, 0, len, this.offset); } finally { closeSync(fd); }
    this.offset += got;
    let chunk = this.decoder.decode(buf.subarray(0, got), { stream: true });
    if (skipFirstLine) {
      const nl = chunk.indexOf('\n');
      chunk = nl < 0 ? '' : chunk.slice(nl + 1);
    }
    const { lines, rest } = splitLines(this.pending, chunk);
    this.pending = rest;
    let n = 0;
    for (const line of lines) {
      const ev = parseFeedLine(line);
      if (ev) { this.opts.onEvent(ev); n++; }
    }
    return n;
  }

  start(intervalMs = 250): void {
    if (this.timer) return;
    this.poll();
    this.timer = setInterval(() => { try { this.poll(); } catch { /* transient read error: retry next tick */ } }, intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
