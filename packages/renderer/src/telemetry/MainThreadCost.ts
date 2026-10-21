/**
 * PERF.slow-first-minute-diagnostics (2026-10-20) — which part of our code a
 * slow first minute spent its main thread in. Production (build ac62d477): a
 * Windows RX 7900 XTX machine ran Yaraq at 294 ms frames with frameStep's own
 * JS at 117 ms and 34.6 s of long tasks in the minute, so ~22 s ran OUTSIDE
 * frameStep; the same player is 16 ms a frame in other sessions. The
 * first_minute event (WorldReporter) now carries:
 *
 *  - FramePhaseTimer: frameStep split into named phases (a performance.now()
 *    at each phase boundary, about a dozen a frame; preallocated storage).
 *  - HandlerMeter: the synchronous cost of the server-message dispatch
 *    (main.ts onSessionEvent: CreateObject / UpdateObject handling and the
 *    model builds it runs) and of streamed-DAT landings (packs parsed, rebuild
 *    on arrival), the two main-thread paths that run outside frameStep.
 *    Promise continuations a handler schedules run after it returns and are
 *    not in its time (they show in the long tasks).
 *  - ProgramCreationCounter: WebGL programs three.js created, to catch
 *    programs thrown away and rebuilt (each one is a shader compile + link).
 */

/** frameStep's phases, in the order they run (main.ts). A phase may be marked more than once a frame. */
export const FRAME_PHASES = [
  'tags',     // nav lines, nametags, the go-arrow, the agent tick
  'physics',  // building-collision refresh, input, movement, MoveTo, range checks, ground, jump / fall
  'sweep',    // ResourceSweep: unused pooled meshes / materials / textures released
  'anim',     // object maintenance, creature animation, building shells
  'sync',     // movement sync to the server
  'camera',   // the camera rig and its collision sweeps
  'fx',       // sky, particles, physics scripts, ambient sound, the game-logic tick
  'stream',   // terrain / landblock-object / dungeon-cell streaming, current-cell tracking
  'hud',      // HUD, panels, radar, selection
  'lod',      // degrade levels, pool LOD, the DAT light budget
  'warmup',   // RendererWarmup: texture uploads, compileAsync
  'render',   // the indoor view + renderer.render
] as const;
export type FramePhase = typeof FRAME_PHASES[number];
export const PHASE: { readonly [K in FramePhase]: number } = Object.fromEntries(FRAME_PHASES.map((p, i) => [p, i])) as { [K in FramePhase]: number };

/** One frame's phase times: begin() at the frame's start, mark(phase) at the end of each phase. */
export class FramePhaseTimer {
  /** This frame's ms per phase (FRAME_PHASES order); valid until the next begin(). */
  readonly frameMs = new Float64Array(FRAME_PHASES.length);
  private last = 0;
  constructor(private readonly clock: () => number = () => performance.now()) {}

  begin(at: number = this.clock()): void {
    this.frameMs.fill(0);
    this.last = at;
  }

  /** The time since the previous mark (or begin) belongs to `phase`. */
  mark(phase: number): void {
    const t = this.clock();
    this.frameMs[phase] += t - this.last;
    this.last = t;
  }
}

/** An op token as sent: letters, digits, ':' and '_', at most 24 characters. */
export function opToken(op: string): string {
  const t = op.replace(/[^A-Za-z0-9:_]/g, '').slice(0, 24);
  return t || 'other';
}

/** Nesting depth over every meter: a timed call inside another is counted only in the outer one. */
let depth = 0;

/** The synchronous main-thread time of one kind of handler. */
export class HandlerMeter {
  totalMs = 0;
  calls = 0;
  longestMs = 0;
  longestOp: string | null = null;
  constructor(private readonly clock: () => number = () => performance.now()) {}

  reset(): void {
    this.totalMs = 0;
    this.calls = 0;
    this.longestMs = 0;
    this.longestOp = null;
  }

  add(ms: number, op: string | (() => string)): void {
    if (!(ms >= 0) || !Number.isFinite(ms)) return;
    this.totalMs += ms;
    this.calls++;
    if (ms > this.longestMs) {
      this.longestMs = ms;
      this.longestOp = opToken(typeof op === 'function' ? op() : op);
    }
  }

  /** Run `fn`, adding its time under `op` (a function is called only for a new longest). */
  time<T>(op: string | (() => string), fn: () => T): T {
    if (depth > 0) return fn();
    depth++;
    const t0 = this.clock();
    try {
      return fn();
    } finally {
      depth--;
      this.add(this.clock() - t0, op);
    }
  }
}

/** main.ts onSessionEvent: every server message / connection event the page handles. */
export const netHandlerCost = new HandlerMeter();
/** Streamed-DAT landings (DatStore) and rebuilds on arrival (StreamingDats / RetryOnArrival). */
export const streamHandlerCost = new HandlerMeter();

/** The op token of a connection event: its type, with a message's opcode or a game event's type in hex. */
export function connectionEventOp(e: { type: string; data?: unknown }): string {
  const d = e.data as { type?: string; opcode?: number; eventType?: number } | null | undefined;
  if (e.type === 'gameEvent' && d && typeof d.eventType === 'number') return `ge:${(d.eventType >>> 0).toString(16)}`;
  if (e.type === 'message' && d && typeof d.opcode === 'number') return `m:${(d.opcode >>> 0).toString(16)}`;
  return e.type;
}

/**
 * WebGL programs three.js created: its WebGLPrograms list (renderer.info.programs, the
 * array acquireProgram pushes a NEW program onto; a cached one is only re-counted) gets a
 * counting push. sample() re-hooks after a context restore replaced the list.
 */
export class ProgramCreationCounter {
  created = 0;
  private hooked: unknown[] | null = null;

  sample(info: { programs?: unknown[] | null } | null | undefined): number {
    const list = info?.programs;
    if (Array.isArray(list) && list !== this.hooked) {
      this.hooked = list;
      const push = list.push;
      list.push = (...items: unknown[]): number => {
        this.created += items.length;
        return push.apply(list, items);
      };
    }
    return this.created;
  }
}
