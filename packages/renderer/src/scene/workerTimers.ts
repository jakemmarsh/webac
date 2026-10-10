/**
 * While Claude plays a tab, its timers run on a worker's clock.
 *
 * Chrome throttles a hidden, minimized or covered window's timers to about
 * once a second, and to once a minute after five minutes. The agent's walk
 * steering, its waits and the relay's deadlines all ride page timers, so with
 * Claude Desktop in front a walk barely moved (measured 2026-10-10; the CLI's
 * Playwright browser runs with throttling switched off). This puts the page's
 * setTimeout / setInterval on a dedicated worker's unthrottled clock, the
 * usual remedy. Installed once Claude is switched on in the tab; timers set
 * before keep their native clock (clear* still reaches them).
 */
type Fn = (...args: unknown[]) => void;
export interface TimerHost {
  setTimeout: typeof setTimeout;
  setInterval: typeof setInterval;
  clearTimeout: typeof clearTimeout;
  clearInterval: typeof clearInterval;
}
interface TimerWorker { postMessage(m: { op: 'set' | 'clear'; id: number; ms?: number; repeat?: boolean }): void; onmessage: ((e: MessageEvent<number>) => void) | null }

/** Ids well above any native timer id, so clear* can tell them apart. */
const FIRST_ID = 1_000_000_000;

export function installWorkerTimers(host: TimerHost, makeWorker: () => TimerWorker): boolean {
  if ((host as unknown as { __workerTimers?: boolean }).__workerTimers) return true;
  let worker: TimerWorker;
  try { worker = makeWorker(); } catch { return false; }
  const native = { setTimeout: host.setTimeout, setInterval: host.setInterval, clearTimeout: host.clearTimeout, clearInterval: host.clearInterval };
  const live = new Map<number, { fn: Fn; args: unknown[]; repeat: boolean }>();
  let next = FIRST_ID;
  const arm = (repeat: boolean) => (fn: unknown, ms?: number, ...args: unknown[]) => {
    if (typeof fn !== 'function') return (repeat ? native.setInterval : native.setTimeout)(fn as never, ms, ...args);
    const id = next++;
    live.set(id, { fn: fn as Fn, args, repeat });
    worker.postMessage({ op: 'set', id, ms: Number(ms) || 0, repeat });
    return id;
  };
  const clear = (nativeClear: (id: never) => void) => (id?: unknown) => {
    if (typeof id === 'number' && id >= FIRST_ID) {
      if (live.delete(id)) worker.postMessage({ op: 'clear', id });
      return;
    }
    nativeClear(id as never);
  };
  worker.onmessage = (e) => {
    const t = live.get(e.data);
    if (!t) return;
    if (!t.repeat) live.delete(e.data);
    t.fn(...t.args);
  };
  host.setTimeout = arm(false) as unknown as typeof setTimeout;
  host.setInterval = arm(true) as unknown as typeof setInterval;
  host.clearTimeout = clear(native.clearTimeout) as typeof clearTimeout;
  host.clearInterval = clear(native.clearInterval) as typeof clearInterval;
  (host as unknown as { __workerTimers?: boolean }).__workerTimers = true;
  return true;
}

export const makeTimersWorker = (): TimerWorker =>
  new Worker(new URL('./timers.worker.ts', import.meta.url), { type: 'module', name: 'acjs-timers' }) as unknown as TimerWorker;
