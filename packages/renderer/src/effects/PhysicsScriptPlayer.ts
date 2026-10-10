import * as THREE from 'three';
import {
  AnimationHookType,
  type AnimationHook, type SoundHookData, type CreateParticleHookData,
  type SetLightHookData, type NoDrawHookData,
  type ScaleHookData, type LuminousHookData, type DiffuseHookData,
  type TransparentHookData,
  type EtherealHookData, type CallPESHookData, type SetOmegaHookData,
  type ReplaceObjectHookData, type SoundTweakedHookData,
  type DestroyParticleHookData, type StopParticleHookData,
  type LuminousPartHookData, type DiffusePartHookData, type TransparentPartHookData,
  type TextureVelocityHookData, type TextureVelocityPartHookData, type SoundTableHookData,
  type DefaultScriptPartHookData,
} from '@ac/dat-parser/file-types/AnimationHook.js';
import { HUGE_QUANTUM } from '@ac/shared';
import type { PhysicsScript } from '@ac/dat-parser';
import type { ParticleEmitterInfo } from '@ac/dat-parser/file-types/ParticleEmitterInfo.js';
import type { SpellEffects } from './SpellEffects.js';
import type { SoundPlayer } from '../audio/SoundPlayer.js';
import type { ParticleFrameSource, ParticleSkyPass, ParticleSpriteOptions, ParticleSystem } from './ParticleSystem.js';
import type { SkyObjectFrame } from './SkyboxRenderer.js';
import { ownMeshMaterials } from '../models/MaterialOwnership.js';
import { setObjectNoDraw } from './ObjectLights.js';
import { DegradeLod } from '../models/DegradeLod.js';
import { CELL_LIGHTING_KEY } from '../models/RetailLighting.js';
import { PART_SCRIPT_MATERIAL_KEY, setPartMaterialValue, type PartScriptMaterial } from '../models/PartMaterialState.js';
import { TRANSLUCENCY_KEY, DEFAULT_TRANSLUCENCY, carryPartTranslucency, objectPart, objectParts, partMeshes, setObjectTranslucency, setPartTranslucency } from '../models/ObjectTranslucency.js';

/**
 * PhysicsScriptPlayer — the per-object script, hook and particle machinery of
 * retail's CPhysicsObj, driven against a rendered THREE.Object3D anchor (an
 * NPC, item, portal, the player, …).
 *
 *  - ScriptManager (AddScriptInternal @ 0051b310 / UpdateScripts @ 0051b480):
 *    each object plays its PhysicsScripts ONE AFTER ANOTHER — a script added
 *    while another is queued starts when the last queued one ends
 *    (`start = prev.start + prev.length`); an idle object starts it now.
 *  - PhysicsObjHooks (FPHook, process_hooks @ 00511550): the timed value
 *    ramps (scale, translucency, luminosity, diffusion, per part) and the
 *    delayed CallPES, each evaluated from its own start on the object's clock.
 *  - CAnimHook::Execute for every hook type — a script's steps and the
 *    object's animation frames (CSequence::execute_hooks @ 00524830 →
 *    add_anim_hook → process_hooks) run the same hooks (executeHook).
 *
 * The object's clock only runs while it is in the world: an object out of it
 * (setAnchorSuspended) runs nothing (`update_object` returns at once), and a
 * script played on it is dropped (`play_script @ 00510d30`: cell == 0).
 */

export interface PhysicsScriptDeps {
  spellEffects: SpellEffects;
  soundPlayer: SoundPlayer;
  /** Loader for ParticleEmitterInfo (0x32xxxxxx) — looked up per CreateParticle hook. */
  loadEmitterInfo: (emitterId: number) => ParticleEmitterInfo | null;
  /** The listener (the viewer): world position for attenuation, compass heading for the pan. */
  getListenerPos: () => { x: number; y: number; z: number; heading?: number };
  /**
   * Loader for nested scripts (CallPES hook) — `pes` is a 0x33xxxxxx
   * PhysicsScript ID. Returning null skips the nested call.
   */
  loadScript?: (scriptId: number) => PhysicsScript | null;
  /**
   * CPhysicsObj::play_default_script @ 005132b0 — the script an object's
   * DefaultScript[Part] hook plays: its PhysicsDesc DefaultScript (a
   * PlayScript type) looked up in its own PhysicsScriptTable by its
   * DefaultScriptIntensity (PhysicsScriptTable::GetScript). Null = the object
   * has no table / no entry: nothing plays. Absent → the hooks do nothing.
   */
  resolveDefaultScript?: (anchor: THREE.Object3D) => PhysicsScript | null;
  /**
   * Resolves the sprite quad (texture + additive bit + quad extent) a
   * ParticleEmitterInfo renders with — see resolveEmitterSprite. Callers
   * should cache per emitter id. Absent/null → untextured point fallback.
   */
  resolveEmitterSprite?: (info: ParticleEmitterInfo) => ParticleSpriteOptions | null;
  /**
   * Streamed DATs: null when the emitter's files (its info, HW GfxObj,
   * surfaces, textures) are resident, else a promise for their arrival. The
   * emitter is then created on arrival instead of now: without its sprite
   * every particle draws as an untextured white square (the login bubbles and
   * other players' buffs, 2026-10-06, right after streaming went live).
   */
  emitterPending?: (emitterInfoId: number) => Promise<void> | null;
  /**
   * SoundTableHook::Execute — play `soundType` from the anchor's own
   * SoundTable (CPhysicsObj::play_sound → its sound table) at `pos`.
   * Absent → SoundTable hooks are skipped.
   */
  playSoundTableSound?: (anchor: THREE.Object3D, soundType: number, pos: { x: number; y: number; z: number }) => void;
  /**
   * SetLightHook::Execute @ 00526fd0 → CPhysicsObj::set_lights @ 0050fcf0 on
   * the anchor's object: LightingOn on/off and its Setup lights built /
   * destroyed (ServerObjectManager.setLights). Absent → only
   * `anchor.userData.lit` records it.
   */
  setLights?: (anchor: THREE.Object3D, on: boolean) => void;
  /**
   * NoDrawHook::Execute @ 00526be0 → CPhysicsObj::set_nodraw @ 0050fca0 on
   * the anchor's server object (its PhysicsState NoDraw bit). Returns true
   * when the anchor is a server object and the state was set; otherwise the
   * hook hides the anchor directly (our player, statics).
   */
  setNoDraw?: (anchor: THREE.Object3D, on: boolean) => boolean;
  /** Random::RollDice(0, max) — injectable for tests; default uniform. */
  rollDice?: (min: number, max: number) => number;
}

/** F_EPSILON (globals.tsv): a ramp shorter than this applies its end value at once. */
export const F_EPSILON = 0.0002;

/** CreateParticleHook part_index meaning "the object itself" (0xFFFFFFFF). */
const NO_PART = 0xFFFFFFFF;

const PART_NAME_RE = /^part_\d+$/;

/**
 * Part-node userData key: the luminosity / diffusion a script last set on
 * the part (CPhysicsPart's material copy — SetLuminosity @ 0050e5f0,
 * SetDiffusion), so a rebuilt part node draws them too.
 */
export { PART_SCRIPT_MATERIAL_KEY };

/**
 * The node an emitter rides: the object, or its part `partIndex` — the
 * setup group's DIRECT `part_N` child (a wielded item's own `part_N` must
 * not shadow the owner's; see AnimatedEntity.collectPartObjects).
 */
export function emitterParentNode(anchor: THREE.Object3D, partIndex: number): THREE.Object3D {
  if ((partIndex >>> 0) === NO_PART) return anchor;
  return objectPart(anchor, partIndex) ?? anchor;
}

/**
 * ParticleEmitter::SetParenting @ 0051c190 — the frame an emitter follows:
 * the parent node's live world transform, with the hook's offset in the
 * parent's local frame (AC axes). Gone once the node leaves the scene graph.
 */
export function makeEmitterFrameSource(node: THREE.Object3D, offset: { x: number; y: number; z: number }, partIndex?: number): ParticleFrameSource {
  const inScene = (): boolean => {
    let root: THREE.Object3D = node;
    while (root.parent) root = root.parent;
    return (root as THREE.Scene).isScene === true;
  };
  // A parent that was drawn and has since left the scene (despawned) is
  // gone; one never placed in a scene is a bare frame. A rebuilt parent is
  // not gone: rebind moves the frame to the new mesh's matching node.
  let wasInScene = inScene();
  return {
    offset: { x: offset.x, y: offset.y, z: offset.z },
    rebind(from, to) {
      if (!isUnder(node, from)) return;
      // A part node swapped in place (the local player's part transplant):
      // the emitter rides its replacement.
      node = node === from && PART_NAME_RE.test(from.name) ? to
        : partIndex !== undefined ? emitterParentNode(to, partIndex)
        : node === from ? to
        : (/^part_\d+$/.test(node.name) ? objectPart(to, Number(node.name.slice(5))) : null) ?? to;
      wasInScene = inScene();
    },
    getFrame(outPos, outQuat) {
      if (wasInScene && !inScene()) return false;
      node.updateWorldMatrix(true, false);
      node.matrixWorld.decompose(outPos, outQuat, EMITTER_SCALE_SCRATCH);
      return true;
    },
    // VISUAL.particle-surfaces-unlit — the particle object is drawn in its
    // parent's pass: an owner in an env cell (setCellLighting's
    // CELL_LIGHTING_KEY) draws its particles under useSunlightSet(0).
    inCell() {
      for (let n: THREE.Object3D | null = node; n; n = n.parent) {
        const v = n.userData[CELL_LIGHTING_KEY];
        if (v !== undefined) return v === true;
      }
      return false;
    },
    // The particle object shares its parent's cell: an outdoor (land-cell)
    // owner is tagged DegradeLod.LAND_CELL_KEY by the object streamers.
    inLandCell() {
      for (let n: THREE.Object3D | null = node; n; n = n.parent) {
        const v = n.userData[DegradeLod.LAND_CELL_KEY];
        if (v !== undefined) return v === true;
      }
      return false;
    },
  };
}
const EMITTER_SCALE_SCRATCH = new THREE.Vector3();

/**
 * VISUAL.night-sky-vs-retail.a — the frame a SETUP sky object's emitter
 * rides: the sky object's physics frame (SkyObjectFrame, GameSky::
 * UpdatePosition @ 00506dd0), LOCAL to the viewer's current landblock, with
 * that landblock as the cell each particle is stamped with at emission
 * (AddPartToShadowCells @ 00510e00). So the always-on drifters
 * (0x2000714) sit at the landblock origin + 250 m, not on the camera, and a
 * particle stays in the landblock it was born in until it dies. The anchor
 * leaving the sky group (slot closed, group rebuilt) ends the frame.
 */
export function makeSkyEmitterFrameSource(anchor: THREE.Object3D, frame: SkyObjectFrame, offset: { x: number; y: number; z: number }): ParticleFrameSource {
  return {
    offset: { x: offset.x, y: offset.y, z: offset.z },
    getFrame(outPos, outQuat) {
      if (!anchor.parent) return false;
      outPos.copy(frame.local);
      outQuat.copy(anchor.quaternion);
      return true;
    },
    cellOrigin(out) {
      out.copy(frame.cell);
    },
    // The sky cells are env cells (CEnvCell::GetViewerDistance is 0, so the
    // per-object distance applies), drawn in the sky pass, not a cell pass.
    inCell: () => false,
    inLandCell: () => false,
  };
}

/** ScriptManager's ScriptData: a queued script and its start on the object's clock. */
interface ScriptData { script: PhysicsScript; start: number; length: number }

/** The FPHook kinds process_fp_hook @ 005135c0 switches on. */
type FPKind = 'scale' | 'translucency' | 'partTranslucency' | 'luminosity' | 'diffusion'
  | 'partLuminosity' | 'partDiffusion' | 'callPES';

/** FPHook: a value ramped from `from` to `to` over `duration` from `created` (object clock). */
interface FPHook {
  kind: FPKind;
  created: number;
  duration: number;
  from: number;
  to: number;
  /** The part index (part ramps). */
  part: number;
  /** The nested script (CallPES). */
  script: PhysicsScript | null;
}

/** One object's script manager + hook list + clock. */
interface ObjState {
  /** The object's own time (s) — runs only while it is in the world. */
  clock: number;
  /** ScriptManager's queue, current first. */
  scripts: ScriptData[];
  /** Index of the last hook fired in scripts[0] (hook_index; −1 = none yet). */
  hookIndex: number;
  /** PhysicsObjHooks, newest first (CallPES / SetTranslucency2 … push at the head). */
  hooks: FPHook[];
}

/** PhysicsScript's length: its last hook's start time (UnPack sorts, then keeps the last). */
function scriptLength(script: PhysicsScript): number {
  let len = 0;
  for (const s of script.steps) if (s.startTime > len) len = s.startTime;
  return len;
}

/** CPhysics's GfxVelocityDesc: a GfxObj's scroll velocity and accumulated UV offset. */
interface GfxVelocity {
  u: number;
  v: number;
  totalU: number;
  totalV: number;
  /** The part nodes drawing this GfxObj that the offset is written to. */
  nodes: Set<THREE.Object3D>;
}

/** Part-node userData key the SetupModelRenderer tags with the part's GfxObj DID. */
export const PART_GFXOBJ_KEY = 'gfxObjId';

export class PhysicsScriptPlayer {
  private deps: PhysicsScriptDeps;
  /**
   * Anchors with continuous SetOmega rotation. Applied per update(dt) tick;
   * call removeOmega(anchor) to stop spinning.
   */
  private omegaAnchors: Set<THREE.Object3D> = new Set();
  /**
   * DECOMP.texture-velocity-shared — CPhysics::texture_velocity_gids: one
   * entry per GfxObj (keyed by its DID; a part node with no DID tag is its
   * own key), set — never added to — by AddGfxVelocity @ 00509b60 and
   * advanced once per tick by UpdateTexVelocity @ 00509820.
   */
  private gfxVelocities = new Map<number | THREE.Object3D, GfxVelocity>();
  /**
   * The object's ParticleManager: every emitter it owns (endless ones never
   * finish on their own). ~CPhysicsObj deletes them all, so stopForAnchor()
   * disposes them explicitly.
   */
  private objectSystems: Map<THREE.Object3D, Set<ParticleSystem>> = new Map();
  /**
   * ParticleManager's emitter table per object, keyed by the hooks'
   * emitter_id: CreateParticleEmitter with a non-zero id first destroys the
   * emitter already holding it; StopParticle / DestroyParticle address it.
   */
  private emittersById: Map<THREE.Object3D, Map<number, ParticleSystem>> = new Map();
  /**
   * FX.pending-emitter-misses-stop — emitters still waiting for their
   * streamed files, by hook emitter id. Retail creates an emitter the
   * moment its hook runs (DBObj::Get blocks), so a later StopParticle /
   * DestroyParticle / same-id Create always finds it; here those land on
   * the slot and apply, in hook order, when the files do. (An UnHide's
   * StopParticle that missed its Hidden emitters left the bubbles running.)
   */
  private pendingEmitters: Map<THREE.Object3D, Map<number, { stopped: boolean; cancelled: boolean }>> = new Map();
  /**
   * BUG.sky-emitters-fog-on-environs — the live emitters of the sky cell's
   * objects, and whether an Environs fog override is up: GameSky::Draw
   * @ 00506ff0 draws the sky with `SetFFFogEnable(LScape::m_override_enabled)`,
   * so sky particles are unfogged normally and fogged under the override.
   */
  private skySystems = new Set<ParticleSystem>();
  private skyFogOverride = false;
  /** Per-object script manager / hook list / clock. */
  private states = new Map<THREE.Object3D, ObjState>();
  /**
   * transferAnchor's old mesh → new mesh, for emitters created after a
   * rebuild (a streamed emitter's files landing). Weak: a disposed mesh goes.
   */
  private readonly anchorForward = new WeakMap<THREE.Object3D, THREE.Object3D>();
  /** update()'s reusable snapshot of `states` (no per-frame allocation). */
  private readonly stateScratch: Array<[THREE.Object3D, ObjState]> = [];

  constructor(deps: PhysicsScriptDeps) {
    this.deps = deps;
  }

  private stateFor(anchor: THREE.Object3D): ObjState {
    let st = this.states.get(anchor);
    if (!st) {
      st = { clock: 0, scripts: [], hookIndex: -1, hooks: [] };
      this.states.set(anchor, st);
    }
    return st;
  }

  /**
   * CPhysicsObj::play_script @ 00510d30 → play_script_internal @ 00510cd0 →
   * ScriptManager::AddScriptInternal @ 0051b310: queue `script` on the
   * object. An object out of the world plays nothing (cell == 0 → return).
   * Hooks already due (an idle object's t=0 hooks) fire now, so a caller's
   * anchor-position lookups are accurate before any later reposition.
   */
  play(script: PhysicsScript, anchor: THREE.Object3D): void {
    // DECOMP.scripts-replayed-on-reentry — play_script drops it outright.
    if (this.suspendedAnchors.has(anchor)) return;
    this.playInternal(script, anchor);
  }

  /**
   * CPhysicsObj::play_script_internal @ 00510cd0 itself: no cell test, so
   * the script queues on an object out of the world and runs once it is
   * back (update_object resumes). set_hidden @ 00514c60 plays its Hidden /
   * UnHide scripts this way (as do InitDefaults and makeObject): an UnHide
   * that lands while the object's cell is still loading must not be lost,
   * or the Hidden script's bubbles and fade outlive the Hidden state.
   */
  playInternal(script: PhysicsScript, anchor: THREE.Object3D): void {
    if (!script.steps.length) return;
    const st = this.stateFor(anchor);
    const last = st.scripts[st.scripts.length - 1];
    const start = last ? last.start + last.length : st.clock;
    st.scripts.push({ script, start, length: scriptLength(script) });
    if (st.scripts.length === 1) st.hookIndex = -1;
    // Out of the world, update_object does not run: it waits for the return.
    if (this.suspendedAnchors.has(anchor)) return;
    this.runScripts(anchor, st);
    this.processHooks(anchor, st);
  }

  /**
   * ScriptManager::UpdateScripts @ 0051b480: fire every hook of the queue
   * whose time (script start + hook start) has come, in order; a script
   * whose hooks are all fired leaves the queue and the next one continues.
   */
  private runScripts(anchor: THREE.Object3D, st: ObjState): void {
    for (;;) {
      const cur = st.scripts[0];
      if (!cur) return;
      const idx = st.hookIndex + 1;
      if (idx >= cur.script.steps.length) {
        st.scripts.shift();
        st.hookIndex = -1;
        continue;
      }
      if (cur.start + cur.script.steps[idx].startTime > st.clock) return;
      st.hookIndex = idx;
      this.dispatchHook(cur.script.steps[idx].hook, anchor);
      // A hook may have removed the object (stopForAnchor) mid-script.
      if (this.states.get(anchor) !== st) return;
    }
  }

  /**
   * CPhysicsObj::process_hooks @ 00511550 (its PhysicsObjHook half):
   * FPHook::Execute @ 0051baa0 for each — fraction = elapsed / duration
   * (0 until time has passed, 1 once it is over), value = from + (to − from)
   * · fraction handed to process_fp_hook @ 005135c0 — and the hook is
   * deleted once its fraction reaches 1.
   */
  private processHooks(anchor: THREE.Object3D, st: ObjState): void {
    if (st.hooks.length === 0) return;
    // Hooks a CallPES'd script starts meanwhile go on the (new) head.
    const hooks = st.hooks;
    st.hooks = [];
    let w = 0;
    for (let i = 0; i < hooks.length; i++) {
      const h = hooks[i];
      const elapsed = st.clock - h.created;
      const frac = elapsed > 0 ? (elapsed < h.duration ? elapsed / h.duration : 1) : 0;
      this.processFpHook(anchor, h, (h.to - h.from) * frac + h.from);
      if (frac !== 1) hooks[w++] = h;
    }
    hooks.length = w;
    if (st.hooks.length > 0) st.hooks.push(...hooks);
    else st.hooks = hooks;
  }

  /** CPhysicsObj::process_fp_hook @ 005135c0. */
  private processFpHook(anchor: THREE.Object3D, h: FPHook, value: number): void {
    switch (h.kind) {
      case 'scale': anchor.scale.setScalar(value); break;
      case 'translucency': setObjectTranslucency(anchor, value); break;
      case 'partTranslucency': {
        const part = objectPart(anchor, h.part);
        if (part) setPartTranslucency(part, value);
        break;
      }
      case 'luminosity': this.applyMaterialValue('luminous', anchor, value); break;
      case 'diffusion': this.applyMaterialValue('diffuse', anchor, value); break;
      case 'partLuminosity': this.applyMaterialValue('luminous', anchor, value, h.part); break;
      case 'partDiffusion': this.applyMaterialValue('diffuse', anchor, value, h.part); break;
      case 'callPES':
        // CallPESInternal @ 00511ac0: at the end of the wait, if in the world.
        if (value >= 1 && h.script && !this.suspendedAnchors.has(anchor)) this.play(h.script, anchor);
        break;
    }
  }

  /**
   * The SetScale / SetTranslucency2 / SetLuminosity / … shape: a ramp of at
   * least F_EPSILON becomes an FPHook at the head of the object's hook list;
   * a shorter one applies its end value at once.
   */
  private addRamp(anchor: THREE.Object3D, kind: FPKind, from: number, to: number, time: number, part = 0, script: PhysicsScript | null = null): void {
    if (time >= F_EPSILON) {
      const st = this.stateFor(anchor);
      st.hooks.unshift({ kind, created: st.clock, duration: time, from, to, part, script });
      return;
    }
    this.processFpHook(anchor, { kind, created: 0, duration: 0, from, to, part, script }, to);
  }

  /**
   * Advance every object in the world by `dt` seconds: its queued scripts,
   * its hooks, and the global texture scroll.
   */
  update(dt: number): void {
    this.updateTexVelocity(dt);
    // SOUND.hook-stall-burst — the omega spin is CPhysicsObj::
    // UpdatePhysicsInternal, inside update_object, which a step over
    // HUGE_QUANTUM skips. The script clock below is not: ScriptManager::
    // UpdateScripts and FPHook::Execute read absolute time, so overdue
    // script hooks still run on return (UpdateTexVelocity takes the raw delta).
    if (this.omegaAnchors.size > 0 && dt <= HUGE_QUANTUM) {
      const tmpQuat = new THREE.Quaternion();
      const tmpVec = new THREE.Vector3();
      for (const anchor of this.omegaAnchors) {
        if (this.suspendedAnchors.has(anchor)) continue;
        const omega = anchor.userData.omega as { x: number; y: number; z: number } | undefined;
        if (!omega) { this.omegaAnchors.delete(anchor); continue; }
        // Axis-angle rotation: angle = |omega| * dt, axis = omega normalized.
        const len = Math.sqrt(omega.x * omega.x + omega.y * omega.y + omega.z * omega.z);
        if (len === 0) { this.omegaAnchors.delete(anchor); continue; }
        // AC Z-up → THREE Y-up: swap Y and Z.
        tmpVec.set(omega.x / len, omega.z / len, omega.y / len);
        tmpQuat.setFromAxisAngle(tmpVec, len * dt);
        anchor.quaternion.multiplyQuaternions(tmpQuat, anchor.quaternion);
      }
    }

    if (this.states.size === 0) return;
    const snap = this.stateScratch;
    snap.length = 0;
    for (const e of this.states) snap.push(e);
    for (const [anchor, st] of snap) {
      if (this.states.get(anchor) !== st) continue; // stopped by an earlier object's hook
      if (this.suspendedAnchors.has(anchor)) continue;
      st.clock += dt;
      this.runScripts(anchor, st);
      if (this.states.get(anchor) !== st) continue;
      this.processHooks(anchor, st);
      if (st.scripts.length === 0 && st.hooks.length === 0 && this.states.get(anchor) === st) this.states.delete(anchor);
    }
    snap.length = 0;
  }

  /**
   * CPhysics::UpdateTexVelocity @ 00509820 — once per tick, each GfxObj's
   * accumulated offset advances by velocity · dt (wrapping back by 1 once it
   * has reached 1) and is written as that GfxObj's UV delta
   * (CGfxObj::TexVelocity @ 005341d0): every part drawing it scrolls by the
   * same amount, however many objects set it.
   */
  private updateTexVelocity(dt: number): void {
    for (const [key, g] of this.gfxVelocities) {
      if (g.nodes.size === 0) { this.gfxVelocities.delete(key); continue; }
      let du = dt * g.u;
      let dv = dt * g.v;
      if (g.totalU >= 1) du -= 1;
      if (g.totalV >= 1) dv -= 1;
      g.totalU += du;
      g.totalV += dv;
      for (const node of g.nodes) {
        for (const mesh of partMeshes(node)) {
          for (const mat of ownMeshMaterials(mesh)) {
            const m = mat as THREE.Material & { map?: THREE.Texture | null };
            if (!m.map) continue;
            // The UV delta is this part's own: a MaterialFactory texture is
            // shared by every surface user, so the part draws a copy of it
            // (same image source, its own offset).
            if (!m.map.userData.acUvOwned) {
              m.map = m.map.clone();
              m.map.userData.acUvOwned = true;
            }
            m.map.offset.set(g.totalU, g.totalV);
          }
        }
      }
    }
  }

  /**
   * CPhysics::AddGfxVelocity @ 00509b60 for one part: the GfxObj's entry
   * takes the new velocity (0,0 removes it); a new GfxObj gets an entry
   * starting at offset 0.
   */
  private addGfxVelocity(part: THREE.Object3D, u: number, v: number): void {
    const key = (part.userData[PART_GFXOBJ_KEY] as number | undefined) ?? part;
    const g = this.gfxVelocities.get(key);
    if (g) {
      if (u !== 0 || v !== 0) {
        g.u = u; g.v = v;
        g.nodes.add(part);
      } else {
        this.gfxVelocities.delete(key);
      }
      return;
    }
    this.gfxVelocities.set(key, { u, v, totalU: 0, totalV: 0, nodes: new Set([part]) });
  }

  /** The texture-scroll velocity set on a part's GfxObj (probes / tests), or null. */
  gfxVelocityOf(part: THREE.Object3D): { u: number; v: number; totalU: number; totalV: number } | null {
    const key = (part.userData[PART_GFXOBJ_KEY] as number | undefined) ?? part;
    const g = this.gfxVelocities.get(key);
    return g ? { u: g.u, v: g.v, totalU: g.totalU, totalV: g.totalV } : null;
  }

  /**
   * Apply a luminous / diffuse value to the anchor's parts' materials — or,
   * with `partIdx`, to that one DIRECT part (never a wielded item's part).
   */
  private applyMaterialValue(kind: 'luminous' | 'diffuse', anchor: THREE.Object3D, value: number, partIdx?: number): void {
    let parts: THREE.Object3D[];
    if (partIdx !== undefined) {
      const part = objectPart(anchor, partIdx);
      if (!part) return;
      parts = [part];
    } else {
      parts = objectParts(anchor);
    }
    for (const part of parts) this.applyPartMaterialValue(kind, part, value);
  }

  /**
   * One part's luminous / diffuse value (CPhysicsPart::SetLuminosity /
   * SetDiffusion), remembered on the part node (PART_SCRIPT_MATERIAL_KEY) so
   * a rebuilt or transplanted part, a degrade level built later
   * (RENDER.lazy-lod-misses-state) and the cell / landscape material swap
   * all keep it (PartMaterialState).
   */
  private applyPartMaterialValue(kind: 'luminous' | 'diffuse', part: THREE.Object3D, value: number): void {
    setPartMaterialValue(kind, part, value);
  }

  /**
   * FX.part-script-state-lost-on-rebuild — the part node `from` was rebuilt
   * as `to`. Retail keeps the CPhysicsPart and swaps only its GfxObj
   * (CPartArray::SetPart @ 00518580 → CPhysicsPart::SetPart @ 0050e700), so
   * the translucency, luminosity and diffusion a script left on it stay.
   */
  private carryPartState(from: THREE.Object3D, to: THREE.Object3D): void {
    carryPartTranslucency(from, to);
    const rec = from.userData[PART_SCRIPT_MATERIAL_KEY] as PartScriptMaterial | undefined;
    if (rec?.luminous !== undefined) this.applyPartMaterialValue('luminous', to, rec.luminous);
    if (rec?.diffuse !== undefined) this.applyPartMaterialValue('diffuse', to, rec.diffuse);
  }

  /** Anchors whose emitters are hidden (their static object is not drawn). */
  private hiddenAnchors = new Set<THREE.Object3D>();

  /**
   * VISUAL.dat-static-default-scripts — show / hide the emitters an
   * anchor owns (a DAT static in a cell or block that is not drawn draws no
   * particles either). Emitters it creates while hidden start hidden.
   */
  setAnchorParticlesVisible(anchor: THREE.Object3D, visible: boolean): void {
    if (visible) this.hiddenAnchors.delete(anchor);
    else this.hiddenAnchors.add(anchor);
    this.applyEmitterVisibility(anchor);
  }

  /** Anchors out of the world (a lost-cell server object): frozen, emitters hidden. */
  private suspendedAnchors = new Set<THREE.Object3D>();

  /**
   * BUG.teleport-leaves-stale-objects — CPhysicsObj::leave_visibility /
   * reenter_visibility for everything this player runs on an object: while
   * suspended, `update_object` (@ 00515d10) does not run for it — its
   * scripts, ramps, spin and pending CallPES stand still, its hook sounds do
   * not fire, and its emitters (out of every cell) are not drawn. Resuming
   * carries on where it stopped. Scripts played on it meanwhile are gone
   * (play_script @ 00510d30 returns when cell == 0).
   */
  setAnchorSuspended(anchor: THREE.Object3D, suspended: boolean): void {
    if (suspended === this.suspendedAnchors.has(anchor)) return;
    if (suspended) this.suspendedAnchors.add(anchor);
    else this.suspendedAnchors.delete(anchor);
    this.applyEmitterVisibility(anchor);
  }

  /** Whether `anchor` is out of the world (see setAnchorSuspended). */
  isAnchorSuspended(anchor: THREE.Object3D): boolean {
    return this.suspendedAnchors.has(anchor);
  }

  /** An anchor's emitters draw unless it is hidden (static not drawn) or suspended (out of the world). */
  private applyEmitterVisibility(anchor: THREE.Object3D): void {
    const visible = !this.hiddenAnchors.has(anchor) && !this.suspendedAnchors.has(anchor);
    const systems = this.objectSystems.get(anchor);
    if (systems) for (const system of systems) system.object3D.visible = visible;
    const byId = this.emittersById.get(anchor);
    if (byId) for (const system of byId.values()) system.object3D.visible = visible;
  }

  /** Queued scripts on anchors that pass `filter` (the server-object cap skips DAT statics). */
  countActive(filter: (anchor: THREE.Object3D) => boolean): number {
    let n = 0;
    for (const [anchor, st] of this.states) if (filter(anchor)) n += st.scripts.length;
    return n;
  }

  /** The scripts queued on one object, current first (probes / tests). */
  queuedScripts(anchor: THREE.Object3D): readonly PhysicsScript[] {
    return (this.states.get(anchor)?.scripts ?? []).map(d => d.script);
  }

  /** Cancel everything targeting the given anchor (e.g. when the object unloads). */
  stopForAnchor(anchor: THREE.Object3D): void {
    this.hiddenAnchors.delete(anchor);
    this.suspendedAnchors.delete(anchor);
    // ~CPhysicsObj: its script manager and hook list (pending CallPES included) go.
    this.states.delete(anchor);
    this.omegaAnchors.delete(anchor);
    for (const [key, g] of this.gfxVelocities) {
      for (const node of g.nodes) if (isUnder(node, anchor)) g.nodes.delete(node);
      if (g.nodes.size === 0) this.gfxVelocities.delete(key);
    }
    const systems = this.objectSystems.get(anchor);
    if (systems) {
      for (const system of systems) this.deps.spellEffects.removeParticleSystem(system);
      this.objectSystems.delete(anchor);
    }
    // The object's particle manager goes with it (~CPhysicsObj).
    const byId = this.emittersById.get(anchor);
    if (byId) {
      for (const system of byId.values()) this.deps.spellEffects.removeParticleSystem(system);
      this.emittersById.delete(anchor);
    }
    const pendingById = this.pendingEmitters.get(anchor);
    if (pendingById) {
      for (const slot of pendingById.values()) slot.cancelled = true;
      this.pendingEmitters.delete(anchor);
    }
  }

  /**
   * Execute one animation-frame hook against an object — CSequence::
   * execute_hooks @ 00524830 → add_anim_hook → process_hooks @ 00511550 →
   * CAnimHook::Execute: EVERY hook type runs on the animating object (the
   * cast windup's hand glow, a gromnie's breath via DefaultScript, a
   * statue's TransparentPart, footsteps …). Ramps it starts keep running.
   */
  executeHook(hook: AnimationHook, anchor: THREE.Object3D): void {
    // An object out of the world runs no animation hooks.
    if (this.suspendedAnchors.has(anchor)) return;
    this.dispatchHook(hook, anchor);
    const st = this.states.get(anchor);
    if (st) this.processHooks(anchor, st);
  }

  /**
   * BUG.sky-emitters-fog-on-environs — LScape::m_override_enabled changed
   * (the AdminEnvirons fog set / cleared): sky emitters draw fogged while it
   * is on (GameSky::Draw @ 00506ff0 → SetFFFogEnable(m_override_enabled)).
   */
  setSkyFogOverride(active: boolean): void {
    this.skyFogOverride = active;
    this.pruneSkySystems();
    for (const s of this.skySystems) s.setFogEnabled?.(active);
  }

  /** Whether sky emitters currently draw fogged (probes / tests). */
  get skyFogOverrideActive(): boolean { return this.skyFogOverride; }

  /** The live sky-cell emitters (probes / tests). */
  get skyEmitters(): ReadonlySet<ParticleSystem> {
    this.pruneSkySystems();
    return this.skySystems;
  }

  private pruneSkySystems(): void {
    for (const s of this.skySystems) {
      if (s.isDone || !s.object3D?.parent) this.skySystems.delete(s);
    }
  }

  /** Live emitters an object owns by hook emitter id (probes / tests). */
  emittersFor(anchor: THREE.Object3D): ReadonlyMap<number, ParticleSystem> {
    return this.emittersById.get(anchor) ?? new Map();
  }

  /** Script-owned per-anchor state kept on userData (hooks write these). */
  private static readonly ANCHOR_STATE_KEYS = [
    'setupId', 'omega', 'lit', 'ethereal', 'particleDestroy', 'particleStop',
  ] as const;

  /**
   * REND.appearance-rebuild-orphans-emitters — an appearance update rebuilt
   * the object's mesh. Retail keeps the same CPhysicsObj across an ObjDesc
   * change (CPhysicsObj::DoObjDescChanges @ 0050fa30 only swaps the part
   * array's parts), so its running scripts, hooks, spin, UV scroll and
   * endless emitters carry on: re-key all of it from the orphaned mesh to
   * the new one instead of leaving it running against a mesh nothing draws.
   */
  transferAnchor(from: THREE.Object3D, to: THREE.Object3D): void {
    if (from === to) return;
    // FX.pending-emitter-orphaned-by-rebuild — an emitter still waiting for
    // its streamed files finds the object on its new mesh when they land.
    this.anchorForward.delete(to);
    this.anchorForward.set(from, to);
    if (this.suspendedAnchors.delete(from)) this.suspendedAnchors.add(to);
    const st = this.states.get(from);
    if (st) {
      this.states.delete(from);
      const existing = this.states.get(to);
      if (existing) {
        for (const d of st.scripts) existing.scripts.push(d);
        existing.hooks.unshift(...st.hooks);
      } else {
        this.states.set(to, st);
      }
    }
    for (const key of PhysicsScriptPlayer.ANCHOR_STATE_KEYS) {
      if (key in from.userData && !(key in to.userData)) to.userData[key] = from.userData[key];
    }
    if (this.omegaAnchors.delete(from)) this.omegaAnchors.add(to);
    // UV scroll: the new parts are drawn from the same GfxObjs.
    for (const g of this.gfxVelocities.values()) {
      for (const node of [...g.nodes]) {
        if (!isUnder(node, from)) continue;
        g.nodes.delete(node);
        const part = node === from ? to : (node.name ? objectPart(to, Number(node.name.slice(5))) : null);
        if (part) g.nodes.add(part);
      }
    }
    const byId = this.emittersById.get(from);
    if (byId) {
      this.emittersById.delete(from);
      const existing = this.emittersById.get(to);
      if (existing) for (const [id, sys] of byId) existing.set(id, sys);
      else this.emittersById.set(to, byId);
    }
    const pendingById = this.pendingEmitters.get(from);
    if (pendingById) {
      this.pendingEmitters.delete(from);
      const existing = this.pendingEmitters.get(to);
      if (existing) for (const [id, slot] of pendingById) existing.set(id, slot);
      else this.pendingEmitters.set(to, pendingById);
    }
    const systems = this.objectSystems.get(from);
    if (systems) {
      // Each emitter follows its part on the new mesh (the old parts are disposed).
      for (const sys of systems) sys.rebindParent(from, to);
      this.objectSystems.delete(from);
      const existing = this.objectSystems.get(to);
      if (existing) for (const sys of systems) existing.add(sys);
      else this.objectSystems.set(to, systems);
    }
    // FX.part-script-state-lost-on-rebuild — each part keeps its script values.
    const fromParts = from.children.filter(c => PART_NAME_RE.test(c.name));
    if (fromParts.length === 0) {
      if (!to.children.some(c => PART_NAME_RE.test(c.name))) this.carryPartState(from, to);
    } else {
      for (const part of fromParts) {
        const next = objectPart(to, Number(part.name.slice(5)));
        if (next) this.carryPartState(part, next);
      }
    }
    this.reapplyObjectTranslucency(to);
  }

  /**
   * CPhysicsObj::DoObjDescChanges @ 0050fa30: after the parts change, a
   * non-default object translucency is set on every part again.
   */
  private reapplyObjectTranslucency(anchor: THREE.Object3D): void {
    const t = anchor.userData[TRANSLUCENCY_KEY] as number | undefined;
    if (t !== undefined && t !== DEFAULT_TRANSLUCENCY) setObjectTranslucency(anchor, t);
  }

  /**
   * FX.player-transplant-kills-part-emitters — `anchor` stays, but some of
   * its part nodes were replaced in place (`[old, new]` pairs; the local
   * player's appearance change, transplantPartChildren). Retail keeps every
   * CPhysicsPart and swaps only its GfxObj (CPartArray::DoObjDescChanges
   * @ 00519210 → SetPart @ 00518580 → CPhysicsPart::SetPart @ 0050e700), so
   * the emitters parented to a part (ParticleEmitter::SetParenting
   * @ 0051c190) ride the new one, its GfxObj's texture scroll keeps writing
   * to it, and its script translucency / luminosity / diffusion stay.
   */
  transferParts(anchor: THREE.Object3D, pairs: ReadonlyArray<readonly [THREE.Object3D, THREE.Object3D]>): void {
    const systems = this.objectSystems.get(anchor);
    for (const [from, to] of pairs) {
      if (from === to) continue;
      if (systems) for (const sys of systems) sys.rebindParent(from, to);
      // CPhysics::texture_velocity_gids is keyed by GfxObj: the new part
      // scrolls with its entry when it draws the same GfxObj.
      const toKey = (to.userData[PART_GFXOBJ_KEY] as number | undefined) ?? to;
      for (const [key, g] of [...this.gfxVelocities]) {
        if (!g.nodes.delete(from)) continue;
        if (key === from) {
          this.gfxVelocities.delete(key);
          if (!this.gfxVelocities.has(toKey)) { g.nodes.add(to); this.gfxVelocities.set(toKey, g); }
        } else if (key === toKey) {
          g.nodes.add(to);
        }
      }
      this.carryPartState(from, to);
    }
    // An emitter whose part was not built yet rode the object itself
    // (emitterParentNode's fallback): re-resolve every emitter by its hook's
    // part index, so it moves onto a part_N the new parts brought.
    if (systems) for (const sys of systems) sys.rebindParent(anchor, anchor);
    this.reapplyObjectTranslucency(anchor);
  }

  /** The anchor an object's mesh `anchor` now lives on (transferAnchor's forwarding, followed). */
  private currentAnchor(anchor: THREE.Object3D): THREE.Object3D {
    let a = anchor;
    // Bounded: transferAnchor clears a target's own forward, so no cycle forms.
    for (let i = 0; i < 64; i++) {
      const next = this.anchorForward.get(a);
      if (!next) break;
      a = next;
    }
    return a;
  }

  /** Scripts queued plus timed hooks pending, over every object — for debug/perf inspection. */
  get activeCount(): number {
    let n = 0;
    for (const st of this.states.values()) n += st.scripts.length + st.hooks.length;
    return n;
  }

  private destroyEmitter(anchor: THREE.Object3D, emitterId: number): void {
    const slot = this.pendingEmitters.get(anchor)?.get(emitterId >>> 0);
    if (slot) {
      slot.cancelled = true;
      this.pendingEmitters.get(anchor)!.delete(emitterId >>> 0);
    }
    const byId = this.emittersById.get(anchor);
    const system = byId?.get(emitterId >>> 0);
    if (!byId || !system) return;
    byId.delete(emitterId >>> 0);
    this.objectSystems.get(anchor)?.delete(system);
    this.deps.spellEffects.removeParticleSystem(system);
  }

  /** Whether the object's emitter table holds a live emitter under `emitterId`. */
  private hasLiveEmitter(anchor: THREE.Object3D, emitterId: number): boolean {
    // One still waiting for its files is live: retail would have built it.
    if (this.pendingEmitters.get(anchor)?.has(emitterId >>> 0)) return true;
    const system = this.emittersById.get(anchor)?.get(emitterId >>> 0);
    // ParticleManager::UpdateParticles removes an emitter the tick its
    // UpdateParticles returns 0 — a done / disposed system is not in the table.
    return !!system && !system.isDone && !system.isDisposed;
  }

  /**
   * CPhysicsObj::create_particle_emitter → ParticleManager::
   * CreateParticleEmitter @ 0051b6c0: replace any emitter holding the
   * hook's id, build the emitter (SetInfo fails without a HW GfxObj —
   * ParticleEmitter::SetInfo @ 0051ce90), parent it to the object or its
   * part at the hook's offset (SetParenting @ 0051c190) and burst its
   * initial particles (InitEnd @ 0051d400).
   */
  private createParticleEmitter(data: CreateParticleHookData, anchor: THREE.Object3D, worldPos: THREE.Vector3, arrived = false): void {
    const emitterId = (data.emitterId ?? 0) >>> 0;
    if (emitterId !== 0) this.destroyEmitter(anchor, emitterId);
    // Retail's DBObj::Get blocks until the file is local; a streamed emitter
    // waits for its files and is created ~1 RTT late (once: a failed fetch
    // falls through to the normal path below).
    const pending = arrived ? null : this.deps.emitterPending?.(data.emitterInfoId >>> 0);
    if (pending) {
      const slot = { stopped: false, cancelled: false };
      if (emitterId !== 0) {
        const slots = this.pendingEmitters.get(anchor) ?? new Map<number, { stopped: boolean; cancelled: boolean }>();
        this.pendingEmitters.set(anchor, slots);
        slots.set(emitterId, slot);
      }
      const settle = (): THREE.Object3D => {
        // FX.pending-emitter-orphaned-by-rebuild — the object may have been
        // rebuilt meanwhile (transferAnchor): the emitter goes on its mesh now.
        const cur = this.currentAnchor(anchor);
        const slots = this.pendingEmitters.get(cur);
        if (slots?.get(emitterId) === slot) {
          slots.delete(emitterId);
          if (slots.size === 0) this.pendingEmitters.delete(cur);
        }
        return cur;
      };
      pending.then(() => {
        const cur = settle();
        if (slot.cancelled || !cur.parent) return;
        this.createParticleEmitter(data, cur, cur.getWorldPosition(new THREE.Vector3()), true);
        // A StopParticle that came first: created, then stopped, as retail ran them.
        if (slot.stopped && emitterId !== 0) this.emittersById.get(cur)?.get(emitterId)?.stop();
      }, () => { settle(); /* fetch failed: the effect is skipped */ });
      return;
    }
    const info = this.deps.loadEmitterInfo(data.emitterInfoId);
    if (!info) return;
    // Retail builds every particle from the hardware GfxObj; an emitter
    // without one is never created.
    if (!info.hwGfxObjId) return;
    const rawOff = data.offset?.origin ?? { x: 0, y: 0, z: 0 };
    // Retail renders each particle as the emitter's own GfxObj quad —
    // without the resolved sprite (texture + additive + quad extent)
    // particles draw as untextured white squares.
    const sprite = this.deps.resolveEmitterSprite?.(info) ?? undefined;
    // Every emitter is removed only when it reports itself done
    // (ParticleManager::UpdateParticles @ 0051b800) or its object goes —
    // an endless one (no time or count bound, e.g. the portal vortex
    // 0x320009D9/DA) lives as long as the object.
    // CORE.9.b / VISUAL.night-sky-vs-retail.a — anchors tagged skyTracked
    // (SETUP sky objects) are retail sky physics objects (GameSky::MakeObject
    // → AddObjectToSingleCell(before/after_sky_cell)): their emitters ride
    // the sky object's frame in the viewer's landblock, stamp each particle
    // with the landblock it was born in, and draw in GameSky::Draw's pass.
    const skyTracked = anchor.userData.skyTracked === true;
    let system: ParticleSystem | undefined;
    if (skyTracked) {
      // An anchor SkyboxRenderer never framed sits at the world origin.
      const frame = (anchor.userData.skyFrame as SkyObjectFrame | undefined)
        ?? { local: new THREE.Vector3(), cell: new THREE.Vector3() };
      const skyPass = anchor.userData.skyPass as ParticleSkyPass | undefined;
      const frameSource = makeSkyEmitterFrameSource(anchor, frame, rawOff);
      system = this.deps.spellEffects.spawnParticleEffect(
        info, { x: 0, y: 0, z: 0 }, undefined, sprite, undefined, { frameSource },
      );
      if (system && skyPass) system.setSkyPass?.(skyPass);
      // GameSky::Draw @ 00506ff0 draws the sky cell with D3D fog set to
      // LScape::m_override_enabled — off unless an Environs fog is up.
      if (system) {
        system.setFogEnabled?.(this.skyFogOverride);
        this.pruneSkySystems();
        this.skySystems.add(system);
      }
    } else {
      // Every other emitter follows its parent frame — the object or the
      // named part (a casting hand) — at the hook offset, rotated with it.
      const node = emitterParentNode(anchor, data.partIndex);
      const frameSource = makeEmitterFrameSource(node, rawOff, data.partIndex);
      const v = new THREE.Vector3(rawOff.x, rawOff.z, rawOff.y).applyQuaternion(node.getWorldQuaternion(new THREE.Quaternion()));
      const start = node === anchor ? worldPos : node.getWorldPosition(new THREE.Vector3());
      system = this.deps.spellEffects.spawnParticleEffect(
        info, { x: start.x + v.x, y: start.y + v.y, z: start.z + v.z }, undefined, sprite, undefined,
        { frameSource, partIndex: data.partIndex },
      );
    }
    if (!system) return;
    // VISUAL.dat-static-default-scripts — an emitter born while its
    // static is not drawn stays hidden until it is.
    if (this.hiddenAnchors.has(anchor) || this.suspendedAnchors.has(anchor)) system.object3D.visible = false;
    let systems = this.objectSystems.get(anchor);
    if (!systems) {
      systems = new Set();
      this.objectSystems.set(anchor, systems);
    }
    for (const s of systems) if (s.isDone || s.isDisposed) systems.delete(s);
    systems.add(system);
    if (emitterId !== 0) {
      const byId = this.emittersById.get(anchor) ?? new Map<number, ParticleSystem>();
      this.emittersById.set(anchor, byId);
      byId.set(emitterId, system);
    }
  }

  /**
   * CPhysicsObj::play_default_script @ 005132b0 (DefaultScriptHook) on
   * `target` — nothing while it is out of the world.
   */
  private playDefaultScript(target: THREE.Object3D): void {
    if (this.suspendedAnchors.has(target)) return;
    const script = this.deps.resolveDefaultScript?.(target);
    if (script) this.play(script, target);
  }

  /** CAnimHook::Execute for one hook on `anchor`. */
  private dispatchHook(hook: AnimationHook | null, anchor: THREE.Object3D): void {
    if (!hook) return;
    const worldPos = anchor.getWorldPosition(new THREE.Vector3());
    switch (hook.hookType) {
      case AnimationHookType.Sound: {
        const data = hook as SoundHookData;
        // SoundHook::Execute → SoundManager::PlaySoundA(gid, obj) @ 00550730:
        // a direct wave (0x0Axxxxxx) at the object's position, played AT
        // effect_sound_volume — GetAttenuation applies the preference again
        // (SWEEP1006 hook volume).
        const listener = this.deps.getListenerPos();
        this.deps.soundPlayer.playPositionalSound(
          data.soundId, { x: worldPos.x, y: worldPos.y, z: worldPos.z }, listener,
          'effects', this.deps.soundPlayer.effectsVolume ?? 1,
        ).catch(() => { /* ignore decode failures */ });
        break;
      }
      case AnimationHookType.SoundTweaked: {
        // SoundTweaked is a probability-gated Sound at its own volume (idle
        // creature emissions, rain loops, every portal's hum). The fields
        // are retail's order (SoundTweakedHook::UnPack @ 00527780: gid,
        // prob, prio, vol — ACE swaps prob/prio; see AnimationHook.ts).
        const data = hook as SoundTweakedHookData;
        // SoundManager::PlaySoundA(gid, obj, prio, prob, vol) @ 005507a0 —
        // PlayProbability @ 005500e0 plays when rand/RAND_MAX < prob.
        if (!(Math.random() < data.probability)) break;
        const listener2 = this.deps.getListenerPos();
        // CORE.9.a — honor the hook's stored volume (the Rainy day groups'
        // ambient rain loops play the same wave at 0.35 vs 0.10).
        this.deps.soundPlayer.playPositionalSound(
          data.soundId, { x: worldPos.x, y: worldPos.y, z: worldPos.z }, listener2,
          undefined, data.volume,
        ).catch(() => { /* ignore decode failures */ });
        break;
      }
      case AnimationHookType.CreateParticle: {
        this.createParticleEmitter(hook as CreateParticleHookData, anchor, worldPos);
        break;
      }
      case AnimationHookType.CreateBlockingParticle: {
        // DECOMP.blocking-emitter-restarts — ParticleManager::
        // CreateBlockingParticleEmitter @ 0051b8a0: a live emitter already
        // holding the id blocks it (returns 0); otherwise it is an ordinary
        // CreateParticleEmitter.
        const data = hook as CreateParticleHookData;
        const emitterId = (data.emitterId ?? 0) >>> 0;
        if (emitterId !== 0 && this.hasLiveEmitter(anchor, emitterId)) break;
        this.createParticleEmitter(data, anchor, worldPos);
        break;
      }
      case AnimationHookType.SoundTable: {
        // SoundTableHook::Execute — the object's own SoundTable entry.
        const data = hook as SoundTableHookData;
        this.deps.playSoundTableSound?.(anchor, data.soundType, { x: worldPos.x, y: worldPos.y, z: worldPos.z });
        break;
      }
      case AnimationHookType.NoDraw: {
        const data = hook as NoDrawHookData;
        // BUG.nodraw-hook-overwritten — a server object's NoDraw lives in its
        // PhysicsState (set_nodraw sets bit 0x20), which its per-frame
        // visibility reads; writing only mesh.visible was undone next frame.
        if (this.deps.setNoDraw?.(anchor, !!data.noDraw)) break;
        anchor.visible = !data.noDraw;
        // set_nodraw keeps the object's lights (BUG.hidden-object-lights-leave-pool).
        setObjectNoDraw(anchor, !!data.noDraw);
        break;
      }
      case AnimationHookType.SetLight: {
        // BUG.setlight-hook-emissive-only — SetLightHook::Execute @ 00526fd0
        // is `CPhysicsObj::set_lights(obj, lights_on, 0)` @ 0050fcf0: the
        // LightingOn state bit plus CPartArray::InitLights / DestroyLights —
        // the object's Setup LIGHTS, nothing about its materials (the old
        // emissive toggle was invented). The one EoL script with the hook is
        // 0x33000109 (NoDraw + lights off), the ProjectileCollision (0x5A)
        // entry of 42 spell-projectile tables (Flame Bolt's 0x34000005): a
        // bolt vanishes and its light goes out on impact.
        const data = hook as SetLightHookData;
        const lit = data.lightsOn !== 0;
        anchor.userData.lit = lit;
        this.deps.setLights?.(anchor, lit);
        break;
      }
      case AnimationHookType.Scale: {
        // ScaleHook::Execute @ 00526e40 → CPhysicsObj::SetScale @ 005136a0:
        // from the current scale to `end` over `time`.
        const data = hook as ScaleHookData;
        this.addRamp(anchor, 'scale', anchor.scale.x, data.end, data.time);
        break;
      }
      case AnimationHookType.Luminous: {
        // LuminousHook::Execute @ 00526d60 → CPhysicsObj::SetLuminosity.
        const data = hook as LuminousHookData;
        this.addRamp(anchor, 'luminosity', data.start, data.end, data.time);
        break;
      }
      case AnimationHookType.Diffuse: {
        // DiffuseHook::Execute @ 00526e00 → CPhysicsObj::SetDiffusion.
        const data = hook as DiffuseHookData;
        this.addRamp(anchor, 'diffusion', data.start, data.end, data.time);
        break;
      }
      case AnimationHookType.Transparent: {
        // BUG.transparent-hook-inverted — the value is TRANSLUCENCY
        // (TransparentHook::Execute @ 00526c30 → CPhysicsObj::SetTranslucency2
        // @ 0050fb50): 1 = invisible, 0 = solid; the Create script
        // (0x33000232: 1 → 0 over 1 s) fades a spawn IN. Each step is
        // SetTranslucencyInternal (clamped to the server's translucency).
        const data = hook as TransparentHookData;
        this.addRamp(anchor, 'translucency', data.start, data.end, data.time);
        break;
      }
      case AnimationHookType.TransparentPart: {
        // TransparentPartHook::Execute @ 00526cc0 → SetPartTranslucency @ 00511730.
        const data = hook as TransparentPartHookData;
        this.addRamp(anchor, 'partTranslucency', data.start, data.end, data.time, data.part);
        break;
      }
      case AnimationHookType.LuminousPart: {
        const data = hook as LuminousPartHookData;
        this.addRamp(anchor, 'partLuminosity', data.start, data.end, data.time, data.part);
        break;
      }
      case AnimationHookType.DiffusePart: {
        const data = hook as DiffusePartHookData;
        this.addRamp(anchor, 'partDiffusion', data.start, data.end, data.time, data.part);
        break;
      }
      case AnimationHookType.Ethereal: {
        // EtherealHook::Execute @ 00526bc0 → CPhysicsObj::set_ethereal: the
        // flag rides on userData for collision queries against this anchor.
        const data = hook as EtherealHookData;
        anchor.userData.ethereal = data.ethereal !== 0;
        break;
      }
      case AnimationHookType.ReplaceObject: {
        // ReplaceObject swaps a SetupModel part to a different GfxObj at
        // partIndex: tag the object's own part with the new ID.
        const data = hook as ReplaceObjectHookData;
        const part = objectPart(anchor, data.partIndex);
        if (part) part.userData.replacePartId = data.partId;
        break;
      }
      case AnimationHookType.DefaultScript: {
        // DefaultScriptHook::Execute @ 00526c10 → play_default_script @ 005132b0.
        this.playDefaultScript(anchor);
        break;
      }
      case AnimationHookType.DefaultScriptPart: {
        // DefaultScriptPartHook::Execute @ 00526c00 → play_default_script(part)
        // @ 00513300: the default script of the CHILD object held on that
        // part (the CHILDLIST entry whose part number matches — a wielded
        // item), played on the child.
        const data = hook as DefaultScriptPartHookData;
        const part = objectPart(anchor, data.partIndex);
        const child = part?.children.find(c => c.userData.wieldedGuid !== undefined);
        if (child) this.playDefaultScript(child);
        break;
      }
      case AnimationHookType.CallPES: {
        // CallPESHook::Execute @ 00526e20 → CPhysicsObj::CallPES @ 00511af0:
        // the nested script plays after RollDice(0, pause) on the object's
        // clock (a CALL_PES FPHook); a pause under F_EPSILON plays it now.
        const data = hook as CallPESHookData;
        if (!this.deps.loadScript) break;
        const nested = this.deps.loadScript(data.pes);
        if (!nested) break;
        if (data.pause >= F_EPSILON) {
          const wait = this.deps.rollDice ? this.deps.rollDice(0, data.pause) : Math.random() * data.pause;
          const st = this.stateFor(anchor);
          st.hooks.unshift({ kind: 'callPES', created: st.clock, duration: wait, from: 0, to: 1, part: 0, script: nested });
        } else if (!this.suspendedAnchors.has(anchor)) {
          this.play(nested, anchor);
        }
        break;
      }
      case AnimationHookType.SetOmega: {
        // SetOmegaHook::Execute @ 00526f30 → set_omega: the object's spin
        // (axis × radians/s), applied each update(); a zero axis stops it.
        const data = hook as SetOmegaHookData;
        anchor.userData.omega = data.axis;
        if (data.axis.x !== 0 || data.axis.y !== 0 || data.axis.z !== 0) {
          this.omegaAnchors.add(anchor);
        } else {
          this.omegaAnchors.delete(anchor);
        }
        break;
      }
      case AnimationHookType.DestroyParticle: {
        // DestroyParticleHook::Execute → ParticleManager::DestroyParticleEmitter
        // @ 0051b770: the emitter AND its live particles go immediately.
        const data = hook as DestroyParticleHookData;
        this.destroyEmitter(anchor, data.emitterId);
        break;
      }
      case AnimationHookType.StopParticle: {
        // StopParticleHook::Execute → ParticleManager::StopParticleEmitter
        // @ 0051b7b0: set the emitter's stopped flag — no new particles, the
        // live ones play out (the windup's hand glow when the hands lower).
        const data = hook as StopParticleHookData;
        this.emittersById.get(anchor)?.get(data.emitterId >>> 0)?.stop();
        const slot = this.pendingEmitters.get(anchor)?.get(data.emitterId >>> 0);
        if (slot) slot.stopped = true;
        break;
      }
      case AnimationHookType.TextureVelocity: {
        // TextureVelocityHook::Execute @ 00526fb0 → SetTextureVelocity →
        // CPartArray::SetTextureVelocityInternal @ 00518cb0: every part's
        // GfxObj (AddGfxVelocity).
        const data = hook as TextureVelocityHookData;
        for (const part of objectParts(anchor)) this.addGfxVelocity(part, data.uSpeed, data.vSpeed);
        break;
      }
      case AnimationHookType.TextureVelocityPart: {
        // TextureVelocityPartHook::Execute @ 00526f50 → SetPartTextureVelocity.
        const data = hook as TextureVelocityPartHookData;
        const part = objectPart(anchor, data.partIndex);
        if (part) this.addGfxVelocity(part, data.uSpeed, data.vSpeed);
        break;
      }
      // AttackHook::Execute @ 00526b70 (CPhysicsObj::attack — the attack
      // cone reported for the server's hit volume) and AnimDoneHook::Execute
      // @ 00526c20 (CPartArray::AnimationDone — the motion system's own
      // completion) draw and play nothing here; NoOp is a no-op.
      default:
        break;
    }
  }
}

function isUnder(node: THREE.Object3D, root: THREE.Object3D): boolean {
  for (let n: THREE.Object3D | null = node; n; n = n.parent) if (n === root) return true;
  return false;
}
