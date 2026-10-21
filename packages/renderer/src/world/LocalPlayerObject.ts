/**
 * BUG.self-heritage-effects — our own character is a CPhysicsObj like every
 * other: the defaults its Setup and PhysicsDesc give an object when it is
 * made apply to it too.
 *
 * Our client builds the local player's model apart from ServerObjectManager
 * (its own CreateObject returns early there), so everything
 * `onObjectCreated` / `buildObjectMesh` did for other objects was missed
 * for ours. The visible case (Levistras, 2026-10-21): Undead, Umbraen,
 * Penumbraen and Empyrean characters' Setups carry a DefaultScript whose
 * CreateParticle hooks draw the flaming skull, the smoke body and crown, the
 * wing glow (e.g. Undead male 0x02001A0E → 0x33001280, five emitters on part
 * 16; Umbraen male 0x0200196F → 0x33001256). Other players showed them; our
 * own never did.
 *
 * Retail: CPartArray::SetSetupID → CPhysicsObj::InitDefaults @ 005139d0
 * (`if (setup->default_script_id) play_script_internal(...)`) for every
 * object, the player included; CPhysicsObj::set_description @ 00514f40
 * copies ObjScale and the sound table for every object.
 */
import type * as THREE from 'three';
import type { PhysicsScript } from '@ac/dat-parser';
import { playCreationDefaultScript } from '../effects/PlayScriptResolve.js';
import { SOUND_TABLE_KEY } from '../audio/RetailSound.js';
import { DegradeLod } from '../models/DegradeLod.js';

export interface SetupDefaultsDeps {
  /** The Setup's DefaultScript DID (0 / undefined = none). */
  setupDefaultScript(setupId: number): number | undefined;
  loadScript(scriptId: number): PhysicsScript | null;
  play(script: PhysicsScript, anchor: THREE.Object3D): void;
}

/**
 * CPhysicsObj::InitDefaults @ 005139d0 on `anchor`: tag it with its Setup
 * (DefaultScript[Part] hooks and the sound-table fallback resolve through
 * `userData.setupId`) and play the Setup's DefaultScript. The one path every
 * object takes — server objects, held copies and our own character.
 * Returns the script DID it started, or undefined.
 */
export function initSetupDefaults(anchor: THREE.Object3D, setupId: number, deps: SetupDefaultsDeps): number | undefined {
  anchor.userData.setupId = setupId;
  return playCreationDefaultScript(anchor, deps.setupDefaultScript(setupId), deps.loadScript, deps.play);
}

/** What our own CreateObject says about the object (CreateObjectData's fields). */
export interface LocalPlayerCreate {
  name: string;
  setupId: number;
  soundTableId?: number;
  objScale?: number;
}

/**
 * The local player's freshly built model, made into its CPhysicsObj the way
 * ServerObjectManager.buildObjectMesh makes every other object: its name,
 * its own parts never degrade (CPhysicsPart::UpdateViewerDistance skips
 * physobj id == player_iid), the wire sound table (set_description @
 * 00514f40), ObjScale from the PhysicsDesc, and its Setup tag.
 */
export function initLocalPlayerObject(model: THREE.Object3D, create: LocalPlayerCreate): void {
  model.name = `player_${create.name}`;
  model.userData[DegradeLod.NO_DEGRADE_KEY] = true;
  model.userData[SOUND_TABLE_KEY] = create.soundTableId || 0;
  if (create.objScale && create.objScale !== 1) model.scale.setScalar(create.objScale);
  model.userData.setupId = create.setupId;
}

/**
 * InitDefaults for our own model, once it stands where it is. Other objects
 * play their Setup DefaultScript in onObjectCreated, after buildObjectMesh
 * has placed them; our model is placed by the frame loop (its feet height is
 * known only there), and an emitter's initial burst (ParticleEmitter::
 * InitEnd) is born at its parent's frame of that moment. So `built` arms the
 * model and the frame loop's `placed`, right after it positions the model,
 * plays the script once per built model.
 */
export class LocalPlayerDefaults {
  private pending: { model: THREE.Object3D; setupId: number } | null = null;

  constructor(private readonly deps: () => SetupDefaultsDeps) {}

  /** A new own model was built (login, or a re-sent own CreateObject). */
  built(model: THREE.Object3D, create: LocalPlayerCreate): void {
    initLocalPlayerObject(model, create);
    this.pending = { model, setupId: create.setupId };
  }

  /** The frame loop placed `model`: its Setup DefaultScript starts now (once). Returns the DID started. */
  placed(model: THREE.Object3D | null): number | undefined {
    const p = this.pending;
    if (!p || !model || p.model !== model) return undefined;
    this.pending = null;
    return initSetupDefaults(model, p.setupId, this.deps());
  }

  /** The session ended before the model was placed. */
  reset(): void { this.pending = null; }
}
