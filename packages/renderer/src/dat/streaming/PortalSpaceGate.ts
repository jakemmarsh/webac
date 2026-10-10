/**
 * RELEASE.portal-space-cell-gate — the retail portal-space loading gate.
 *
 * Retail (reference/client-eol/decomp/acclient-decompiled.annotated.c):
 *  - SmartBox::HandlePlayerTeleport @ 00452150 clears position_update_complete
 *    and sets waiting_for_teleport;
 *  - SmartBox::UseTime @ 00455410 does nothing but CellManager::CheckPrefetchStatus
 *    while cell_manager->blocking_for_cells is set (object maintenance, physics
 *    and LScape stop), and only after it clears runs ChangePosition and sets
 *    position_update_complete / has_been_teleported;
 *  - gmSmartBoxUI::UseTime @ 004d6e30 keeps TAS_TUNNEL running while
 *    SmartBox::teleport_in_progress() (player && !position_update_complete);
 *  - CellManager::PreFetchCells @ 00455820 prefetches the destination (outdoors
 *    LScape::PreFetchCells over the landblock grid around it, indoors the cell
 *    and its visible cells), blocks when anything is missing and emits
 *    ECM_DDD::SendNotice_RuntimeDDDStatus(true, done, total) progress;
 *    CheckPrefetchStatus @ 00455be0 re-polls every 5.0 s (PrefetchStatus).
 *
 * Ours: the session's event stream is the SmartBox. When an event would place
 * our player (login CreateObject, teleport arrival) at a destination whose
 * gate set is not resident, the CellGate prefetches it while
 * GatedEventQueue holds that event and everything after it, in order — the
 * blocking_for_cells stop. The tunnel keeps running (LoginComplete goes out
 * only when the tunnel finishes, so ACE keeps the loading player hidden).
 * When the set is resident the queue drains synchronously and the existing
 * position code runs exactly as it does with whole DATs.
 *
 * With whole-file DATs (local dev, no streaming store) every destination is
 * satisfied and events pass straight through: no behavior change.
 *
 * Safety valve: a gate that has not completed within `timeoutMs` (or whose
 * fetch failed after retries) releases the hold anyway and reports an error,
 * so a dead DAT host can never trap a player in portal space. Whatever is
 * still missing then streams in through the miss/rebuild path.
 */
import type { DatClosure } from './DatClosure.js';
import { type FileKey, FetchPriority } from './DatStore.js';

/** Retail CheckPrefetchStatus re-poll interval: 5.0 s (___real_4014000000000000). */
export const PREFETCH_STATUS_POLL_MS = 5000;
/** How long a gate may hold portal space before releasing with an error. */
export const DEFAULT_GATE_TIMEOUT_MS = 90_000;

export interface GateProgress {
  /** RuntimeDDDStatus(blocking, done, total). */
  blocking: boolean;
  done: number;
  total: number;
}

export type GateOutcome = { ok: true; ms: number } | { ok: false; ms: number; error: Error };

export interface CellGateOptions {
  /** Landblock radius of the outdoor object ring the gate covers (LandblockObjectStreamer.objectRadius). */
  objectRadius: () => number;
  /**
   * Whether a destination is a sealed interior: an EnvCell without
   * SeenOutside (a dungeon). True → the gate holds for its own landblock
   * only, as CellManager::PreFetchCells @ 00455820 sends an EnvCell to
   * CEnvCell::PreFetchCells (the cell and the cells it can see) and only an
   * outdoor cell to LScape::PreFetchCells (the landblock grid). Null while
   * the cell's bundle is not resident (the ring is assumed until it is).
   */
  sealedInterior?: (cellId: number) => boolean | null;
  timeoutMs?: number;
  now?: () => number;
  /**
   * The interface set's closure when it is not the world's (an era whose
   * world is its own DATs: AC1999 under the streamed end-of-retail
   * interface). The gate's `interfaceRoots` (the HUD's layout art) close over
   * it; without it they close over the world closure with the extra roots.
   */
  interfaceClosure?: DatClosure | null;
}

const landblockOf = (cellId: number) => (cellId >>> 16) & 0xffff;

/**
 * The destination prefetch (CellManager::PreFetchCells). `closure` null = the
 * world DATs are whole and resident: every destination is satisfied (the
 * interface roots still wait for `interfaceClosure` when there is one).
 */
export class CellGate {
  constructor(private readonly closure: DatClosure | null, private readonly opts: CellGateOptions) {}

  /** The gate set's landblocks for a destination cell (object ring around its landblock). */
  landblocksFor(cellId: number): number[] {
    const lb = landblockOf(cellId);
    const cx = lb >>> 8, cy = lb & 0xff;
    const r = Math.max(1, this.opts.objectRadius());
    const out: number[] = [];
    for (let dx = -r; dx <= r; dx++) {
      for (let dy = -r; dy <= r; dy++) {
        const bx = cx + dx, by = cy + dy;
        if (bx < 0 || bx > 0xff || by < 0 || by > 0xff) continue;
        out.push((bx << 8) | by);
      }
    }
    return out;
  }

  /** Where `interfaceRoots` close: the interface closure, else the world's (one set serves both). */
  private interfaceSplit(extraRoots: readonly FileKey[], interfaceRoots: readonly FileKey[]): { world: readonly FileKey[]; ui: readonly FileKey[]; uc: DatClosure | null } {
    const uc = this.opts.interfaceClosure ?? null;
    if (uc && uc !== this.closure) return { world: extraRoots, ui: interfaceRoots, uc };
    return { world: interfaceRoots.length ? [...extraRoots, ...interfaceRoots] : extraRoots, ui: [], uc: null };
  }

  /** Synchronous: is the destination's gate set resident (blocking_for_cells would stay false)? */
  isSatisfied(cellId: number, extraRoots: readonly FileKey[] = [], interfaceRoots: readonly FileKey[] = []): boolean {
    const { world, ui, uc } = this.interfaceSplit(extraRoots, interfaceRoots);
    if (uc && !ui.every((k) => uc.isClosed(k))) return false;
    const c = this.closure;
    if (!c) return true;
    const blocks = this.opts.sealedInterior?.(cellId) === true ? [landblockOf(cellId)] : this.landblocksFor(cellId);
    if (!blocks.every((lb) => c.isLandblockReady(lb))) return false;
    return world.every((k) => c.isClosed(k));
  }

  /**
   * Prefetch the destination's gate set (+ extra roots: our player's model,
   * objects already created there). Never rejects: a timeout or failed fetch
   * resolves { ok: false } so the caller releases the hold and reports it.
   */
  async prefetch(cellId: number, extraRoots: readonly FileKey[] = [], interfaceRoots: readonly FileKey[] = []): Promise<GateOutcome> {
    const now = this.opts.now ?? (() => performance.now());
    const t0 = now();
    const c = this.closure;
    if (this.isSatisfied(cellId, extraRoots, interfaceRoots)) return { ok: true, ms: 0 };
    const { world, ui, uc } = this.interfaceSplit(extraRoots, interfaceRoots);
    const blocks = c ? this.landblocksFor(cellId) : [];
    let done = 0;
    const total = blocks.length + (c && world.length > 0 ? 1 : 0) + (uc && ui.length > 0 ? 1 : 0);
    // The destination's own landblock first, then the ring, then the extras.
    const work = Promise.all([
      (async () => {
        if (!c) return;
        const own = landblockOf(cellId);
        await c.ensureLandblock(own, FetchPriority.Critical);
        done++;
        // A sealed interior (a dungeon) needs no landblock ring: its neighbours are other dungeons.
        // (A new character's training academy pulled three unrelated dungeon tiles, 21.8 MB, 2026-10-09.)
        if (this.opts.sealedInterior?.(cellId) !== true) await Promise.all(blocks.filter((lb) => lb !== own).map((lb) => c.ensureLandblock(lb, FetchPriority.Critical).then(() => { done++; })));
        if (world.length > 0) { await c.ensure(world, FetchPriority.Critical); done++; }
      })(),
      uc && ui.length > 0 ? uc.ensure(ui, FetchPriority.Critical).then(() => { done++; }) : undefined,
    ]);
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeoutMs = this.opts.timeoutMs ?? DEFAULT_GATE_TIMEOUT_MS;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`portal-space gate timed out after ${timeoutMs} ms (${done}/${total} done)`)), timeoutMs);
    });
    try {
      await Promise.race([work, timeout]);
      return { ok: true, ms: now() - t0 };
    } catch (err) {
      work.catch(() => { /* keep streaming in the background; misses rebuild on arrival */ });
      return { ok: false, ms: now() - t0, error: err instanceof Error ? err : new Error(String(err)) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

/**
 * The power bar's download count while portal space holds
 * (RELEASE.streaming-memory-and-progress; retail CellManager's DDD status):
 *
 * - CellManager::PreFetchCells @ 00455820, while blocking_for_cells: with
 *   `missing` cells still to come (only when non-zero), the first report sets
 *   total_num_cells_waiting = missing and sends (true, 0, total); later ones
 *   raise the total if more is missing and send (true, total − missing, total).
 * - CheckPrefetchStatus @ 00455be0 runs that check once 5.0 s have passed
 *   since the last (___real_4014000000000000 = 5.0).
 * - Clearing blocking_for_cells (PreFetchCells, CellManager::Reset @ 00455930)
 *   sends (false, 0, 0) and zeroes both counters.
 *
 * Retail's unit was the cell files missing from the install; ours is the
 * object downloads the hold is waiting on (`waiting`: DatStore.activeLoads).
 * It spans the whole hold: the world packs a cold login waits for, the
 * destination's landblocks and models, and the objects the server created
 * there, so the bar never vanishes while the tunnel keeps running.
 */
export class PrefetchStatus {
  private blocking = false;
  private total = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly opts: {
    /** Downloads the hold is waiting on right now. */
    waiting: () => number;
    /** ECM_DDD::SendNotice_RuntimeDDDStatus(blocking, done, total). */
    onProgress: (p: GateProgress) => void;
    /** Re-check interval (retail 5 s). */
    pollMs?: number;
  }) {}

  get isBlocking(): boolean { return this.blocking; }

  /** blocking_for_cells set: check now, then every pollMs. */
  begin(): void {
    if (this.blocking) return;
    this.blocking = true;
    this.check();
    this.timer = setInterval(() => this.check(), this.opts.pollMs ?? PREFETCH_STATUS_POLL_MS);
  }

  /** PreFetchCells' report (also right after a prefetch is issued, as retail's first call counts at once). */
  check(): void {
    if (!this.blocking) return;
    const missing = Math.max(0, Math.floor(this.opts.waiting()));
    if (missing === 0) return;
    let done = 0;
    if (this.total === 0) this.total = missing;
    else {
      if (missing > this.total) this.total = missing;
      done = this.total - missing;
    }
    this.opts.onProgress({ blocking: true, done, total: this.total });
  }

  /** blocking_for_cells cleared: (false, 0, 0), counters zeroed. */
  end(): void {
    if (!this.blocking) return;
    this.blocking = false;
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.total = 0;
    this.opts.onProgress({ blocking: false, done: 0, total: 0 });
  }
}

export interface GatedEventQueueOptions<E> {
  /** The real event handler (main.ts's session listener). */
  dispatch: (event: E) => void;
  /**
   * Called for each event about to be dispatched (live or from the queue).
   * Returns a promise to hold this event and everything after it until it
   * settles, or null to dispatch now. Evaluated just before dispatch, so it
   * sees the state every earlier event left behind.
   */
  gateFor: (event: E) => Promise<unknown> | null;
  /** Events dispatched immediately even while holding (connection lifecycle). */
  passThrough?: (event: E) => boolean;
  /**
   * Before a hold releases: one more prefetch over the queued events (the
   * objects the server created at the destination meanwhile), or null.
   * `queued()` is live: events keep queuing while the promise runs.
   */
  beforeRelease?: (queued: () => readonly E[]) => Promise<unknown> | null;
  /** After a hold's gating event has been dispatched. */
  afterRelease?: () => void;
}

/** The blocking_for_cells stop: holds the session's events while a gate prefetches. */
export class GatedEventQueue<E> {
  private readonly queue: E[] = [];
  private holding = false;
  /** Holds started (tests / probes). */
  holds = 0;

  constructor(private readonly opts: GatedEventQueueOptions<E>) {}

  get isHolding(): boolean { return this.holding; }
  get queuedCount(): number { return this.queue.length; }

  /** The listener to register on the session. */
  readonly push = (event: E): void => {
    if (this.holding) {
      if (this.opts.passThrough?.(event)) this.opts.dispatch(event);
      else this.queue.push(event);
      return;
    }
    this.queue.push(event);
    this.drain();
  };

  /** Drop everything held (the session ended). */
  clear(): void {
    this.queue.length = 0;
    this.holding = false;
  }

  private drain(): void {
    while (this.queue.length > 0 && !this.holding) {
      const event = this.queue[0];
      let gate: Promise<unknown> | null = null;
      try { gate = this.opts.gateFor(event); } catch { gate = null; }
      if (gate) {
        this.hold(gate);
        return;
      }
      this.queue.shift();
      this.opts.dispatch(event);
    }
  }

  private hold(gate: Promise<unknown>): void {
    this.holding = true;
    this.holds++;
    const release = () => {
      if (!this.holding) return; // cleared meanwhile
      this.holding = false;
      // The gating event itself dispatches now (its gate is satisfied or gave up).
      const event = this.queue.shift();
      try {
        if (event !== undefined) this.opts.dispatch(event);
      } finally {
        this.opts.afterRelease?.();
      }
      this.drain();
    };
    gate
      .catch(() => undefined)
      .then(() => {
        if (!this.holding) return undefined;
        const extra = this.opts.beforeRelease?.(() => this.queue.slice(1)) ?? null;
        return extra ? extra.catch(() => undefined) : undefined;
      })
      .then(release, release);
  }
}

/**
 * Resolve once `count()` has not changed for `quietMs`, or after `maxMs`.
 * The gate uses it to let the server's CreateObject burst for a destination
 * (it follows the arrival position) queue up before prefetching those
 * objects' models, so they build once, complete, instead of building
 * incomplete and rebuilding on arrival.
 */
export async function settleBurst(
  count: () => number,
  opts: { quietMs: number; maxMs: number; pollMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<number> {
  const now = opts.now ?? (() => performance.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const t0 = now();
  let last = count();
  let quietSince = t0;
  while (now() - t0 < opts.maxMs && now() - quietSince < opts.quietMs) {
    await sleep(opts.pollMs ?? 50);
    const n = count();
    if (n !== last) { last = n; quietSince = now(); }
  }
  return last;
}
