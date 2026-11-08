import * as THREE from 'three';
import { CELL_LIGHTING_KEY } from '../models/RetailLighting.js';
import { ObjectLightCarrier, objectLightCarrierOf } from './ObjectLights.js';

/**
 * DatLightBudget — the retail world-light pool (GAP.2, re-anchored by
 * CORE.17.h.g.c.c.b).
 *
 * EnvCellRenderer attaches a THREE.PointLight (userData.datLight, created
 * disabled) for every LightInfo in a placed static object's SetupModel
 * (torch sconces, braziers, lamps — ACE.DatLoader/Entity/LightInfo.cs).
 * Both interior paths produce them: streamed dungeon cells AND eagerly-built
 * surface-building interiors, so the budget lives at scene level rather than
 * inside either renderer.
 *
 * Retail (decompiled acclient, build ac1_sep13 — reference/client-eol):
 *  - `Render::world_lights` holds TWO distance-sorted lists.
 *    `CObjCell::add_static_to_global_lights` @ 0052b350 feeds every visible
 *    cell's `state & 1` LIGHTOBJs (the lights of STATIC physics objects —
 *    `CPartArray::InitLights` @ 00518c00 copies the owner's PhysicsState
 *    Static bit) to `Render::add_static_light` @ 0054d3e0 →
 *    `insert_light(max_static_lights, …)`; the rest (creature/effect-carried
 *    lights and the viewer light) go through `add_dynamic_light` @ 0054d420 →
 *    `insert_light(max_dynamic_lights, …)`. `Render::insert_light` @ 0054d1b0
 *    is a sorted insertion on the squared distance from `Render::player_pos`
 *    (point lights only — directional/spot lights get distance 0 and lead the
 *    list); a full list drops the farthest entry.
 *  - The caps are `Render::SetDegradeLevelInternal` @ 0054c3c0's derivations:
 *    40 static + 7 dynamic at deg_mul 0 (.data 0x81ec94 / 0x81ec98), 20 + 5 at
 *    −1, 60 + 10 at +1 (`degradeLevelDerived` in models/DegradeLod.ts). The
 *    old "8" here was the D3D fixed-function `MaxActiveLights` premise; retail
 *    never capped the POOL at 8.
 *  - How the pool reaches the device: cell geometry burns EVERY pooled static
 *    light into its vertex colours (`D3DPolyRender::SetStaticLightingVertexColors`
 *    @ 0059cfe0 loops `num_static_lights`, no 8-cap) and takes the dynamic
 *    list through the hardware slots (`Render::minimize_envcell_lighting`
 *    @ 0054c170); each OBJECT re-picks up to 8 hardware slots per draw
 *    (`Render::minimize_object_lighting` @ 0054d480: dynamic lights first,
 *    then static point lights whose `falloff + object radius` sphere reaches
 *    the object, `curLightUsage[8]`). Only draws under `useSunlight == 0` —
 *    an interior viewer's cells and the objects in them — take pool lights at
 *    all; an outdoor viewer's draws (`SmartBox::RenderNormalMode` @ 00453aa0
 *    → `useSunlightSet(1)` + `LScape::draw`) have the sun as the only active
 *    light (`Render::useSunlightSet` @ 0054d450 → `add_active_light(-1, 0)`).
 *
 * Ours: three.js applies every enabled scene light to every lit material, so
 * the pool IS the active set — the nearest `maxStaticLights` static + the
 * nearest `maxDynamicLights` dynamic DAT lights to the player are enabled,
 * the rest stay disabled. The per-object 8-slot re-pick is not modelled (an
 * object reached by more than 8 pool lights is lit by all of them here; retail
 * dropped the ones farthest from the player). Lights under a hidden cell
 * group (PVS / portal visibility) are not pooled — retail's lists come from
 * `CEnvCell::visible_cell_table`.
 *
 * Two transparent device-side measures (no visible effect):
 *  - `deviceMaxLights` caps the enabled total below the uniform budget of the
 *    stage that sums the lights (`deviceLightLimit`; the VERTEX stage since
 *    CORE.17.q.a's Gouraud path) so a min-spec device never fails to compile.
 *  - Enabled counts are padded up to a multiple of `fillerStep` with
 *    zero-intensity filler lights, so three.js compiles one program variant
 *    per step instead of one per distinct light count (a zero-intensity light
 *    contributes exactly 0 to the retail-patched sum).
 *  - PERF.4 — `fixedLightCount` pads instead to ONE constant total: the caps
 *    (maxStatic + maxDynamic) plus `reservedExternalLights` of headroom for
 *    the scene's enabled point lights outside the budget (the viewer light,
 *    portal / projectile / effect glows — counted every update), including
 *    when nothing is pooled. three.js keys every lit
 *    program on numPointLights, and the pooled count follows cell visibility,
 *    so under step padding a camera turn cycled the scene through
 *    0/8/9/16/17/24/32/33/40/41 lights and recompiled every visible material
 *    at each step (M3 Max, Holtburg: 156 programs compiled in the first
 *    turn, 4 frames over 100 ms). With a constant count the variant never
 *    changes, so programs compiled once (or prewarmed under the portal-space
 *    cover, scene/RendererWarmup) are the ones every later frame uses. It
 *    changes only when the caps do (a degrade-level step) or a transient
 *    effect light exceeds the reserve.
 */
export interface LightCaps {
  /** Render::max_static_lights — insert_light's cap for the static list. */
  maxStaticLights: number;
  /** Render::max_dynamic_lights — the cap for the dynamic list. */
  maxDynamicLights: number;
}

/** `.data 0x81ec94 / 0x81ec98` — the caps before the first adaptive update (= deg_mul 0). */
export const RETAIL_STARTUP_LIGHT_CAPS: Readonly<LightCaps> = Object.freeze({ maxStaticLights: 40, maxDynamicLights: 7 });

/**
 * Render::SetDegradeLevelInternal @ 0054c3c0 at deg_mul 1 (40 + 20, 7 + 3):
 * the largest caps the Adaptive Degrade controller can reach, and where it
 * settles on any machine above 25 fps (VISUAL.town-scenery-gaps — retail
 * ships Automatic Degrades on). The fixed point-light total is sized to
 * these, so deg_mul's climb never changes the count.
 */
export const RETAIL_MAX_LIGHT_CAPS: Readonly<LightCaps> = Object.freeze({ maxStaticLights: 60, maxDynamicLights: 10 });

/**
 * Whose light pool the era's client built (EraWorldRules.lightPool, BUG.ac1999-point-light-falloff).
 *
 * - `'eor'` (end of retail and the classic eras): the caps above, ranked from the player's position.
 *   Each light is ranked by its OWNER's origin, not its own position: `insert_light` @ 0054d1b0
 *   measures from `param_7` (the owner's Frame) and only then `Frame::combine`s the LightInfo
 *   offset into the stored light.
 * - `'ac1999'`: the 1999 client's `0x43f7b0` (add_static 0x43fa60 / add_dynamic 0x43fa90) is the
 *   same sorted insertion as end of retail's `insert_light` (a new light goes after equal
 *   distances; a full list drops the farthest, and a newcomer farther than all of a full list is
 *   dropped, each light ranked by its owner's origin), with two differences:
 *   - the caps are `0x43ffd0`'s 20 + 10·L static (both branches, `fmul −10.0; fsubr 20.0`,
 *     truncated by `__ftol`) and 7 + 3·L / 7 + 2·L dynamic (L ≥ 0 / L < 0): 20 / 7 at L = 0
 *     (.data 0x61c4ec / 0x61c4f0), 30 / 10 at L = 1 — where the default Automatic degrade
 *     (PerformancePanel_Reset passes ECX = 1 to SmartBox_SetDetailToSpeed, 0x598cc1) settles on any
 *     machine above 1.25 × max_framerate (0x43db00: +0.1 a frame). End of retail: 40 + 20·L.
 *   - the reference point is `0x652d84` / `0x652d88`: the player's current CELL id and the cell's
 *     own frame, written only by CellManager_ChangePosition (0x652d84 = cell + 0x48, the frame from
 *     cell + 0x4c); 1999 has no per-frame player_pos writer (end of retail's SmartBox sets
 *     Render::player_pos to the player every frame).
 *   Per object, 1999 enables every pooled light that passes 0x43fb30 — the same reach test as end of
 *   retail's minimize_object_lighting (|light − centre|² − (falloff + radius)² < 0.0002, the part's
 *   sphere from 0x43fbc0; non-point lights always) — with no 8-slot cap (the lighter loops the whole
 *   list, 0x583140 / 0x583190).
 */
export type LightPoolRule = 'eor' | 'ac1999';

/** Whether the era's pool ranks a light by its owner's origin: every client does (0054d1b0 / 0x43f7b0). */
export function lightPoolRanksFromOwner(rule: LightPoolRule): boolean {
  return rule === 'eor' || rule === 'ac1999';
}

/** 1999 `.data 0x61c4ec / 0x61c4f0` — the caps before the first degrade update (L = 0). */
export const AC1999_STARTUP_LIGHT_CAPS: Readonly<LightCaps> = Object.freeze({ maxStaticLights: 20, maxDynamicLights: 7 });

/** 1999 `0x43ffd0` at L = 1 (the light storage is 30 static / 10 dynamic records, Render_Init 0x43d5e0). */
export const AC1999_MAX_LIGHT_CAPS: Readonly<LightCaps> = Object.freeze({ maxStaticLights: 30, maxDynamicLights: 10 });

/** 1999 `Render_SetDegradeLevelInternal` @ 0x43ffd0's light caps for the degrade level L (−1..1). */
export function ac1999LightCaps(degMul: number): LightCaps {
  const p = Math.max(-1, Math.min(1, degMul));
  return {
    maxStaticLights: Math.trunc(20 + 10 * p),
    maxDynamicLights: Math.trunc(p >= 0 ? 7 + 3 * p : 7 + 2 * p),
  };
}

/** `Render::curLightUsage[8]` — hardware slots re-picked per object draw (documented, not modelled). */
export const RETAIL_OBJECT_LIGHT_SLOTS = 8;

/** Uniform vectors one three.js PointLight struct occupies (position, color, distance, decay). */
export const UNIFORM_VECTORS_PER_POINT_LIGHT = 4;
/** Vectors kept free for the material's own uniforms (maps, fog, ambient, sun, …). */
export const DEVICE_UNIFORM_RESERVE = 64;
/**
 * PERF.4 — fixedLightCount headroom for enabled non-budget point lights (the
 * viewer light, a teleport's two portal-burst flashes, projectile glows). A
 * device-side choice, not a retail value: exceeding it only costs a program
 * variant, as every count change did before.
 */
export const DEFAULT_RESERVED_EXTERNAL_LIGHTS = 8;

/** Program-variant quantisation step (see fillerStep). */
export const DEFAULT_FILLER_STEP = 8;

/**
 * The most point lights a device can carry in one program, from the uniform
 * vector cap of the stage that sums them (MAX_VERTEX_UNIFORM_VECTORS since
 * CORE.17.q.a; it was MAX_FRAGMENT_UNIFORM_VECTORS under per-fragment Lambert).
 */
export function deviceLightLimit(maxStageUniforms: number): number {
  if (!Number.isFinite(maxStageUniforms) || maxStageUniforms <= 0) return Infinity;
  return Math.max(RETAIL_OBJECT_LIGHT_SLOTS, Math.floor((maxStageUniforms - DEVICE_UNIFORM_RESERVE) / UNIFORM_VECTORS_PER_POINT_LIGHT));
}

/** Enabled count padded to the next multiple of `step` (0 stays 0; never above `limit`). */
export function paddedLightCount(enabled: number, step: number, limit: number): number {
  if (enabled <= 0 || step <= 1) return enabled;
  const padded = Math.ceil(enabled / step) * step;
  return Math.min(padded, Math.max(enabled, limit));
}

export interface DatLightBudgetOptions {
  /** Device cap on the enabled total (default: unlimited). */
  deviceMaxLights?: number;
  /** Pad the enabled count to a multiple of this with zero-intensity fillers (0 / 1 = off). */
  fillerStep?: number;
  /** Pad to one constant total (caps + reservedExternalLights) instead of fillerStep multiples. */
  fixedLightCount?: boolean;
  /** Non-budget point lights the fixed total leaves room for (default DEFAULT_RESERVED_EXTERNAL_LIGHTS). */
  reservedExternalLights?: number;
}

/**
 * PERF.4 — the constant point-light total under `fixedLightCount`: every
 * pool slot plus the reserved external lights, never above the device cap.
 */
export function fixedPointLightTotal(caps: Readonly<LightCaps>, reservedExternal: number, deviceMax: number): number {
  const pool = Math.max(0, caps.maxStaticLights) + Math.max(0, caps.maxDynamicLights);
  return Math.min(pool + Math.max(0, reservedExternal), deviceMax);
}

export interface DatLightBudgetCensus {
  /** DAT lights known after the last gather. */
  known: number;
  /** Known lights whose cell group is visible (candidates for the lists). */
  pooled: number;
  staticActive: number;
  dynamicActive: number;
  fillers: number;
  caps: LightCaps;
  deviceMaxLights: number;
}

interface LightEntry {
  light: THREE.Object3D;
  dynamic: boolean;
  /** World position — cached at gather time for static lights, re-read per update for dynamic ones. */
  pos: THREE.Vector3;
  dist2: number;
}

export class DatLightBudget {
  /** Re-traverse the scene for lights at most this often (ms). */
  static readonly REFRESH_MS = 2000;

  private entries: LightEntry[] = [];
  /**
   * BUG.server-object-setup-lights — object lights registered as they are
   * created (ObjectLights → track), so a Flame Bolt's light joins the lists
   * on the frame it appears instead of at the next 2 s gather.
   */
  private readonly tracked = new Map<THREE.Object3D, LightEntry>();
  private lastRefresh = -Infinity;
  private readonly statics: LightEntry[] = [];
  private readonly dynamics: LightEntry[] = [];
  private readonly fillers: THREE.PointLight[] = [];
  private _external = 0;
  private readonly deviceMaxLights: number;
  /** Program-variant quantisation step (0 / 1 = off); mutable for probes. */
  fillerStep: number;
  /** PERF.4 — pad to fixedPointLightTotal (see the class comment); mutable for probes. */
  fixedLightCount: boolean;
  private readonly reservedExternalLights: number;
  private lastCaps: LightCaps = { ...RETAIL_STARTUP_LIGHT_CAPS };
  private _staticActive = 0;
  private _dynamicActive = 0;
  private _pooled = 0;
  /** Probe hook: when set, replaces the caps passed to update() (A/B captures). */
  capsOverride: LightCaps | null = null;
  /**
   * Rank each light by its owner's origin (the placed object / the carrier's object) instead of the
   * light's own position: both clients' insertion (end of retail `insert_light` @ 0054d1b0 /
   * 1999 0x43f7b0) measures from the frame it is handed, the owner's (`lightPoolRanksFromOwner`).
   * A light hung straight off the root has no owner and keeps its own position.
   */
  rankFromHolder = false;

  constructor(private readonly root: THREE.Object3D, options: DatLightBudgetOptions = {}) {
    this.deviceMaxLights = options.deviceMaxLights ?? Infinity;
    this.fillerStep = options.fillerStep ?? 0;
    this.fixedLightCount = options.fixedLightCount ?? false;
    this.reservedExternalLights = options.reservedExternalLights ?? DEFAULT_RESERVED_EXTERNAL_LIGHTS;
  }

  /** Number of DAT lights currently known (post last refresh, plus the tracked object lights). */
  get lightCount(): number {
    return this.entries.length + this.tracked.size;
  }

  /**
   * ObjectLightSink.lightParent — object lights hang off a carrier at the
   * scene root, so a Hidden / NoDraw object keeps them
   * (BUG.hidden-object-lights-leave-pool).
   */
  get lightParent(): THREE.Object3D {
    return this.root;
  }

  /**
   * PERF.indoor-two-pass-cost — every DAT light the budget knows (the last
   * gather's plus the tracked object lights). A DAT light starts disabled and
   * only update() enables one, so this covers every enabled DAT light
   * (scene/IndoorView.ts counts its pass pads from it instead of walking the scene).
   */
  forEachLight(visit: (light: THREE.Object3D) => void): void {
    for (const e of this.entries) visit(e.light);
    for (const light of this.tracked.keys()) visit(light);
  }

  /** Register an object light (ObjectLightSink) — pooled from the next update(). */
  track(light: THREE.Object3D): void {
    if (this.tracked.has(light)) return;
    this.tracked.set(light, { light, dynamic: !!light.userData.datLightDynamic, pos: new THREE.Vector3(), dist2: 0 });
  }

  /** Release an object light (its object lost LightingOn, or left the scene). */
  untrack(light: THREE.Object3D): void {
    this.tracked.delete(light);
    light.visible = false;
  }

  /** Number of currently enabled DAT lights (fillers excluded). */
  get activeCount(): number {
    return this._staticActive + this._dynamicActive;
  }

  /** Enabled non-budget point lights counted by the last fixed-count update. */
  get externalCount(): number {
    return this._external;
  }

  /** Number of live zero-intensity filler lights. */
  get fillerCount(): number {
    return this.fillers.reduce((n, f) => n + (f.visible ? 1 : 0), 0);
  }

  census(): DatLightBudgetCensus {
    return {
      known: this.entries.length + this.tracked.size,
      pooled: this._pooled,
      staticActive: this._staticActive,
      dynamicActive: this._dynamicActive,
      fillers: this.fillerCount,
      caps: { ...this.lastCaps },
      deviceMaxLights: this.deviceMaxLights,
    };
  }

  /** Force a re-gather on the next update (e.g. after a teleport). */
  invalidate(): void {
    this.lastRefresh = -Infinity;
  }

  /**
   * Rebuild the two lists from `originPos` (world space — the player's
   * position, retail's `Render::player_pos`) under `caps` and enable exactly
   * the pooled lights the lists keep; disable the rest.
   */
  update(
    originPos: THREE.Vector3,
    nowMs: number = performance.now(),
    caps: Readonly<LightCaps> = RETAIL_STARTUP_LIGHT_CAPS,
  ): void {
    if (this.capsOverride) caps = this.capsOverride;
    this.lastCaps = { maxStaticLights: caps.maxStaticLights, maxDynamicLights: caps.maxDynamicLights };
    if (nowMs - this.lastRefresh >= DatLightBudget.REFRESH_MS) {
      this.gather();
      this.lastRefresh = nowMs;
    }
    const statics = this.statics;
    const dynamics = this.dynamics;
    statics.length = 0;
    dynamics.length = 0;
    const consider = (e: LightEntry, mustBeAttached: boolean): void => {
      // An object light's carrier follows its object: bring its visibility
      // and frame up to date before judging it (ObjectLights).
      const holder = e.light.parent;
      if (holder instanceof ObjectLightCarrier) holder.sync();
      // PERF.4 — under fixedLightCount a light whose subtree left the scene
      // since the last gather (landblock unload) must not hold a slot: three
      // no longer draws it, so counting it would shrink the constant total.
      // BUG.server-object-setup-lights — a light on an object standing in a
      // LAND cell (setCellLighting's `acInCell === false` on an ancestor)
      // never enters retail's lists: CObjCell::add_dynamic_lights /
      // add_static_to_global_lights walk only the visible ENV cells.
      if (((this.fixedLightCount || mustBeAttached) ? !attachedAndVisible(e.light, this.root) : !ancestorsVisible(e.light))
        || inLandCell(e.light)) {
        e.light.visible = false;
        return;
      }
      // Static gathered lights keep the position cached at gather; a dynamic light moves, and a
      // tracked object light (static or not) follows its carrier, so both are re-read.
      if (e.dynamic || mustBeAttached) this.rankPosition(e.light, e.pos);
      e.dist2 = e.pos.distanceToSquared(originPos);
      (e.dynamic ? dynamics : statics).push(e);
    };
    for (const e of this.entries) consider(e, false);
    for (const e of this.tracked.values()) consider(e, true);
    this._pooled = statics.length + dynamics.length;
    // Render::insert_light — distance²-sorted, stable (a new light goes after
    // equal distances), the list keeps its nearest `max` entries.
    statics.sort(byDist2);
    dynamics.sort(byDist2);
    // Dynamic lights take their slots first (minimize_object_lighting's order).
    let budget = this.deviceMaxLights;
    const dynN = Math.min(dynamics.length, Math.max(0, caps.maxDynamicLights), budget);
    budget -= dynN;
    const staN = Math.min(statics.length, Math.max(0, caps.maxStaticLights), budget);
    for (let i = 0; i < dynamics.length; i++) dynamics[i].light.visible = i < dynN;
    for (let i = 0; i < statics.length; i++) statics[i].light.visible = i < staN;
    this._dynamicActive = dynN;
    this._staticActive = staN;
    if (this.fixedLightCount) {
      // VISUAL.town-scenery-gaps — sized to the highest caps deg_mul can
      // reach, not the current ones: Automatic Degrades steps the caps on
      // every deg_mul change (startup climb, a framerate dip), and each new
      // total would recompile every lit program. Fillers are zero-intensity.
      const sized: LightCaps = {
        maxStaticLights: Math.max(caps.maxStaticLights, RETAIL_MAX_LIGHT_CAPS.maxStaticLights),
        maxDynamicLights: Math.max(caps.maxDynamicLights, RETAIL_MAX_LIGHT_CAPS.maxDynamicLights),
      };
      const total = fixedPointLightTotal(sized, this.reservedExternalLights, this.deviceMaxLights);
      // Counted every update, not from the 2 s gather: an effect light that
      // appears between gathers (a portal burst, a projectile glow) would
      // otherwise push the total past the constant for up to REFRESH_MS and
      // recompile every visible material (measured: a 133 ms idle hitch).
      // traverseVisible mirrors three.js's own light collection.
      let external = 0;
      this.root.traverseVisible((o) => {
        if ((o as THREE.PointLight).isPointLight && !o.userData.datLight) external++;
      });
      this._external = external;
      this.setFillers(Math.max(0, total - (dynN + staN) - external));
    } else {
      this.applyFillers(dynN + staN);
    }
  }

  private gather(): void {
    this.entries = [];
    // A tracked light whose subtree left the scene without an untrack (a
    // disposed object) is dropped here, so the registry cannot grow.
    // BUG.hidden-object-lights-leave-pool — a carrier whose object left the
    // scene leaves with it (and comes back below when the object does).
    for (const light of this.tracked.keys()) {
      const holder = light.parent;
      const carrier = holder instanceof ObjectLightCarrier ? holder : null;
      if (!isAttached(light, this.root) || (carrier && !isAttached(carrier.owner, this.root))) {
        this.tracked.delete(light);
        light.visible = false;
        if (carrier) carrier.parent?.remove(carrier);
      }
    }
    this.root.traverse((o) => {
      const carrier = objectLightCarrierOf(o);
      if (carrier && carrier.parent !== this.root && !(o instanceof ObjectLightCarrier)) {
        this.root.add(carrier);
        for (const l of carrier.children) if (l.userData.datLightTracked) this.track(l);
      }
      const ud = o.userData;
      if (!ud?.datLight || ud.datLightFiller) return;
      // An object light built before this budget became the sink is adopted.
      if (ud.datLightTracked) { this.track(o); return; }
      const e: LightEntry = { light: o, dynamic: !!ud.datLightDynamic, pos: new THREE.Vector3(), dist2: 0 };
      this.rankPosition(o, e.pos);
      this.entries.push(e);
    });
  }

  /** Where a light is ranked from: its own world position, or its owner's origin under rankFromHolder. */
  private rankPosition(light: THREE.Object3D, out: THREE.Vector3): void {
    const owner = light.parent;
    (this.rankFromHolder && owner && owner !== this.root ? owner : light).getWorldPosition(out);
  }

  private applyFillers(enabled: number): void {
    this.setFillers(paddedLightCount(enabled, this.fillerStep, this.deviceMaxLights) - enabled);
  }

  private setFillers(want: number): void {
    while (this.fillers.length < want) {
      const f = new THREE.PointLight(0x000000, 0, 1, 1);
      f.name = 'dat-light-filler';
      f.userData.datLight = true;
      f.userData.datLightFiller = true;
      f.visible = false;
      this.root.add(f);
      this.fillers.push(f);
    }
    for (let i = 0; i < this.fillers.length; i++) this.fillers[i].visible = i < want;
  }
}

function byDist2(a: LightEntry, b: LightEntry): number {
  return a.dist2 - b.dist2;
}

/**
 * PERF.4 — true when `o` is still under `root` and every ancestor on the way
 * is visible (the light's own flag is not consulted). A light whose subtree
 * was removed from the scene is not rendered by three.js at all.
 */
export function attachedAndVisible(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p = o.parent; p; p = p.parent) {
    if (!p.visible) return false;
    if (p === root) return true;
  }
  return false;
}

/** True when `o` is still somewhere under `root` (visibility ignored). */
export function isAttached(o: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let p = o.parent; p; p = p.parent) if (p === root) return true;
  return false;
}

/**
 * BUG.server-object-setup-lights — true when an ancestor was put in the
 * LANDSCAPE draw pass (`setCellLighting(root, false)` → `acInCell === false`):
 * the owning physics object stands in a land cell, whose lights retail never
 * pools. Env-cell stabs are marked `true`; unmarked subtrees count as cell
 * content.
 */
export function inLandCell(o: THREE.Object3D): boolean {
  for (let p = o.parent; p; p = p.parent) {
    const v = p.userData?.[CELL_LIGHTING_KEY];
    if (v === false) return true;
    if (v === true) return false;
  }
  return false;
}

/** True when every ancestor of `o` is visible (the light's own flag is the budget's output, not an input). */
export function ancestorsVisible(o: THREE.Object3D): boolean {
  for (let p = o.parent; p; p = p.parent) {
    if (!p.visible) return false;
  }
  return true;
}
