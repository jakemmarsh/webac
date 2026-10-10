/**
 * DatClosure — make a set of DAT files resident together with everything a
 * synchronous build of them reads (docs/dat-streaming.md §3.1: "closure
 * discovery is local and cheap").
 *
 * Retail's shape: DBObj::PreFetch then DBObj::Get. The structural files
 * (Setups, Surfaces, SurfaceTextures, MotionTables, DegradeInfos, Scenes,
 * tables) ship in the skeleton pack and are resident from boot, so walking
 * Setup → GfxObj → Surface → SurfaceTexture → Texture → Palette needs the
 * network only for the leaves: a closure costs 2–3 dependent waves.
 *
 * Edges walked (each mirrors what the sync builders read):
 *   cell   LandblockInfo 0xXXYYFFFE  → its Stab ids, building models, every EnvCell in the bundle
 *          CellLandblock 0xXXYYFFFF  → the scenery objects generateScenery() picks (real code), the LandblockInfo
 *          EnvCell                   → surfaces, Environment, static objects
 *   portal Setup 0x02     → parts, default MotionTable
 *          GfxObj 0x01    → surfaces, DIDDegrade
 *          DegradeInfo 0x11 → its LOD GfxObjs
 *          Surface 0x08   → SurfaceTexture, palette
 *          SurfaceTexture 0x05 → its texture levels (highres level only while Very High is on)
 *          Texture 0x06/0x07 → default palette (paletted formats)
 *          MotionTable 0x09 → the default style's cycles + links (animations)
 *          Scene 0x12     → its objects
 *          Setup DefaultScript 0x33 → CreateParticle emitters 0x32 → their HW GfxObj; CallPES scripts
 *          PhysicsScriptTable 0x34 → its Hidden / UnHide scripts (the arrival bubbles)
 *          Font 0x40      → its glyph + halo surfaces (a layout element's font)
 * Not walked (fetched on first use through the miss path): animation-hook
 * particles, Waves, non-default-stance animations, icons.
 */
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { ACFont } from '@ac/dat-parser/file-types/ACFont.js';
import { CellLandblock } from '@ac/dat-parser/file-types/CellLandblock.js';
import { EnvCell } from '@ac/dat-parser/file-types/EnvCell.js';
import { GfxObj } from '@ac/dat-parser/file-types/GfxObj.js';
import { GfxObjDegradeInfo } from '@ac/dat-parser/file-types/GfxObjDegradeInfo.js';
import { LandblockInfo } from '@ac/dat-parser/file-types/LandblockInfo.js';
import { MotionTable } from '@ac/dat-parser/file-types/MotionTable.js';
import { AnimationHookType } from '@ac/dat-parser/file-types/AnimationHook.js';
import { ParticleEmitterInfo } from '@ac/dat-parser/file-types/ParticleEmitterInfo.js';
import { PhysicsScript, PhysicsScriptTable } from '@ac/dat-parser/file-types/PhysicsScript.js';
import { PlayScript } from '@ac/shared';
import type { RegionDesc, SkyDesc } from '@ac/dat-parser/file-types/RegionDesc.js';
import { Scene } from '@ac/dat-parser/file-types/Scene.js';
import { SetupModel } from '@ac/dat-parser/file-types/SetupModel.js';
import { Surface } from '@ac/dat-parser/file-types/Surface.js';
import { SurfaceTexture } from '@ac/dat-parser/file-types/SurfaceTexture.js';
import { Texture } from '@ac/dat-parser/file-types/Texture.js';
import type { DatName } from '@ac/dat-parser/streaming/DatSetFormat.js';
import { type BaseProperty, type ElementDesc, type StateDesc, parseLayoutDesc } from '@ac/dat-parser/file-types/LayoutDesc.js';
import { buildingCellMask, generateScenery, makeTerrainSampler } from '../../terrain/SceneryGenerator.js';
import { type DatStore, type FileKey, FetchPriority, fileKey, splitFileKey } from './DatStore.js';

/**
 * What the walk reads from its store: the browser's DatStore, or the publish
 * tool's local-DAT source (tools/lib/area-packs.ts), which walks the same
 * edges offline to build each landblock's area pack.
 */
export type ClosureStore = Pick<DatStore, 'onEvict' | 'isResident' | 'ensure' | 'peek' | 'exists' | 'bundleIds' | 'isBundleResident' | 'ensureBundle'>
  & { ensureArea?: DatStore['ensureArea'] };

export interface DatClosureOptions {
  /** RegionDesc 0x13000000 (scenery selection). Null → landblocks walk no scenery. */
  regionDesc?: () => RegionDesc | null;
  /** Whether the highres texture level is drawn now (Environment Texture Detail = Very High). */
  wantsHighRes?: () => boolean;
}

export interface ClosureResult {
  /** Files in the closure. */
  files: number;
  /** Dependent network rounds: the deepest level at which a file had to be fetched. */
  waves: number;
  /** The files walked (roots closed by an earlier ensure are not re-walked). */
  keys: ReadonlySet<FileKey>;
}

const blockOf = (lb: number) => lb & 0xffff;
const infoId = (lb: number) => (((lb & 0xffff) << 16) | 0xfffe) >>> 0;
const landId = (lb: number) => (((lb & 0xffff) << 16) | 0xffff) >>> 0;

export class DatClosure {
  /** Discovered children per file (parsing a GfxObj once per session). */
  private readonly children = new Map<FileKey, FileKey[]>();
  /** Roots whose whole closure is known resident. */
  private readonly closed = new Set<FileKey>();
  private readonly readyBlocks = new Set<number>();
  private readonly blockLoads = new Map<number, Promise<void>>();

  constructor(private readonly store: ClosureStore, private readonly opts: DatClosureOptions = {}) {
    // The LRU dropped files: "resident" verdicts may be stale. The next ensure
    // re-walks from the cached edges (no reparse) and refetches what went.
    store.onEvict(() => { this.closed.clear(); this.readyBlocks.clear(); });
  }

  /**
   * Make the roots and their closures resident. Rejects if a fetch fails.
   *
   * Pipelined: each file's children are requested the moment that file lands,
   * not when its whole depth level has. A level barrier made every wave wait
   * for its slowest fetch (an edge-cache miss to R2 is ~0.5 s), which on the
   * real-GPU check held a cold Holtburg login gate 17 s for 1,018 files
   * (RELEASE.streaming-gate-real-gpu-check, 2026-10-06).
   */
  async ensure(roots: Iterable<FileKey>, priority: FetchPriority = FetchPriority.Prefetch): Promise<ClosureResult> {
    const visited = new Set<FileKey>();
    const rootList = [...roots].filter((k) => !this.closed.has(k));
    let waves = 0;
    const visit = async (k: FileKey, depth: number): Promise<void> => {
      if (visited.has(k)) return;
      visited.add(k);
      const { dat, id } = splitFileKey(k);
      if (!this.store.isResident(dat, id)) {
        if (depth > waves) waves = depth;
        await this.store.ensure([k], priority);
      }
      if (this.closed.has(k)) return;
      await Promise.all(this.childrenOf(k).map((c) => visit(c, depth + 1)));
    };
    await Promise.all(rootList.map((k) => visit(k, 1)));
    for (const r of rootList) this.closed.add(r);
    return { files: visited.size, waves, keys: visited };
  }

  /** Whether a root's closure was completed by an earlier ensure(). */
  isClosed(key: FileKey): boolean {
    return this.closed.has(key);
  }

  /** Whether a landblock's objects (bundle + statics + buildings + cells + scenery) are resident. */
  isLandblockReady(landblock: number): boolean {
    return this.readyBlocks.has(blockOf(landblock));
  }

  /**
   * One landblock's closure: its bundle (LandblockInfo + EnvCells), every
   * object they place, its terrain's scenery — what LandblockObjectStreamer
   * and DungeonRenderer read for the block.
   *
   * The bundle and the block's area pack (every leaf the walk below would
   * fetch, in one object: DatStore.ensureArea) are requested together, so a
   * cold block costs one wave of two requests instead of a dependency chain
   * of hundreds (RELEASE.streaming-area-packs). The walk then finds the rest
   * resident; a set without area packs walks and fetches as before.
   */
  ensureLandblock(landblock: number, priority: FetchPriority = FetchPriority.Prefetch): Promise<void> {
    const lb = blockOf(landblock);
    if (this.readyBlocks.has(lb)) return Promise.resolve();
    let p = this.blockLoads.get(lb);
    if (!p) {
      p = (async () => {
        await Promise.all([this.store.ensureBundle(lb, priority), this.store.ensureArea?.(lb, priority)]);
        await this.ensure([fileKey('cell', landId(lb)), fileKey('cell', infoId(lb))], priority);
        this.readyBlocks.add(lb);
      })().finally(() => this.blockLoads.delete(lb));
      this.blockLoads.set(lb, p);
    }
    return p;
  }

  /** Every landblock within `radius` of (cx, cy), nearest first in parallel. */
  async ensureLandblockRing(cx: number, cy: number, radius: number, priority: FetchPriority = FetchPriority.Prefetch): Promise<void> {
    const ps: Promise<void>[] = [];
    for (const [bx, by] of ringBlocks(cx, cy, radius)) ps.push(this.ensureLandblock((bx << 8) | by, priority));
    await Promise.all(ps);
  }

  // ── edges ────────────────────────────────────────────────────────────────

  /** A file's children in the walk (parsed once; [] when the file is not resident). */
  edges(key: FileKey): readonly FileKey[] {
    return this.childrenOf(key);
  }

  private childrenOf(key: FileKey): FileKey[] {
    const memo = this.children.get(key);
    if (memo) return memo;
    const { dat, id } = splitFileKey(key);
    const bytes = this.store.peek(dat, id);
    if (!bytes) return []; // absent from the set (or failed): nothing to walk
    let out: FileKey[] = [];
    try {
      out = this.discover(dat, id, bytes);
    } catch {
      out = []; // unparseable: the sync builder will report it the way it does today
    }
    // Bundle-dependent edges are only final once the bundle is resident.
    if (dat !== 'cell' || this.store.isBundleResident(id >>> 16)) this.children.set(key, out);
    return out;
  }

  private reader(bytes: Uint8Array): DatReader {
    return new DatReader(bytes.slice().buffer);
  }

  /** A portal-or-highres texture key: portal when the file is there, else highres. */
  private textureKey(id: number): FileKey | null {
    if (this.store.exists('portal', id)) return fileKey('portal', id);
    if (this.store.exists('highres', id)) return fileKey('highres', id);
    return null;
  }

  private discover(dat: DatName, id: number, bytes: Uint8Array): FileKey[] {
    const out: FileKey[] = [];
    const portal = (pid: number | undefined) => { if (pid) out.push(fileKey('portal', pid >>> 0)); };
    if (dat === 'cell') {
      const low = id & 0xffff;
      if (low === 0xfffe) {
        const info = new LandblockInfo(this.reader(bytes));
        for (const o of info.objects) portal(o.id);
        for (const b of info.buildings) portal(b.modelId);
        for (const cid of this.store.bundleIds(id >>> 16)) if ((cid & 0xffff) !== 0xfffe) out.push(fileKey('cell', cid));
      } else if (low === 0xffff) {
        const lb = CellLandblock.read(this.reader(bytes));
        if (lb.hasObjects) out.push(fileKey('cell', ((id & 0xffff0000) | 0xfffe) >>> 0));
        for (const objId of this.sceneryObjects(id, lb)) portal(objId);
      } else {
        const cell = new EnvCell(this.reader(bytes));
        for (const s of cell.surfaces) portal(s);
        portal(cell.environmentId);
        for (const st of cell.staticObjects) portal(st.id);
      }
      return out;
    }
    if (dat !== 'portal') return out;
    switch (id >>> 24) {
      case 0x01: {
        const g = new GfxObj(this.reader(bytes));
        for (const s of g.surfaces) portal(s);
        portal(g.didDegrade);
        break;
      }
      case 0x02: {
        const s = new SetupModel(this.reader(bytes));
        for (const p of s.parts) portal(p);
        portal(s.defaultMotionTable);
        portal(s.defaultScript); // statics' DefaultScript emitters (torches, portal swirls)
        // CPartArray::InitDefaults @ 00518980 loops the Setup's default_anim_id
        // (STREAM.cold-creature-never-animates: the rebuild waits for it).
        portal(s.defaultAnimation);
        break;
      }
      case 0x33: {
        for (const step of PhysicsScript.read(this.reader(bytes)).steps) {
          const h = step.hook as { hookType: number; emitterInfoId?: number; pes?: number } | null;
          if (!h) continue;
          if (h.hookType === AnimationHookType.CreateParticle) portal(h.emitterInfoId);
          else if (h.hookType === AnimationHookType.CallPES) portal(h.pes);
        }
        break;
      }
      case 0x40: {
        // Font::GetSubObjects: the foreground glyph surface and the halo (outline) surface.
        const f = ACFont.read(this.reader(bytes));
        portal(f.foregroundSurfaceDataId);
        portal(f.backgroundSurfaceDataId);
        break;
      }
      case 0x34: {
        // CPhysicsObj::set_hidden @ 00514c60 plays the table's Hidden / UnHide
        // scripts on every login and teleport (the purple bubbles). The rest of
        // the table (spell / combat effects) streams on first use.
        const table = PhysicsScriptTable.read(this.reader(bytes));
        for (const key of [PlayScript.Hidden, PlayScript.UnHide]) for (const e of table.scripts.get(key) ?? []) portal(e.scriptId);
        break;
      }
      case 0x32: {
        // ParticleEmitter::SetInfo draws the HW GfxObj only (EmitterSprite.ts).
        portal(new ParticleEmitterInfo(this.reader(bytes)).hwGfxObjId);
        break;
      }
      case 0x11: {
        for (const d of GfxObjDegradeInfo.read(this.reader(bytes)).degrades) portal(d.gfxObjId);
        break;
      }
      case 0x08: {
        const s = Surface.read(this.reader(bytes));
        portal(s.origTextureId);
        portal(s.origPaletteId);
        break;
      }
      case 0x05: {
        const levels = SurfaceTexture.read(this.reader(bytes)).textures;
        if (levels.length > 0) {
          // Retail draws the last level at High; the first is the highres level (Very High).
          const want = this.opts.wantsHighRes?.() && levels.length > 1 ? [levels[levels.length - 1], levels[0]] : [levels[levels.length - 1]];
          for (const t of want) { const k = this.textureKey(t >>> 0); if (k !== null) out.push(k); }
        }
        break;
      }
      // Texture: ACE's DatFileTypeIdRange 0x06000000–0x07FFFFFF. The EoL DATs use only 0x06; a
      // streamed 1999 world names synthetic 0x07 textures (dat-parser era1999 Textures1999).
      case 0x06:
      case 0x07: {
        const t = Texture.read(this.reader(bytes));
        if (t.defaultPaletteId) portal(t.defaultPaletteId);
        break;
      }
      case 0x09: {
        const mt = new MotionTable(this.reader(bytes));
        const style = mt.defaultStyle & 0xffff;
        const inStyle = (key: number) => ((key >>> 16) & 0xffff) === style;
        for (const [k, md] of mt.cycles) if (inStyle(k)) for (const a of md.anims) portal(a.animId);
        for (const [k, inner] of mt.links) if (inStyle(k)) for (const md of inner.values()) for (const a of md.anims) portal(a.animId);
        break;
      }
      case 0x12: {
        for (const o of Scene.read(this.reader(bytes)).objects) portal(o.objId);
        break;
      }
      default:
        break;
    }
    return out;
  }

  /** The scenery object ids generateScenery() places on a landblock (before the edge cull). */
  private sceneryObjects(landblockId: number, lb: CellLandblock): Set<number> {
    const ids = new Set<number>();
    const region = this.opts.regionDesc?.() ?? null;
    if (!region?.sceneInfo) return ids;
    const exclude = new Set<number>();
    if (lb.hasObjects) {
      const info = this.store.peek('cell', ((landblockId & 0xffff0000) | 0xfffe) >>> 0);
      if (info) {
        try { for (const c of buildingCellMask(new LandblockInfo(this.reader(info)).buildings)) exclude.add(c); } catch { /* scenery without the mask */ }
      }
    }
    const loadScene = (sceneId: number): Scene | null => {
      const b = this.store.peek('portal', sceneId);
      return b ? Scene.read(this.reader(b)) : null;
    };
    for (const p of generateScenery(landblockId, lb, region, loadScene, makeTerrainSampler(landblockId, lb, region), { excludeCells: exclude })) {
      ids.add(p.objId >>> 0);
    }
    return ids;
  }
}

/** (bx, by) of every landblock within `radius` (Chebyshev) of (cx, cy), nearest first, clamped to the map. */
export function ringBlocks(cx: number, cy: number, radius: number): Array<[number, number]> {
  const out: Array<[number, number, number]> = [];
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      const bx = cx + dx, by = cy + dy;
      if (bx < 0 || bx > 0xff || by < 0 || by > 0xff) continue;
      out.push([bx, by, dx * dx + dy * dy]);
    }
  }
  out.sort((a, b) => a[2] - b[2]);
  return out.map(([bx, by]) => [bx, by]);
}

/**
 * Every portal art file the language DAT's LayoutDescs name (media images,
 * animation frames, cursors and DataFile properties of type Texture /
 * SurfaceTexture / Surface / Palette): the HUD and panel art LayoutRenderer
 * draws synchronously. The streaming client prefetches it in the background
 * at boot and the login gate waits for it, so the HUD never renders blank.
 * Needs MasterProperty registered (setMasterPropertyTypes) to read properties.
 *
 * `only` limits the walk to those layouts plus every layout their elements
 * inherit from (baseLayout, transitively): the art one screen draws.
 */
export function layoutArtIds(
  localDb: { listFileIds(prefix?: number): number[]; getFileData(id: number): ArrayBuffer | null },
  only?: Iterable<number>,
): number[] {
  // 0x40: the elements' fonts (their glyph surfaces are leaves, walked below).
  const ART = new Set([0x04, 0x05, 0x06, 0x08, 0x40]);
  const ids = new Set<number>();
  const add = (id: number | undefined) => { if (id && ART.has(id >>> 24)) ids.add(id >>> 0); };
  const prop = (p: BaseProperty) => {
    add(p.valueDataFile);
    for (const a of p.valueArray ?? []) prop(a);
    for (const s of p.valueStruct?.values() ?? []) prop(s);
  };
  const state = (s: StateDesc) => {
    for (const m of s.media) { add(m.file); for (const f of m.frames ?? []) add(f); }
    for (const p of s.properties.values()) prop(p);
  };
  const queue = only ? [...only].map((id) => id >>> 0) : localDb.listFileIds(0x21);
  const seen = new Set<number>(queue);
  const element = (e: ElementDesc) => {
    state(e);
    for (const s of e.states.values()) state(s);
    for (const c of e.children.values()) element(c);
    const base = e.baseLayout >>> 0;
    if (only && base && (base >>> 24) === 0x21 && !seen.has(base)) { seen.add(base); queue.push(base); }
  };
  for (let i = 0; i < queue.length; i++) {
    const data = localDb.getFileData(queue[i]);
    if (!data) continue;
    try {
      for (const e of parseLayoutDesc(new DatReader(data)).elements.values()) element(e);
    } catch { /* an unreadable layout draws nothing anyway */ }
  }
  return [...ids];
}

/**
 * The sky's objects across every day group (RegionDesc SkyDesc): their
 * GfxObj / Setup and default PhysicsScript ids, as closure roots — what
 * SkyboxRenderer.initSkyObjects / rebuildSkyObjects build synchronously.
 */
export function skyObjectRoots(sky: SkyDesc | null | undefined): FileKey[] {
  const ids = new Set<number>();
  for (const g of sky?.dayGroups ?? []) {
    for (const o of g.skyObjects) {
      if (o.defaultGFXObjectId) ids.add(o.defaultGFXObjectId >>> 0);
      if (o.defaultPESObjectId) ids.add(o.defaultPESObjectId >>> 0);
    }
  }
  return [...ids].map((id) => fileKey('portal', id));
}
