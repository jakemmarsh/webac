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
  // The frame's top was one 'tags' phase until 2026-10-21 (PERF.agent-tick-cost: 56 and 86 ms of "tags" on two routine
  // users' machines). Split so a report names the subsystem; the page sends only its ten largest phases.
  'nav',      // the frame clock and VirindiTank's nav lines
  'tags',     // UtilityBelt's nametags and the go-arrow
  'agent',    // the agent API's tick (its task, watchers and object diff), less the routine
  'routine',  // the routine engine's tick (VirindiTank's macro and meta) inside the agent tick
  'ub',       // UtilityBelt's tick
  'mag',      // Mag-Tools' tick
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

/**
 * The frame's automation tick (main.ts agentFrameTick), each part marked into its own phase: the agent API's tick
 * ('agent', with the routine engine's share inside it as 'routine'), UtilityBelt's ('ub', only where /ub runs) and
 * Mag-Tools' ('mag'). Time before the call is marked by the caller.
 */
export function timedAgentTick(
  parts: {
    agent: { tick(marks?: { routineStart(): void; routineEnd(): void }): void };
    ub?: { tick(): void } | null;
    ubOn: boolean;
    mag?: { tick(): void } | null;
  },
  mark: (phase: number) => void,
): void {
  parts.agent.tick({ routineStart: () => mark(PHASE.agent), routineEnd: () => mark(PHASE.routine) });
  mark(PHASE.agent);
  if (parts.ubOn) parts.ub?.tick();
  mark(PHASE.ub);
  parts.mag?.tick();
  mark(PHASE.mag);
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

  /** `onCreate`: each new program (CompileTrace.noteProgram). */
  constructor(private readonly onCreate?: (program: unknown, existing: readonly unknown[]) => void) {}

  sample(info: { programs?: unknown[] | null } | null | undefined): number {
    const list = info?.programs;
    if (Array.isArray(list) && list !== this.hooked) {
      this.hooked = list;
      const push = list.push;
      list.push = (...items: unknown[]): number => {
        this.created += items.length;
        if (this.onCreate) for (const p of items) { try { this.onCreate(p, list); } catch { /* diagnostics never break a draw */ } }
        return push.apply(list, items);
      };
    }
    return this.created;
  }
}

/** A frame CompileTrace kept: a long one, or one in which programs were created. */
export interface CompileTraceFrame {
  /** performance.now() at the frame's end. */
  at: number;
  workMs: number;
  warmupMs: number;
  renderMs: number;
  /** "<shaderName>:<cacheKey hash>" per program created since the previous frame ended; "~" marks one created outside frameStep. */
  programs: string[];
  /**
   * For each program created inside a draw (CompileTrace.wrapRenderer): what
   * was being drawn, and how its key differs from the nearest live program of
   * the same material class (comma-field index: that program's value → this one's).
   */
  details?: CompileTraceDetail[];
  /** The portal-space cover was up / the world draw was skipped under it / the teleport animation state / the warm's phase. */
  covered: boolean;
  worldHidden: boolean;
  tunnelState: number;
  warm: string;
}

export interface CompileTraceDetail {
  program: string;
  /** The object drawn: name (or type), then its parents up to the scene, nearest first. */
  object: string;
  parents: string[];
  objectFlags: string;
  /** The material: class, name, and the inputs three.js keys programs on. */
  material: string;
  materialFlags: Record<string, unknown>;
  /** Whether a RendererWarmup cover job compiled this material at some point (false: it arrived after, or never hung in the scene). */
  warmed: boolean | null;
  /** The key fields that differ from the nearest live program of the same class: [index, theirs, ours]. */
  keyDiff: Array<[number, string, string]> | null;
}

/** FNV-1a of a string, 8 hex digits (a program's cache key, short). */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * PERF.firefox-cover-compile-stall — which frame linked which programs. A
 * driver without KHR_parallel_shader_compile links a program in the first
 * draw that reads its uniforms, so a burst shows as a long frame here with
 * the programs created in it, and with what covered the screen. Kept on the
 * page (window.__ac.compileTrace) for live probes; nothing is sent.
 */
interface THREE_Like { name?: string; type?: string; parent?: THREE_Like | null }

export class CompileTrace {
  readonly frames: CompileTraceFrame[] = [];
  private pending: string[] = [];
  private pendingDetails: CompileTraceDetail[] = [];
  private inFrame = false;
  /** The draw three.js is in (wrapRenderer), so a program it creates names its object. */
  private draw: { object: unknown; material: unknown } | null = null;
  /** Answers CompileTraceDetail.warmed (RendererWarmup.compiledMaterial). */
  warmedMaterial: ((m: unknown) => boolean) | null = null;

  constructor(private readonly longFrameMs = 250, private readonly keep = 80) {}

  /**
   * Wrap the renderer's per-draw entry (WebGLRenderer.renderBufferDirect,
   * which renderObject calls through `_this`, just before setProgram) so a
   * program created by a draw is attributed to that object and material.
   */
  wrapRenderer(renderer: { renderBufferDirect: (...args: never[]) => unknown }): void {
    const r = renderer as unknown as { renderBufferDirect: (...args: unknown[]) => unknown };
    const inner = r.renderBufferDirect;
    if ((inner as { compileTraced?: boolean }).compileTraced) return;
    const wrapped = (...args: unknown[]): unknown => {
      this.draw = { material: args[3], object: args[4] };
      try { return inner.apply(renderer, args); } finally { this.draw = null; }
    };
    (wrapped as { compileTraced?: boolean }).compileTraced = true;
    r.renderBufferDirect = wrapped;
  }

  noteProgram(program: unknown, existing: readonly unknown[] = []): void {
    const p = program as { type?: unknown; name?: unknown; cacheKey?: unknown } | null;
    // three.js's shaderType (the material class, e.g. MeshBasicMaterial), else its
    // shaderName (the material's name, usually ''): 2026-10-22's "custom" programs were unnamed materials.
    const name = typeof p?.type === 'string' && p.type ? p.type
      : typeof p?.name === 'string' && p.name ? p.name : 'custom';
    const key = typeof p?.cacheKey === 'string' ? fnv1a(p.cacheKey) : '?';
    const label = `${this.inFrame ? '' : '~'}${name}:${key}`;
    this.pending.push(label);
    if (this.draw) this.pendingDetails.push(this.describe(label, p, existing));
  }

  private describe(label: string, p: { type?: unknown; cacheKey?: unknown } | null, existing: readonly unknown[]): CompileTraceDetail {
    const o = this.draw!.object as THREE_Like | null;
    const m = this.draw!.material as Record<string, unknown> | null;
    const nm = (x: THREE_Like | null) => (x ? (x.name || x.type || '?') : '?');
    const parents: string[] = [];
    for (let q = o?.parent ?? null, i = 0; q && i < 8; q = q.parent ?? null, i++) parents.push(nm(q));
    const geo = (o as { geometry?: { attributes?: Record<string, { itemSize?: number }>; morphAttributes?: Record<string, unknown> } } | null)?.geometry;
    const objectFlags = [
      o?.type ?? '?', (o as { isInstancedMesh?: boolean })?.isInstancedMesh ? 'instanced' : '',
      (o as { isSkinnedMesh?: boolean })?.isSkinnedMesh ? 'skinned' : '',
      geo?.morphAttributes && Object.keys(geo.morphAttributes).length ? 'morph' : '',
      geo?.attributes?.color ? `color${geo.attributes.color.itemSize ?? ''}` : '',
      geo?.attributes?.tangent ? 'tangent' : '',
    ].filter(Boolean).join(',');
    const materialFlags: Record<string, unknown> = {};
    if (m) {
      for (const k of ['side', 'transparent', 'opacity', 'alphaTest', 'vertexColors', 'fog', 'blending', 'depthWrite',
        'premultipliedAlpha', 'flatShading', 'wireframe', 'alphaHash', 'alphaToCoverage', 'dithering', 'forceSinglePass']) {
        if (k in m) materialFlags[k] = m[k];
      }
      for (const k of ['map', 'alphaMap', 'emissiveMap', 'lightMap', 'aoMap', 'specularMap', 'envMap', 'normalMap', 'bumpMap']) {
        if (m[k]) materialFlags[k] = true;
      }
      if (m.defines) materialFlags.defines = m.defines;
      try {
        const ck = (m as { customProgramCacheKey?: () => string }).customProgramCacheKey?.();
        if (ck) materialFlags.customKey = fnv1a(ck);
      } catch { /* ignore */ }
      const ud = m.userData as Record<string, unknown> | undefined;
      if (ud && Object.keys(ud).length) materialFlags.userData = Object.keys(ud).join(',');
    }
    let keyDiff: Array<[number, string, string]> | null = null;
    if (typeof p?.cacheKey === 'string') {
      const ours = p.cacheKey.split(',');
      let best: string[] | null = null;
      let bestN = Infinity;
      for (const e of existing) {
        const q = e as { type?: unknown; cacheKey?: unknown };
        if (q === p || q.type !== p.type || typeof q.cacheKey !== 'string') continue;
        const theirs = q.cacheKey.split(',');
        let n = Math.abs(theirs.length - ours.length);
        for (let i = 0; i < Math.min(theirs.length, ours.length); i++) if (theirs[i] !== ours[i]) n++;
        if (n < bestN) { bestN = n; best = theirs; }
      }
      if (best) {
        keyDiff = [];
        for (let i = 0; i < Math.max(best.length, ours.length) && keyDiff.length < 12; i++) {
          if (best[i] !== ours[i]) keyDiff.push([i, (best[i] ?? '').slice(0, 40), (ours[i] ?? '').slice(0, 40)]);
        }
      }
    }
    let warmed: boolean | null = null;
    try { warmed = this.warmedMaterial && m ? this.warmedMaterial(m) : null; } catch { /* ignore */ }
    return {
      program: label, object: nm(o), parents, objectFlags,
      material: `${(m?.type as string) ?? '?'}${m?.name ? `/${m.name as string}` : ''}`,
      materialFlags, warmed, keyDiff,
    };
  }

  frameBegin(): void { this.inFrame = true; }

  frameEnd(f: Omit<CompileTraceFrame, 'programs'>): void {
    this.inFrame = false;
    if (f.workMs < this.longFrameMs && this.pending.length === 0) return;
    this.frames.push({ ...f, programs: this.pending, ...(this.pendingDetails.length ? { details: this.pendingDetails } : {}) });
    this.pending = [];
    this.pendingDetails = [];
    if (this.frames.length > this.keep) this.frames.splice(0, this.frames.length - this.keep);
  }

  /** The longest kept frames first (for a probe's report). */
  longest(n = 5): CompileTraceFrame[] {
    return [...this.frames].sort((a, b) => b.workMs - a.workMs).slice(0, n);
  }
}
