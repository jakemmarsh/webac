/**
 * The boot side of DAT streaming (RELEASE.dat-streaming phase 3): open the
 * set named by the runtime config's `datSet`, hand main.ts four ordinary
 * DatDatabases, and own the closure walker + portal-space gate that keep
 * them fed. main.ts keeps its raw whole-DAT path when no set is configured
 * (local dev with Vite serving dat/, tests, tools).
 *
 * Boot order (docs/dat-streaming.md §5 phase 1 item 4, §6.6):
 *   pointer → manifest + boot + local + skeleton packs (splash, fonts, tables,
 *             strings, every structural file the pre-world code parses)
 *           → the pre-world layouts' art (PREWORLD_LAYOUTS: launcher, char
 *             select, dialogs) — open() resolves here: the character screen
 *             can draw with no streamed miss
 *           → world + terrain packs in the background (`worldPacks`): GameUI's
 *             preload art, chargen, the terrain materials, portal space. main()
 *             defers what needs them and awaits `worldPacks` before chargen and
 *             before entering the world (at the latest in the login gate).
 */
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { parseMasterProperty, setMasterPropertyTypes } from '@ac/dat-parser/file-types/LayoutDesc.js';
import type { RegionDesc } from '@ac/dat-parser/file-types/RegionDesc.js';
import type { PackRole } from '@ac/dat-parser/streaming/DatSetFormat.js';
import { DatClosure, layoutArtIds } from './DatClosure.js';
import { DatStore, type DatStoreOptions, FetchPriority, type FileKey, type MissScope, fileKey, splitFileKey } from './DatStore.js';
import { type ObjectCache, NullObjectCache, OpfsObjectCache } from './ObjectCache.js';
import { streamHandlerCost } from '../../telemetry/MainThreadCost.js';
import { type BootWatchEnv, startBootWatch } from './BootWatch.js';

export interface StreamingDats {
  store: DatStore;
  closure: DatClosure;
  portal: DatDatabase;
  cell: DatDatabase;
  local: DatDatabase;
  highres: DatDatabase;
  /** Late-bound inputs of the closure walker (RegionDesc is parsed after boot). */
  setRegionDesc(r: RegionDesc | null): void;
  setWantsHighRes(fn: () => boolean): void;
  /**
   * Run a synchronous build; when it missed files, call `rebuild` once they
   * (and the closure of `roots`, so one rebuild sees every dependent file)
   * are resident — the "rebuild on arrival" hook. Returns the build's result.
   * The rebuild runs in a miss scope of its own and is redone when it misses
   * in turn (rebuildOnArrival, at most MAX_STREAMED_REBUILDS times).
   */
  buildOrRebuild<T>(build: () => T, rebuild: () => void, roots?: readonly FileKey[]): T;
  /**
   * Run a synchronous probe: null when it read every file it wanted, else a
   * promise that resolves once the missed files and the closure of `roots`
   * are resident — for work that must wait rather than draw incomplete (a
   * particle emitter without its sprite draws white squares).
   */
  pendingFor(probe: () => unknown, roots?: readonly FileKey[]): Promise<void> | null;
  /**
   * The LayoutDescs' portal art (layoutArtIds) as closure roots, computed once.
   * Call after MasterProperty is registered.
   */
  uiArtRoots(): readonly FileKey[];
  /**
   * Kept for callers: the UI art now loads as part of `uiArtReady` (started
   * at open()); returns it.
   */
  prefetchUiArt(): Promise<void>;
  /**
   * Every LayoutDesc's art (uiArtRoots) resident, fetched right after the
   * world packs (and the 'ui' pack, when the set has one) so it never
   * re-downloads their files as leaves. main() awaits it with the world
   * packs before entering the world: the login gate then waits for the
   * destination only, as when the art loaded before char select. Never rejects.
   */
  uiArtReady: Promise<void>;
  /** The world + terrain packs (background after open()); rejects if a fetch fails after retries. */
  worldPacks: Promise<void>;
  /** Whether `worldPacks` has resolved. */
  worldPacksResident(): boolean;
  /**
   * What open() awaited before resolving, for probes and the docs. `worldCached`:
   * the world + terrain packs were already in the object cache (a warm
   * profile), so open() also awaited them and the UI art — no download to hide
   * behind char select, and main() builds the world up front as with whole DATs.
   * `worldCacheMs`: how much of `ms` that warm-cache wait took (0 when not worldCached).
   */
  readonly bootReport: StreamingBootReport;
}

/**
 * The LayoutDescs the pre-world screens draw (art fetched before open()
 * resolves): 0x21000004 = character select and the launcher (+ its
 * 0x21000040 button templates, reached through baseLayout), 0x21000042 =
 * DialogFactory (the connecting "Please Wait" plate, message / confirm
 * dialogs), 0x2100003c = the text-entry dialog. The patch splash 0x21000000
 * draws from the boot pack.
 */
export const PREWORLD_LAYOUTS: readonly number[] = [0x21000004, 0x21000042, 0x2100003c];

/** What openStreamingDats awaited before resolving (StreamingDats.bootReport). */
export interface StreamingBootReport {
  netBytes: number;
  netObjects: number;
  cacheBytes: number;
  cacheObjects: number;
  preWorldArtFiles: number;
  ms: number;
  worldCached: boolean;
  worldCacheMs: number;
  /** Where `ms` went (PERF.warm-boot-slow-breakdown). */
  phases: StreamBootPhases;
}

/**
 * PERF.warm-boot-slow-breakdown — openStreamingDats's time, step by step, and
 * what the page and the object cache did meanwhile. Numbers only (no URLs,
 * hashes or ids). The steps run in this order, each timed from its own start:
 *
 *   pointerMs   the set pointer: the one network request a warm boot awaits
 *               (pointerTries attempts, pointerBytes of JSON; not in netBytes)
 *   manifestMs  then the manifest (by hash, cache or network) parsed
 *   packsMs     then (from the same start) the boot / local / skeleton packs resident
 *   splashMs    of which, the onBootPacks hook (the DAT splash, built synchronously)
 *   layoutMs    MasterProperty + the pre-world layouts' art list (synchronous)
 *   artMs       the pre-world art's closure resident (artFiles roots)
 *   hasMs       the warm-profile check (are the world packs in the cache)
 *   worldCacheMs (on the report itself) the warm world + UI art wait
 *
 * Alongside: dirMs (opening OPFS: getDirectory + the objects directory),
 * the object cache's cacheReadMs (summed over objects) / cacheReadMaxMs /
 * cacheMisses, inflateMs (gunzip + hash check, summed), the network's
 * retries / failures / rcvBytes (body bytes received, failed attempts
 * included), and the page's lagMs / lagMaxMs (main thread blocked) and
 * hiddenMs (a background tab) — BootWatch.
 */
export interface StreamBootPhases {
  pointerMs: number;
  pointerTries: number;
  pointerBytes: number;
  dirMs: number;
  manifestMs: number;
  packsMs: number;
  splashMs: number;
  layoutMs: number;
  artMs: number;
  artFiles: number;
  hasMs: number;
  cacheReadMs: number;
  cacheReadMaxMs: number;
  cacheMisses: number;
  inflateMs: number;
  retries: number;
  failures: number;
  rcvBytes: number;
  lagMs: number;
  lagMaxMs: number;
  hiddenMs: number;
}

export interface OpenStreamingOptions {
  pointerUrl: string;
  /** Bypass the OPFS object cache (?nocache). */
  bypassCache?: boolean;
  cache?: ObjectCache;
  fetchObject?: DatStoreOptions['fetchObject'];
  fetchPointer?: DatStoreOptions['fetchPointer'];
  /** gzip bytes done / total over manifest + packs (the patch meter). */
  onProgress?: (doneBytes: number, totalBytes: number) => void;
  /** Called once the boot + local packs are resident (the splash can draw). */
  onBootPacks?: (store: DatStore) => void;
  /** DatStore LRU bound (default DEFAULT_RESIDENT_CAP_BYTES). */
  residentCapBytes?: number;
  /**
   * Which side of the game this set serves (StreamScope). Default 'all'.
   */
  scope?: StreamScope;
  /**
   * Called once, before open() starts awaiting the world + terrain packs and
   * the UI art from the object cache (a warm profile: bootReport.worldCached).
   * Never called on a cold profile. The boot telemetry's 'world_cache' stage.
   */
  onWorldCache?: () => void;
  /** The page watch's timers + document (tests; default the browser's). */
  watchEnv?: BootWatchEnv;
}

/**
 * What one streamed set serves. 'all': the interface and the world (end of
 * retail, a classic era). 'interface': the interface only, for an era whose
 * world is a second portal (AC1999: era/EraBoot.ts eraStreamPlan): the set's
 * terrain pack (every end-of-retail CellLandblock) is never fetched and the
 * world never reads this set's cell or landblocks; its 'world' pack still
 * loads, since it carries GameUI's preload art, chargen's art and portal
 * space. 'world': a world-only set (no boot / local / ui art): the
 * interface comes from another set.
 */
export type StreamScope = 'all' | 'interface' | 'world';

/** The background packs main() awaits before chargen / entering the world, per scope. */
export function backgroundPacks(scope: StreamScope): PackRole[] {
  return scope === 'interface' ? ['world'] : ['world', 'terrain'];
}

/** Awaited before the character screen. */
const FIRST: PackRole[] = ['boot', 'local', 'skeleton'];
export async function openStreamingDats(opts: OpenStreamingOptions): Promise<StreamingDats> {
  const watch = startBootWatch(opts.watchEnv);
  try {
    return await openStreamingDatsWatched(opts, watch);
  } finally {
    watch.stop();
  }
}

async function openStreamingDatsWatched(opts: OpenStreamingOptions, watch: ReturnType<typeof startBootWatch>): Promise<StreamingDats> {
  const t0 = performance.now();
  let splashMs = 0;
  const bootPacksHook = (s: DatStore): void => {
    const ts = performance.now();
    try { opts.onBootPacks?.(s); } finally { splashMs += performance.now() - ts; }
  };
  const scope = opts.scope ?? 'all';
  const servesInterface = scope !== 'world';
  // Background: awaited before chargen / entering the world (a pack the set lacks is skipped).
  const WORLD = backgroundPacks(scope);
  const cache: ObjectCache = opts.cache ?? (opts.bypassCache ? new NullObjectCache() : OpfsObjectCache.create());
  let firstDone = 0;
  let firstTotal = 0;
  let bootPacksSignalled = false;
  const store = await DatStore.open({
    pointerUrl: opts.pointerUrl,
    cache,
    packs: FIRST,
    ...(opts.fetchObject ? { fetchObject: opts.fetchObject } : {}),
    ...(opts.fetchPointer ? { fetchPointer: opts.fetchPointer } : {}),
    ...(opts.residentCapBytes !== undefined ? { residentCapBytes: opts.residentCapBytes } : {}),
    onProgress: (done, total) => { firstDone = done; firstTotal = total; opts.onProgress?.(done, total); },
    // The splash draws from boot + local: as soon as both are in, not after the skeleton.
    onPackResident: (_role, s) => {
      if (bootPacksSignalled || !s.isPackResident('boot') || !s.isPackResident('local')) return;
      bootPacksSignalled = true;
      bootPacksHook(s);
    },
  });
  if (!bootPacksSignalled) { bootPacksSignalled = true; bootPacksHook(store); } // a set without one of them
  const tLayout = performance.now();

  let region: RegionDesc | null = null;
  let wantsHighRes: () => boolean = () => false;
  const closure = new DatClosure(store, { regionDesc: () => region, wantsHighRes: () => wantsHighRes() });

  // The pre-world screens' art (LayoutRenderer draws once and never repaints):
  // resident before open() resolves, on the same patch meter. Layout
  // properties need MasterProperty (main() registers it again; same table).
  const mp = store.db('portal').getFileData(0x39000001);
  if (mp) setMasterPropertyTypes(parseMasterProperty(new DatReader(mp)));
  const preWorld = !servesInterface ? [] : layoutArtIds(store.db('local'), PREWORLD_LAYOUTS)
    .filter((id) => store.exists('portal', id))
    .map((id) => fileKey('portal', id));
  const artTotal = preWorld.reduce((s, k) => {
    const { id } = splitFileKey(k);
    return s + (store.isResident('portal', id) ? 0 : (store.manifest.leaves.portal.get(id)?.gzSize ?? 0));
  }, 0);
  let artDone = 0;
  const pending = new Set(preWorld);
  const off = store.onResident((k) => {
    if (!pending.delete(k)) return;
    artDone += store.manifest.leaves.portal.get(splitFileKey(k).id)?.gzSize ?? 0;
    opts.onProgress?.(firstDone + artDone, firstTotal + artTotal);
  });
  if (artTotal > 0) opts.onProgress?.(firstDone, firstTotal + artTotal);
  const tArt = performance.now();
  const layoutMs = tArt - tLayout;
  try {
    await closure.ensure(preWorld, FetchPriority.Critical);
  } catch (err) {
    // A dead file never blocks boot: what is missing draws when the screen next renders.
    console.warn('[AC:DatStream] pre-world art: a fetch failed', err);
  } finally {
    off();
  }
  opts.onProgress?.(firstTotal + artTotal, firstTotal + artTotal);
  const artMs = performance.now() - tArt;

  // The world + terrain packs, then the 'ui' pack (every other panel's art)
  // when the set has one, then every LayoutDesc's art.
  let worldDone = false;
  const worldPacks = Promise.all(WORLD.map((role) => store.ensurePack(role, FetchPriority.Prefetch))).then(() => { worldDone = true; });
  worldPacks.catch(() => { /* main() reports it where it awaits */ });
  const uiPack = worldPacks.then(() => (servesInterface && store.pointer.packs.ui ? store.ensurePack('ui', FetchPriority.Prefetch) : undefined));
  uiPack.catch(() => { /* panels stream on miss */ });
  // RELEASE.streaming-area-packs: the area index with the world packs (small;
  // every gate reads it), then the common pack in the background. An
  // interface-only set's world is another set's, so it loads neither.
  if (scope !== 'interface') {
    void worldPacks.then(() => store.loadAreaIndex(FetchPriority.Prefetch), () => undefined);
    void uiPack.then(() => store.ensureCommonPack(FetchPriority.Background), () => undefined);
  }
  let uiArt: FileKey[] | null = null;
  const uiArtRoots = (): FileKey[] => (uiArt ??= !servesInterface ? [] : layoutArtIds(store.db('local')).filter((id) => store.exists('portal', id)).map((id) => fileKey('portal', id)));
  // Prefetch, not Background: entering the world waits for it (a background
  // load joined by the gate's critical requests made the gate wait behind it).
  const uiArtReady = uiPack.then(() => closure.ensure(uiArtRoots(), FetchPriority.Prefetch)).then(() => undefined, () => { /* panels stream on miss */ });

  // A warm profile already holds the world packs: nothing to download behind
  // char select, so load them (and the UI art) now and let main() build the
  // world before char select exactly as with whole DATs. Deferring that build
  // only moved its main-thread cost next to the login gate (2026-10-05: warm
  // login gate 0.57 s → 2.5 s). Cold profiles keep the light char select.
  const tHas = performance.now();
  const worldRefs = WORLD.map((role) => store.manifest.packs.get(role) ?? store.pointer.packs[role]).filter((r): r is NonNullable<typeof r> => !!r);
  const worldCached = worldRefs.length > 0 && cache.has !== undefined
    && (await Promise.all(worldRefs.map((r) => cache.has!(r.hash).catch(() => false)))).every(Boolean);
  const hasMs = performance.now() - tHas;
  let worldCacheMs = 0;
  if (worldCached) {
    const tw = performance.now();
    try { opts.onWorldCache?.(); } catch { /* a reporting hook never blocks boot */ }
    try {
      await worldPacks;
      await uiArtReady;
    } catch { /* a corrupt cache entry refetches; main() awaits worldPacks again */ }
    worldCacheMs = Math.round(performance.now() - tw);
  }
  const st = store.stats;
  const ot = store.openTimings;
  const page = watch.stop();
  const r = Math.round;
  const phases: StreamBootPhases = {
    pointerMs: ot.pointerMs, pointerTries: ot.pointerTries, pointerBytes: ot.pointerBytes,
    dirMs: r(cache.openMs ?? 0), manifestMs: ot.manifestMs, packsMs: ot.packsMs, splashMs: r(splashMs),
    layoutMs: r(layoutMs), artMs: r(artMs), artFiles: preWorld.length, hasMs: r(hasMs),
    cacheReadMs: r(st.cacheReadMs), cacheReadMaxMs: r(st.cacheReadMaxMs), cacheMisses: st.cacheMisses, inflateMs: r(st.inflateMs),
    retries: st.retries, failures: st.failures, rcvBytes: st.netReceivedBytes,
    lagMs: page.lagMs, lagMaxMs: page.lagMaxMs, hiddenMs: page.hiddenMs,
  };
  const bootReport: StreamingBootReport = { netBytes: st.netBytes, netObjects: st.netObjects, cacheBytes: st.cacheBytes, cacheObjects: st.cacheObjects, preWorldArtFiles: preWorld.length, ms: Math.round(performance.now() - t0), worldCached, worldCacheMs, phases };
  return {
    uiArtReady,
    worldPacks,
    worldPacksResident: () => worldDone,
    bootReport,
    store,
    closure,
    portal: store.db('portal'),
    cell: store.db('cell'),
    local: store.db('local'),
    highres: store.db('highres'),
    setRegionDesc: (r) => { region = r; },
    setWantsHighRes: (fn) => { wantsHighRes = fn; },
    uiArtRoots,
    prefetchUiArt: () => uiArtReady,
    buildOrRebuild<T>(build: () => T, rebuild: () => void, roots: readonly FileKey[] = []): T {
      const { result, scope } = store.scoped(build);
      if (scope.missed) void rebuildOnArrival(store, closure, scope, rebuild, roots);
      return result;
    },
    pendingFor(probe: () => unknown, roots: readonly FileKey[] = []): Promise<void> | null {
      const { scope } = store.scoped(probe);
      if (!scope.missed) return null;
      return Promise.all([whenResident(store, scope), closure.ensure(roots, FetchPriority.Critical)]).then(() => undefined);
    },
  };
}

/**
 * STREAM.object-rebuild-not-rescoped — how many times one build is redone on
 * arrival. A rebuild can miss files the first build never reached (the parts
 * a newer ObjDesc names, a link animation); each such miss waits for its
 * files and rebuilds again. The bound stops a file that is truly absent from
 * the set (known absent: ensure resolves, the read misses again) from looping.
 */
export const MAX_STREAMED_REBUILDS = 4;

/**
 * RELEASE.dat-streaming "rebuild on arrival": once the files `scope` missed and
 * the closure of `roots` are resident, run `rebuild` in a miss scope of its
 * own; when it misses, wait for those files and rebuild again, up to
 * `attempts` rebuilds in all. A failed fetch leaves the object as built.
 */
export function rebuildOnArrival(
  store: Pick<DatStore, 'ensure' | 'scoped'>, closure: Pick<DatClosure, 'ensure'>,
  scope: MissScope, rebuild: () => void, roots: readonly FileKey[] = [], attempts = MAX_STREAMED_REBUILDS,
): Promise<void> {
  return Promise.all([store.ensure(scope.keys, FetchPriority.Critical), closure.ensure(roots, FetchPriority.Critical)])
    .then(() => {
      // PERF.slow-first-minute-diagnostics — the rebuild's main-thread cost (telemetry/MainThreadCost.ts).
      const again = streamHandlerCost.time('rebuild', () => store.scoped(rebuild).scope);
      if (again.missed && attempts > 1) return rebuildOnArrival(store, closure, again, rebuild, roots, attempts - 1);
      return undefined;
    }, () => { /* failed fetch: stays as built */ });
}

/** Resolves once every file a scope missed is resident (or known absent). */
export function whenResident(store: DatStore, scope: MissScope): Promise<void> {
  return store.ensure(scope.keys, FetchPriority.Critical);
}
