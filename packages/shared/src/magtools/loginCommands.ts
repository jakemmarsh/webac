/**
 * Mag-Tools' On Login / On Login Complete / Periodic commands (docs/plugin-specs/magtools.md §4,
 * §7.3, §9.4), rebuilt from the spec (clean room). UI-free: the lists over the option store, and
 * a scheduler driven by the login events, a 20 s timer and the rendered frames.
 *
 * Timing (spec §9.4):
 * - Each login event queues a placeholder, then the character list, then the server list; the
 *   queue runs one entry per rendered frame, so the placeholder gives one empty frame first.
 * - Periodic: a 20 s timer starts at Login Complete and does its work once per clock minute. With
 *   m = minutes since local midnight, a command runs when (m + offset) % interval == 0 (the offset is
 *   added: upstream's contract, spec §12 #15). Character commands queue before server commands,
 *   each on its own frame.
 * - A command starting `/mt` (any case) runs through the `/mt` handler; anything else is sent as
 *   typed chat (so other plugins see it).
 */
import { mtCommandListKey, type MtCommandList, type MtOptionStorage } from './options.js';

export interface MtPeriodicCommand { command: string; /** Minutes, > 0. */ interval: number; /** Minutes, ≥ 0. */ offset: number }

export type MtCommandScope = { account: string; server: string; character: string } | { server: string };

/** A list as stored: JSON string[] (On Login / On Login Complete) or MtPeriodicCommand[] (Periodic) under mtCommandListKey. */
export function readMtCommands(store: MtOptionStorage, list: 'OnLoginCommands' | 'OnLoginCompleteCommands', scope: MtCommandScope): string[];
export function readMtCommands(store: MtOptionStorage, list: 'PeriodicCommands', scope: MtCommandScope): MtPeriodicCommand[];
export function readMtCommands(store: MtOptionStorage, list: MtCommandList, scope: MtCommandScope): string[] | MtPeriodicCommand[] {
  const raw = store.get(mtCommandListKey(list, scope));
  let v: unknown = [];
  try { v = raw ? JSON.parse(raw) : []; } catch { v = []; }
  if (!Array.isArray(v)) return [];
  if (list !== 'PeriodicCommands') return v.filter((x): x is string => typeof x === 'string' && x !== '');
  return v.filter((x): x is MtPeriodicCommand => !!x && typeof x === 'object'
    && typeof (x as MtPeriodicCommand).command === 'string' && (x as MtPeriodicCommand).command !== ''
    && Number.isInteger((x as MtPeriodicCommand).interval) && (x as MtPeriodicCommand).interval > 0
    && Number.isInteger((x as MtPeriodicCommand).offset) && (x as MtPeriodicCommand).offset >= 0);
}

export function writeMtCommands(store: MtOptionStorage, list: MtCommandList, scope: MtCommandScope, items: readonly string[] | readonly MtPeriodicCommand[]): void {
  store.set(mtCommandListKey(list, scope), JSON.stringify(items));
}

/** The Add button's check for a periodic command: non-empty text, an integer interval > 0, an integer offset ≥ 0 (the edits are text). */
export function mtParsePeriodic(command: string, interval: string, offset: string): MtPeriodicCommand | null {
  if (command === '' || !/^\s*[+-]?\d+\s*$/.test(interval) || !/^\s*[+-]?\d+\s*$/.test(offset)) return null;
  const iv = Number(interval), of = Number(offset);
  return iv > 0 && of >= 0 ? { command, interval: iv, offset: of } : null;
}

/** Whether a periodic command is due in clock minute `m` (minutes since local midnight). */
export function mtPeriodicDue(c: MtPeriodicCommand, m: number): boolean {
  return (m + c.offset) % c.interval === 0;
}

export interface MtLoginCommandsHost {
  /** The character's lists (Tools → Character), and the server's (Tools → Server). */
  characterScope(): MtCommandScope;
  serverScope(): MtCommandScope;
  store: MtOptionStorage;
  /** Run a `/mt …` command through the `/mt` handler. */
  runMt(command: string): void;
  /** Send anything else as if typed in chat (other plugins and the game see it). */
  sendChat(command: string): void;
}

/** The 20 s periodic timer. */
export const MT_PERIODIC_TIMER_MS = 20000;

export class MtLoginCommands {
  /** null = the placeholder (an empty frame). */
  private queue: Array<string | null> = [];
  private periodicFrom: number | null = null;
  private lastTickAt = -Infinity;
  private lastMinute: number | null = null;

  constructor(private readonly host: MtLoginCommandsHost) {}

  /** Pending entries (placeholders included). */
  get pending(): number { return this.queue.length; }

  private queueList(list: 'OnLoginCommands' | 'OnLoginCompleteCommands'): void {
    this.queue.push(null,
      ...readMtCommands(this.host.store, list, this.host.characterScope()),
      ...readMtCommands(this.host.store, list, this.host.serverScope()));
  }

  /** The character logged in (the server's login, before the world is up). */
  login(): void { this.queueList('OnLoginCommands'); }

  /** The world has loaded (our LoginComplete); `nowMs` starts the periodic timer. */
  loginComplete(nowMs: number): void {
    this.queueList('OnLoginCompleteCommands');
    this.periodicFrom = nowMs;
    this.lastTickAt = nowMs;
    this.lastMinute = null;
  }

  /** Logged out: drop what's queued and stop the timer. */
  logout(): void { this.queue = []; this.periodicFrom = null; this.lastMinute = null; }

  /**
   * Time passes (call it often; it acts on 20 s ticks after Login Complete). `minuteOfDay` is the
   * local clock's minutes since midnight. A minute is worked once.
   */
  tick(nowMs: number, minuteOfDay: number): void {
    if (this.periodicFrom === null || nowMs - this.lastTickAt < MT_PERIODIC_TIMER_MS) return;
    this.lastTickAt = nowMs;
    if (minuteOfDay === this.lastMinute) return;
    this.lastMinute = minuteOfDay;
    for (const scope of [this.host.characterScope(), this.host.serverScope()]) {
      for (const c of readMtCommands(this.host.store, 'PeriodicCommands', scope)) if (mtPeriodicDue(c, minuteOfDay)) this.queue.push(c.command);
    }
  }

  /** A rendered frame: run one queued entry. Returns the command run, '' for the placeholder, null when the queue is empty. */
  frame(): string | null {
    if (!this.queue.length) return null;
    const c = this.queue.shift()!;
    if (c === null) return '';
    if (/^\/mt/i.test(c)) this.host.runMt(c); else this.host.sendChat(c);
    return c;
  }
}

/** Minutes since local midnight for a Date. */
export function mtMinuteOfDay(d: Date): number { return d.getHours() * 60 + d.getMinutes(); }
