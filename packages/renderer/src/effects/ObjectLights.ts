import * as THREE from 'three';
import { PhysicsState } from '@ac/shared';
import type { LightInfo } from '@ac/dat-parser/file-types/SetupModel.js';
import { CELL_LIGHTING_KEY, rawByteColor, retailLightRange, retailStaticLightDecay } from '../models/RetailLighting.js';

/**
 * ObjectLights — a physics object's own Setup lights (BUG.server-object-setup-lights).
 *
 * Retail (decompiled acclient, build ac1_sep13 — reference/client-eol):
 *  - Every CPhysicsObj whose Setup has `num_lights` builds a LIGHTLIST: one
 *    LIGHTOBJ per Setup LightInfo (`CPartArray::InitLights` @ 00518c00,
 *    called from `CPartArray::SetSetupID` @ 00519330). A LIGHTOBJ is marked
 *    STATIC (`state |= 1`) when its owner's PhysicsState has Static (0x1).
 *  - The lights exist exactly while PhysicsState LightingOn (0x800) is set:
 *    the CPhysicsObj constructor's default state 0x00400c08 includes 0x800,
 *    and `CPhysicsObj::set_state` @ 00514dd0 (the CreateObject PhysicsDesc via
 *    `set_description` @ 00514f40, every SetState via `SmartBox::DoSetState`
 *    @ 004520d0) calls `CPartArray::DestroyLights` @ 005191b0 when the bit
 *    turns off and `InitLights` when it turns on. ACE sends the bit from
 *    PropertyBool.LightsStatus (WorldObject_Networking.cs:645).
 *  - The lights follow the OBJECT frame, not a part (`CPartArray::SetFrame`
 *    @ 00519310 → `LIGHTLIST::set_frame` @ 00517c60), and are placed at
 *    `Frame::combine(object frame, LightInfo.offset)` (`Render::insert_light`
 *    @ 0054d1b0) — the object's scale does not enter.
 *  - They are registered in the object's CELL (`CPartArray::AddLightsToCell`
 *    @ 00517ea0 from `CPhysicsObj::enter_cell`), and the world light lists
 *    are fed only from the visible ENV cells (`CObjCell::add_dynamic_lights`
 *    @ 0052ad80 walks `CEnvCell::visible_cell_table`; statics via
 *    `add_static_to_global_lights` from the same table) — an object standing
 *    in a LAND cell never lights anything. The draw-pass flag
 *    `setCellLighting` already records the object's cell kind on its root
 *    (`userData.acInCell`), and DatLightBudget skips a light under a root
 *    marked `false`.
 *
 * Ours: one THREE.PointLight per LightInfo, created DISABLED and handed to
 * the light sink (DatLightBudget.track), which enables the nearest
 * `max_dynamic_lights` / `max_static_lights` like every other DAT light. The
 * scene's point-light COUNT never changes (fixedLightCount): an enabled
 * object light takes the place of a zero-intensity filler, so no lit program
 * recompiles when a torch-bearer or a Flame Bolt appears.
 */

/** The light pool that enables object lights (DatLightBudget). */
export interface ObjectLightSink {
  track(light: THREE.Object3D): void;
  untrack(light: THREE.Object3D): void;
  /**
   * Where object lights live in the scene graph (the scene root). When set,
   * an object's lights hang off a {@link ObjectLightCarrier} there instead of
   * under the object's root, so hiding the object's MESH does not take its
   * lights out of three's light list (BUG.hidden-object-lights-leave-pool).
   */
  readonly lightParent?: THREE.Object3D;
}

/**
 * userData flag on an object root: the object is invisible because it is
 * NOT DRAWN — PhysicsState Hidden / NoDraw, a NoDraw hook, the viewer
 * fade — while it is still in the world, so its lights stay lit.
 *
 * BUG.hidden-object-lights-leave-pool — retail keeps a hidden object's
 * LIGHTOBJs in its cell: `CPhysicsObj::set_hidden` @ 00514c60 and
 * `set_nodraw` only flip the state bit and the parts' no-draw
 * (`CPartArray::SetNoDrawInternal`); the lights are destroyed only by
 * `CPartArray::DestroyLights` (LightingOn off, `set_lights` @ 0050fcf0) or
 * by leaving the world. An object culled for being in another cell
 * (`_culledByCell`) is NOT flagged: it is not drawn because its cell is not.
 */
export const NO_DRAW_KEY = 'acNoDraw';

/** Mark (or clear) `root` as not drawn but still in the world — see {@link NO_DRAW_KEY}. */
export function setObjectNoDraw(root: THREE.Object3D, noDraw: boolean): void {
  const ud = root.userData as Record<string, unknown> | undefined;
  if (noDraw) {
    if (ud) ud[NO_DRAW_KEY] = true;
    else root.userData = { [NO_DRAW_KEY]: true };
  } else if (ud) {
    delete ud[NO_DRAW_KEY];
  }
}

/**
 * The scene-level holder of one object's lights: it takes the owner's world
 * matrix every frame (the lights stay in the object's frame, as retail's
 * `LIGHTLIST::set_frame` keeps them) and is visible while the owner is in
 * the scene and every node from the owner up is either visible or merely
 * not drawn ({@link NO_DRAW_KEY}). It mirrors the owner's cell-pass flag so
 * DatLightBudget's land-cell rule still applies.
 */
export class ObjectLightCarrier extends THREE.Object3D {
  readonly isObjectLightCarrier = true;

  constructor(readonly owner: THREE.Object3D) {
    super();
    this.name = 'object-light-carrier';
    this.matrixAutoUpdate = false;
  }

  /** Recompute visibility, the cell flag and the world matrix from the owner. */
  sync(): void {
    let live = true;
    let inCell: boolean | undefined;
    let attached = false;
    for (let p: THREE.Object3D | null = this.owner; p; p = p.parent) {
      if (p === this.parent) { attached = true; break; }
      if (!p.visible && p.userData?.[NO_DRAW_KEY] !== true) live = false;
      if (inCell === undefined) {
        const v = p.userData?.[CELL_LIGHTING_KEY];
        if (v === true || v === false) inCell = v;
      }
    }
    this.visible = attached && live;
    if (inCell === undefined) delete this.userData[CELL_LIGHTING_KEY];
    else this.userData[CELL_LIGHTING_KEY] = inCell;
    if (!attached) return;
    this.owner.updateWorldMatrix(true, false);
    this.matrixWorld.copy(this.owner.matrixWorld);
    this.matrixWorldNeedsUpdate = false;
  }

  override updateMatrixWorld(force?: boolean): void {
    this.sync();
    for (const c of this.children) c.updateMatrixWorld(true);
    void force;
  }

  override updateWorldMatrix(updateParents: boolean, updateChildren: boolean): void {
    this.sync();
    if (updateChildren) for (const c of this.children) c.updateWorldMatrix(false, true);
    void updateParents;
  }
}

/**
 * Object root → the carrier its lights hang off (when the sink gives a light
 * parent). A symbol-keyed property, not userData (Object3D.clone JSON-copies
 * userData) and not a WeakMap: DatLightBudget's gather walks the scene for
 * owners whose carrier must be re-attached after the owner came back.
 */
export const OBJECT_LIGHT_CARRIER: unique symbol = Symbol('objectLightCarrier');
type CarrierOwner = THREE.Object3D & { [OBJECT_LIGHT_CARRIER]?: ObjectLightCarrier };

/** The carrier holding `root`'s lights, if any. */
export function objectLightCarrierOf(root: THREE.Object3D): ObjectLightCarrier | undefined {
  return (root as CarrierOwner)[OBJECT_LIGHT_CARRIER];
}

let defaultSink: ObjectLightSink | null = null;

/** Wire the scene's light pool (main.ts: the DatLightBudget). null detaches. */
export function setObjectLightSink(sink: ObjectLightSink | null): void {
  defaultSink = sink;
}

/**
 * Object root → the PointLights its LIGHTLIST built. A WeakMap, not userData:
 * Object3D.clone JSON-copies userData, and a clone (paperdoll, examine) must
 * not believe it owns the live object's lights.
 */
const objectLights = new WeakMap<THREE.Object3D, THREE.PointLight[]>();

/** True when a PhysicsState carries LightingOn (0x800) — the object has its Setup lights. */
export function hasLightingOn(physicsState: number): boolean {
  return (physicsState & PhysicsState.LightingOn) !== 0;
}

/** The PointLights currently attached to `root` as its object lights. */
export function objectLightsOf(root: THREE.Object3D): readonly THREE.PointLight[] {
  return objectLights.get(root) ?? [];
}

/**
 * `CPartArray::InitLights` — build the object's lights from its Setup
 * LightInfos under `root` (the object's frame). `isStatic` = the owner's
 * PhysicsState Static bit (the LIGHTOBJ `state & 1` class). Replaces any
 * lights the root already had.
 */
export function initObjectLights(
  root: THREE.Object3D,
  lights: Iterable<LightInfo>,
  isStatic: boolean,
  sink: ObjectLightSink | null = defaultSink,
): THREE.PointLight[] {
  destroyObjectLights(root, sink);
  const made: THREE.PointLight[] = [];
  // BUG.hidden-object-lights-leave-pool — with a scene light parent the
  // lights hang off a carrier that follows the object, not off the object:
  // a Hidden / NoDraw object keeps them lit.
  let holder: THREE.Object3D = root;
  const lightParent = sink?.lightParent;
  // The root carries the object's scale (ObjScale); the light offset is
  // unscaled in retail, so undo it on the local position.
  const s = root.scale.x || 1;
  let n = 0;
  for (const info of lights) {
    // PrimD3DRender::config_hardware_light @ 0059ad30 — Diffuse = raw colour
    // bytes × intensity, Range = falloff × rangeAdjust (1.5), attenuation 1/d.
    // A static light carries the −intensity class tag (RetailLighting).
    const pl = new THREE.PointLight(
      rawByteColor(info.color),
      info.intensity,
      retailLightRange(info.falloff),
      isStatic ? retailStaticLightDecay(info.intensity) : 1,
    );
    const o = info.viewerSpaceLocation.origin;
    pl.position.set(o.x / s, o.z / s, o.y / s); // AC (x,y,z) → three (x,z,y)
    pl.name = `object-light-${n++}`;
    pl.userData.datLight = true;
    pl.userData.datLightDynamic = !isStatic;
    pl.userData.datLightTracked = true;
    pl.visible = false; // the pool enables it
    if (holder === root && lightParent) {
      const carrier = new ObjectLightCarrier(root);
      lightParent.add(carrier);
      (root as CarrierOwner)[OBJECT_LIGHT_CARRIER] = carrier;
      holder = carrier;
    }
    holder.add(pl);
    sink?.track(pl);
    made.push(pl);
  }
  if (made.length > 0) objectLights.set(root, made);
  if (holder instanceof ObjectLightCarrier) holder.sync();
  return made;
}

/** `CPartArray::DestroyLights` — remove the object's lights (and release them from the pool). */
export function destroyObjectLights(root: THREE.Object3D, sink: ObjectLightSink | null = defaultSink): void {
  const lights = objectLights.get(root);
  if (!lights) return;
  for (const pl of lights) {
    sink?.untrack(pl);
    pl.parent?.remove(pl);
  }
  objectLights.delete(root);
  const carrier = objectLightCarrierOf(root);
  if (carrier) {
    carrier.parent?.remove(carrier);
    delete (root as CarrierOwner)[OBJECT_LIGHT_CARRIER];
  }
}

/**
 * `CPhysicsObj::set_state`'s LightingOn edge: the object has its Setup
 * lights exactly while `physicsState & LightingOn`. Idempotent — an object
 * that already has them keeps them (retail only reacts to a bit CHANGE).
 */
export function syncObjectLights(
  root: THREE.Object3D,
  lights: ReadonlyMap<number, LightInfo> | undefined,
  physicsState: number,
  sink: ObjectLightSink | null = defaultSink,
): void {
  const want = hasLightingOn(physicsState) && !!lights && lights.size > 0;
  const have = objectLightsOf(root).length > 0;
  if (want && !have) initObjectLights(root, lights!.values(), (physicsState & PhysicsState.Static) !== 0, sink);
  else if (!want && have) destroyObjectLights(root, sink);
}

/** Release every object light under `root` (a subtree about to be disposed — wielded items included). */
export function releaseObjectLightsIn(root: THREE.Object3D, sink: ObjectLightSink | null = defaultSink): void {
  const roots: THREE.Object3D[] = [];
  root.traverse((o) => { if (objectLights.has(o)) roots.push(o); });
  for (const r of roots) destroyObjectLights(r, sink);
}

/** Strip object lights from a CLONE (paperdoll / examine viewports render their own light rig). */
export function stripClonedObjectLights(root: THREE.Object3D): void {
  const drop: THREE.Object3D[] = [];
  root.traverse((o) => { if (o.userData?.datLightTracked) drop.push(o); });
  for (const o of drop) o.parent?.remove(o);
}
