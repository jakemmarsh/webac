/**
 * ServerObjectManager — tracks all objects created by the ACE server.
 *
 * Manages the lifecycle: create, update position, update appearance, delete.
 * Each server object has a 3D representation in the scene.
 */

import { addCreatureObstacles, creatureBlockRadius, blocksLocalPlayer, partArrayCylinder, type CreatureBlocker } from './CreatureCollision.js';
import type { ObjectPhysicsModel } from './ObjectCollision.js';
import { DungeonCollision } from './DungeonCollision.js';
import { MoveToManager, performServerMovement, type MoveToHost } from '../controllers/MoveToManager.js';
import { RemotePhysicsObject, type RemotePhysicsEnv, type SequenceStepInfo } from './RemotePhysics.js';
import {
  readyMotion, adjustMotion, applyInterpretedMotion, removeInterpretedMotion, resolveMotion,
  sequencePhysicsFor, adjustedMaxSpeed, maxSpeed, HoldKey, type InterpretedMotion,
  appliedMotion, contactAllowsMove, leaveGroundVelocity,
} from './RemoteMotion.js';
import { identityFrame, type SeqV3 } from '../animation/SequenceFrame.js';
import { DegradeLod } from '../models/DegradeLod.js';
import { subPaletteScale } from '../models/AppearanceOverrides.js';
import { heldCopiesUnder, heldCopyGuidAt, rescaleHeldCopiesForHolder } from '../models/WieldedItemVisual.js';
import {
  createMissileBody, advanceMissile, acQuatToThree, sweepCylinders, sweepSpheres, nearestContact,
  classifyMissileObstacle, applyObstacleKind,
  type MissileBody, type MissileSweep, type MissileContact, type MissileObstacleKind, type V3,
} from './MissilePhysics.js';
import * as THREE from 'three';
import type { CreateObjectData, ACPosition, ParsedMovementData, ParsedMoveTo, ParsedTurnTo } from '@ac/network';
import { parseMovementData, PhysicsTimestamp } from '@ac/network';
import type { DatDatabase } from '@ac/dat-parser/DatDatabase.js';
import type { SetupModelRenderer } from '../models/SetupModelRenderer.js';
import type { AppearanceManager } from '../models/AppearanceManager.js';
import type { SceneManager } from '../scene/SceneManager.js';
import type { UpdatePositionData, AutonomousPositionData, ObjDescEventData, MovementEventData } from '../network/ServerMessageHandler.js';
import { wavePrefetch } from '../audio/WavePrefetch.js';
import type { TerrainCollision } from '@ac/shared';
import { showableOnRadar } from '../ui/RadarBlips.js';
import { PhysicsState, ItemType, MovementType, ObjectDescriptionFlag, isInteriorCellIndex, landblockX, landblockY, PropertyInt, HUGE_QUANTUM, type PlayScript, missileArc, missileArcPoint, DEFAULT_PROJECTILE_RADIUS, boltLaunch } from '@ac/shared';
import { hiddenEdgeScript, PHYSICS_STATE_CTOR_DEFAULT } from '../effects/HiddenStateScripts.js';
import { setObjectLighting, restoreObjectLighting, type LightingCopies, type LightingLevels } from './SelectionLighting.js';
import { setCellLighting } from '../models/RetailLighting.js';
import { syncObjectLights, releaseObjectLightsIn, setObjectNoDraw } from '../effects/ObjectLights.js';
import { SOUND_TABLE_KEY } from '../audio/RetailSound.js';
import { disposeObjectTree } from '../models/MaterialOwnership.js';
import { PLACEMENT_RESTING } from '../models/SetupModelGroup.js';
import { setServerTranslucency, setObjectTranslucency, TRANSLUCENCY_KEY, TRANSLUCENCY_ORIGINAL_KEY, PHYSICS_STATE_KEY } from '../models/ObjectTranslucency.js';
import { RateLimitedWarn } from '../utils/RateLimitedWarn.js';
import { NONVISIBLE_OBJECT_DESTRUCTION_TIME } from './ObjectMaint.js';
import { AnimatedEntity, collectPartObjects, applyPartTransforms } from '../animation/AnimatedEntity.js';
import { AnimationPlayer } from '../animation/AnimationPlayer.js';
import { Animation } from '@ac/dat-parser/file-types/Animation.js';
import { DatReader } from '@ac/dat-parser/DatReader.js';
import { readDidMapper } from '@ac/dat-parser/file-types/DidMapper.js';
import { AnimationHookType, type AnimationHook, type EtherealHookData } from '@ac/dat-parser/file-types/AnimationHook.js';
import { MotionManager } from '../animation/MotionManager.js';
import { MotionCommand, MotionStance, motionCommandFromWireIndex, isSubstateCommand, isActionCommand } from '../animation/MotionCommands.js';

/**
 * Wire index for MotionCommand.Dead. ACE sends and the client receives the
 * low 16 bits of the full motion-command ID; the high bits are the command
 * mask (which the wire format strips). 0x40000011 & 0xFFFF = 0x0011.
 */
const MOTION_DEAD_WIRE_INDEX = MotionCommand.Dead & 0xFFFF;

/**
 * Wire index for MotionCommand.Ready. ACE's InterpretedMotionState keeps
 * ForwardCommand at Ready (not absent) while a creature is only
 * side-stepping or turning in place — see BUG.sidestep-turn-in-place-never-animates.
 */
const MOTION_READY_WIRE_INDEX = MotionCommand.Ready & 0xFFFF;
/**
 * Forward commands the local CharacterAnimController drives itself from
 * input (and the server merely echoes): Ready, the walk/run/turn/sidestep
 * cycles, falling, and the held poses. Every other non-autonomous forward
 * command the server sends for the player is a one-shot it performed.
 */
const LOCAL_CONTROLLER_OWNED_WIRE_INDICES: ReadonlySet<number> = new Set([
  MotionCommand.Ready, MotionCommand.WalkForward, MotionCommand.WalkBackwards, MotionCommand.RunForward,
  MotionCommand.TurnRight, MotionCommand.TurnLeft, MotionCommand.SideStepRight, MotionCommand.SideStepLeft,
  MotionCommand.Falling, MotionCommand.Crouch, MotionCommand.Sitting, MotionCommand.Sleeping, MotionCommand.Dead,
].map((m) => m & 0xFFFF));

/**
 * Reconstruct a full MotionStance ID from its wire-encoded low-16-bit
 * index. The wire format strips the 0x80000000 stance bit; this helper
 * restores it. E.g. `motionStanceFromIndex(0x3d)` → `0x8000003d` (NonCombat).
 *
 * This mirrors the ACE comment on the MovementEvent wire format:
 *   "Stances reconstruct as 0x80000000 | index."
 */
function motionStanceFromIndex(wireIndex: number): number {
  return (0x80000000 | wireIndex) >>> 0;
}

/**
 * A non-autonomous server forward command for OUR character (the local
 * branch of applyParsedMotion; also replayed by the movement golden tests):
 * a SUBSTATE-class command (a cast gesture, Eat / Drink, Aim / Reload) is
 * held through the player's motion-table state; any other one-shot plays as
 * an action; the server's Ready ends a server substate. Commands the
 * CharacterAnimController owns (Ready / walk / run / turn / sidestep / falling
 * / postures) stay its own.
 */
export function applyServerForwardToLocalPlayer(mm: MotionManager, forwardCmd: number, forwardSpeed: number, fullStanceId: number, sidestepCmd = 0, turnCmd = 0): void {
  // CMotionInterp::move_to_interpreted_state @ 005289c0 applies the server's
  // whole interpreted state before its actions: a sidestep or turn the player
  // was doing and the server's state lacks stops first, so the server's swing
  // plays from Ready. With the strafe still the substate there is no link to
  // the action and it was dropped (MOVE.combination-sweep sweep-melee-charge-C:
  // C held through the attack, the swing never played and UseTime took
  // control back at once).
  const ts = mm.motionTableState;
  if (ts) {
    if (!sidestepCmd) ts.stopMotion(MotionCommand.SideStepRight);
    if (!turnCmd) ts.stopMotion(MotionCommand.TurnRight);
  }
  if (forwardCmd > 0 && !LOCAL_CONTROLLER_OWNED_WIRE_INDICES.has(forwardCmd)) {
    const full = motionCommandFromWireIndex(forwardCmd);
    const key = MotionManager.compositeKey(fullStanceId, forwardCmd);
    if (full !== undefined && isSubstateCommand(full)) {
      // Through the player's motion-table state when it has one, so the
      // substate it records (and its sequence velocity) is the server's.
      if (mm.motionTableState) mm.motionTableState.doMotion(full >>> 0, forwardSpeed);
      else mm.setForwardMotion(key, forwardSpeed);
    } else {
      const alreadyPlaying = mm.isPlayingAction && (mm.motion & 0xFFFF) === forwardCmd;
      if (!alreadyPlaying) mm.queueAction(key, forwardSpeed);
    }
  }
  // The server's Ready that ends such a substate (FinishCast's return to
  // the magic Ready stance, a use motion's Ready) plays its return link.
  // A Ready while the character is in the controller's own substates
  // (Ready / walk / run / turn …) stays the controller's. An absent forward
  // command is Ready (InterpretedMotionState::UnPack @ 0051f400): ACE writes
  // Ready out, but the AC1999 and GDL servers pack it only when it is not
  // Ready, so their reload's Ready left a 1999 bow stuck in Reload.
  if (forwardCmd === MOTION_READY_WIRE_INDEX || forwardCmd === 0) {
    const target = typeof mm.targetSubstate === 'number' ? mm.targetSubstate & 0xFFFF : MOTION_READY_WIRE_INDEX;
    if (!LOCAL_CONTROLLER_OWNED_WIRE_INDICES.has(target)) {
      if (mm.motionTableState) mm.motionTableState.doMotion(MotionCommand.Ready, forwardSpeed, true);
      else mm.setForwardMotion(MotionManager.compositeKey(fullStanceId, forwardCmd), forwardSpeed);
    }
  }
}

export interface ServerObject {
  guid: number;
  name: string;
  /** CORE.10.e — WeenieHeaderFlag.PluralName from the wire (''/undefined =
   *  not sent). Stack labels (toolbar strip, tooltips) of >=2 use this per
   *  retail GetObjectName(NAME_APPROPRIATE) @ 0058e6e0. */
  pluralName?: string;
  weenieClassId: number;
  setupId: number;
  /** PhysicsScriptTable DID from the wire (GAP.13) — PScript resolution root. */
  peTableId?: number;
  iconId: number;
  itemType: number;
  physicsState: number;
  position: ACPosition | null;
  worldX: number;
  worldY: number;
  worldZ: number;
  radarColor: number;
  radarBehavior: number;
  usable: number;        // ItemUseable bits (ACE Usable.cs) — kept for ObjDesc re-dress rebuilds
  /** PublicWeenieDesc._combatUse (WeenieHeaderFlag.CombatUse sbyte; 0 = COMBAT_USE_NONE / not sent).
   *  gmToolbarUI::HandleSelectionChanged @ 004bf380 reads it for the Use button state. */
  combatUse?: number;
  /**
   * BUG.weenie-targettype-discarded — WeenieHeaderFlag.TargetType uint
   * (ACE PropertyInt.TargetType = 94): ItemType bitmask of legal use-with
   * targets when THIS object is the source of a targeted use. Mirrored so
   * ground items (a dropped healing kit examined pre-pickup) keep the gate
   * input across re-dress rebuilds. 0 = no restriction.
   */
  targetType: number;
  /**
   * BUG.distant-use-silent-noop — use-range gate radius from the wire
   * (WeenieHeaderFlag.UseRadius), 0.6 when absent per ACE's universal
   * `UseRadius ?? 0.6f` fallback (Player_Move.cs:59). The approach-then-use
   * walk stops once the player's cylinder distance is inside this.
   */
  useRadius: number;
  /**
   * CORE.10.a — WeenieHeaderFlag.StackSize from the wire (0 = not sent /
   * not a stack). Selecting a world stack of >=2 drives the toolbar's
   * stack-split UI, so the count must survive on the persisted object and
   * track SetStackSize updates.
   */
  stackSize: number;
  /** GAP.world-drag-drop — PublicWeenieDesc._maxStackSize (IsMergeAttemptLegal on a 3D drop). */
  maxStackSize?: number;
  mesh: THREE.Group | null;
  // Appearance data for rebuilding models
  basePalette: number;
  subPalettes: CreateObjectData['subPalettes'];
  textureChanges: CreateObjectData['textureChanges'];
  animPartChanges: CreateObjectData['animPartChanges'];
  // Motion table for animation
  motionTableId: number;
  // Sound table for object-specific sounds (0x20xxxxxx)
  soundTableId: number;
  // ObjectDescriptionFlag bits — per ACE ObjectDescriptionFlag.cs. Carries
  // server-authoritative category bits (Vendor/Door/Corpse/Healer/Portal/
  // LifeStone/Attackable/Openable/Book/Lockpick/...). Preferred over
  // radarColor/name heuristics for context-menu and cursor dispatch.
  objectDescFlags: number;
  /** RECON.object-is-attackable-port — PublicWeenieDesc._pet_owner (0 = no owner). */
  petOwner?: number;
  /**
   * CORE.17.o.b — PublicWeenieDesc._itemsCapacity from the CreateObject
   * wire (WeenieHeaderFlag.ItemsCapacity, a SIGNED byte; 0 when absent).
   * The external-container panel's list is sized from it through retail's
   * ItemList_UpdateContainerListSize rule (see OpenContainerTracker
   * itemListCapacity): >= 0 fixed cells, -1 visible-area padding.
   * Optional only so hand-built ServerObject fixtures stay valid; every
   * createObject() sets it.
   */
  itemsCapacity?: number;
  /**
   * CORE.18.c — PublicWeenieDesc._containersCapacity (WeenieHeaderFlag
   * 0x4, a SIGNED byte; 0 when absent): sizes the open-container strip's
   * nested-container list (m_containerList) by the same rule.
   */
  containersCapacity?: number;
  // Child-of-creature relationship — set when this object is wielded
  // by another creature (e.g. an NPC's sword). 0 = not a child.
  // ACE wire format: WeenieHeaderFlag.Wielder + currentWieldedLocation
  // bits in CreateObjectData. Used by the equipped-item visualization
  // path to attach the item's mesh to the wielder's holdingLocation.
  // wieldedLocation is the EquipMask (e.g. 0x1000000 = Held); the
  // ParentLocation enum mapping is done at attach time.
  wielderId: number;
  wieldedLocation: number;
  /**
   * BUG.clothingpriority-never-lands (supersedes the FAITHFUL.599 stamp) —
   * ClothingPriority from the per-object CreateObject wire field
   * (WeenieHeaderFlag.Priority, ACE WorldObject_Networking.cs:141-142).
   * Drives the retail paperdoll layer-blend order for overlapping equipped
   * surfaces (cloak under armor, etc.). The old FAITHFUL.599 login stamp
   * from PlayerDescription's equipped-item list never landed: equipped-item
   * CreateObjects arrive after PlayerDescription (UIQueue flushes before
   * SmartboxQueue), and the player's own equipment routes to
   * playerState.inventory, not here — so this field is populated by
   * createObject() from CreateObjectData (NPC-wielded items), and the
   * player's own copy lives on InventoryItem.clothingPriority.
   * ClothingRenderer/CharacterModelBuilder don't yet sort by it
   * (gap-audit equipment-paperdoll item). undefined = flag not sent.
   */
  clothingPriority?: number;
  /** WeenieHeaderFlag.AmmoType (the appraisal's ammunition line). */
  ammoType?: number;
  /**
   * STREAM.rebuild-resets-placement — the PhysicsDesc AnimationFrame
   * Placement (CPartArray::SetPlacementFrame; ACE gives a motion-table-less
   * object Resting 101). The parts keep it across an ObjDesc / streamed
   * rebuild; undefined = not sent (Default).
   */
  placement?: number;
  /**
   * STREAM.meshless-translucency-lost — the server's Translucency
   * (CPhysicsObj::translucencyOriginal: the CreateObject PhysicsDesc value,
   * then PublicUpdatePropertyFloat Translucency). Kept on the record so parts
   * built later (a streamed Setup that was not resident) take the current
   * value; the live fade on top of it is the mesh's (TRANSLUCENCY_KEY).
   */
  translucency?: number;
  /**
   * FAITHFUL.574 — server-authoritative visual attachment point from
   * `PhysicsDescriptionFlag.Parent` block (see CreateObjectData docs).
   * 0 = none / not present in the CreateObject payload. Stored here
   * so the case-(b) "creature arrives after its wielded item" path
   * in main.ts onObjectCreate can prefer the wire-supplied value
   * over the EquipMask-derived fallback.
   */
  parentLocation: number;
  /**
   * DECOMP.position-interpolation / DECOMP.remote-motion-no-displacement —
   * the object's CPhysicsObj (world/RemotePhysics.ts): where it is (AC
   * axes), its velocity / omega, interpolation and sticky managers, and the
   * update timestamps received positions are gated on. worldX/Y/Z and the
   * mesh follow it every frame. Undefined for an object never placed in the
   * world (a carried / contained / wielded item) and for missiles
   * (MissilePhysics flies those).
   */
  physics?: RemotePhysicsObject;
  /** The motion interpreter's interpreted state (world/RemoteMotion.ts) — full MotionCommand ids. */
  motionState?: InterpretedMotion;
  /** `CMotionInterp::my_run_rate` — set by a MoveTo's RunRate. */
  myRunRate?: number;
  /** The object's MoveToManager (controllers/MoveToManager.ts), made on its first MoveTo / TurnTo. */
  moveTo?: MoveToManager;
  collisionRadius: number; // from SetupModel.radius (0 = no collision)
  /** The radius the object BLOCKS our character with — its Setup cylspheres/spheres × scale (world/CreatureCollision.ts); 0 = walk-through. */
  blockRadius: number;
  /**
   * BUG.melee-cylinder-distance-ignores-height — from SetupModel.height (0 =
   * unresolved, matching ACE PhysicsObj.GetHeight()'s own 0.0f default when
   * PartArray/Setup hasn't loaded). Feeds the height-aware diffZ term of
   * Physics/Common/Position.cs CylinderDistance via main.ts's
   * getMeleeCylinderDistance call sites.
   */
  collisionHeight: number;
  /**
   * CORE.17.k.b.b.a.g.b — the part materials `CPhysicsPart::CopyMaterial`
   * replaced while a selection-lighting override is on (see
   * SelectionLighting.ts); undefined = the object draws its own materials.
   */
  lightingCopies?: LightingCopies;
  /**
   * Cell ID in the low 16 bits of position.landblock. Values 0x0100..0xFFFE
   * are interior EnvCells; 0xFFFF is the outdoor landblock. Tracked so we can
   * cull indoor objects from the outdoor view (fixes NPC-through-walls).
   */
  cellId: number;
  /**
   * BUG.teleport-leaves-stale-objects — the full cell id (0xXXYYcccc) of
   * the object's last server position; 0 / absent = not placed in the world
   * (a carried, contained or wielded item).
   */
  objCellId?: number;
  /**
   * BUG.teleport-leaves-stale-objects — the object's cell is not loaded
   * (CPhysicsObj::leave_visibility): not drawn, no lights, frozen, queued
   * for destruction (see world/ObjectMaint.ts).
   */
  lostCell?: boolean;
  /**
   * AGENT — where the server last placed the object: its cell and global
   * metres in render axes (worldX/Y/Z's frame), set by every position the
   * object accepted (CreateObject, UpdatePosition, AutonomousPosition,
   * PublicUpdatePosition). The agent's observations read it when the physics
   * body is not being stepped (agent/livePlace.ts).
   */
  serverPlace?: { cell: number; worldX: number; worldY: number; worldZ: number };
  /** AGENT — performance.now() ms when the server last set serverPlace (the agent's "still being placed" test). */
  serverPlaceAt?: number;
  /**
   * The CreateObject this record was made from, and the last position the
   * server sent for it (wire frame + stamps): what {@link ServerObjectManager.takeReleasedRecord}
   * re-makes an object from when the server speaks of it again after
   * ObjectMaint let it go.
   */
  createData?: CreateObjectData;
  lastServerPosition?: { position: ACPosition; positionTs?: number; teleportTs?: number };
  /** AGENT — performance.now() ms when the physics body last moved worldX/Y/Z (syncBodyToMesh). */
  bodySyncedAt?: number;
  /**
   * DECOMP.pickup-event-ignored — the object left the world
   * (`CPhysicsObj::leave_world` @ 005155a0, run by `SmartBox::DoPickupEvent`
   * @ 00452240): it is in no cell, so it is not drawn and does not update.
   * The record stays; a position (CreateObject / UpdatePosition) puts it
   * back, a ParentEvent draws it on its new holder.
   */
  outOfWorld?: boolean;
  /**
   * DECOMP.recreate-teardown — `CPhysicsObj::update_times[INSTANCE_TS]`: the
   * ObjectInstance sequence of the CreateObject that built this object.
   * Undefined when the create carried no timestamps.
   */
  instanceSequence?: number;
  /** `update_times[POSITION_TS]` as DoPickupEvent / DoParentEvent gate it. */
  positionSequence?: number;
  /**
   * DECOMP.interior-objects-culled — the object stands in an env cell that
   * is not drawn this frame (set by updateInteriorVisibility). Retail draws
   * an env cell's objects with the cell (`PView::DrawCells` @ 005a4840 →
   * `DrawObjCell` @ 005a1a40), so an undrawn cell's objects are not drawn.
   */
  _culledByCell?: boolean;
  /**
   * FAITHFUL.581 — Public vital state from `GameMessagePublicUpdateVital`
   * (0x02E8). Tracks Health/Stamina/Mana current + max for any visible
   * object the server actively broadcasts to us (NPCs in combat range,
   * fellowship members, summoned pets). Pre-fix this state was only
   * available via PlayerDescription (self) or the bulk FellowshipFullUpdate
   * (allies, refreshed every few seconds). Now drives target-HP overlays
   * and live fellow vital bars between bulk refreshes.
   *
   * 0 = unknown / not yet broadcast. UI should fall back to the cached
   * percentage from the most recent broadcast in that case.
   */
  healthCurrent: number;
  healthMax: number;
  staminaCurrent: number;
  staminaMax: number;
  manaCurrent: number;
  manaMax: number;
  /** PropertyInt.PlayerKillerStatus mirror — ACE Player_Death.cs:966,971,1018
   *  emits PublicUpdatePropertyInt with this key on PK transitions. Stored
   *  here so observers see the radar/target-frame color flip live, instead
   *  of staying frozen at the value the object had at CreateObject time.
   *  FAITHFUL.344. */
  playerKillerStatus?: number;
  /** FAITHFUL.384 — server-broadcast level for nearby players/creatures.
   *  ACE broadcasts PropertyInt.Level (25) on every level-up, fellowship
   *  member join, and observer-visible recalc. Pre-fix the HUD target
   *  level stayed 0 (selectTarget defaults) for the whole session. */
  level?: number;
  /** FAITHFUL.376 / SWEEP.8 — wire-format DefaultScript override from
   *  PhysicsDesc (PhysicsDescFlag.DefaultScript). This is a PlayScript enum
   *  key (ACE PhysicsDesc.cs:31 `PlayScript DefaultScript`), NOT a raw
   *  PhysicsScript DID — it must be resolved through the object's
   *  PhysicsScriptTable (peTableId, falling back to the SetupModel's
   *  DefaultScriptTable) via selectPhysicsScriptByIntensity, same as ACE
   *  PhysicsObj.cs:3058's `PhysicsScriptTable.GetScript(DefaultScript,
   *  DefaultScriptIntensity)`. 0 = no override (use setup.defaultScript). */
  defaultScriptOverride?: number;
  /** FAITHFUL.376 / SWEEP.8 — intensity threshold used to pick a script
   *  variant out of defaultScriptOverride's PhysicsScriptTable entry list;
   *  see selectPhysicsScriptByIntensity. */
  defaultScriptIntensity?: number;
  /** PropertyInt.UiEffects mirror — ACE ManaStone.cs:56, RecipeManager.cs:737
   *  broadcast this on the magical-glow effect (corpse loot, ground items,
   *  charge-status indicators). FAITHFUL.344. */
  uiEffects?: number;
  /** PropertyBool.Locked mirror — ACE Chest.cs:251, Door.cs:220,
   *  Lock.cs:275,310 broadcast this on lock-state changes. Used by the
   *  cursor + interaction logic to distinguish a locked door (lock icon)
   *  from an open one (door icon). FAITHFUL.364. */
  isLocked?: boolean;
  /** UiHidden mirror — seeded from CreateObject's ObjectDescriptionFlag
   *  0x80 (ACE WorldObject_Networking.cs:867), live-updated by
   *  PropertyBool.UiHidden broadcasts (ACE Hook.cs:259, house-display-hook
   *  visibility toggles). Retail BF_UI_HIDDEN gates the whole mouse-over
   *  pipeline (RecvNotice_SmartBoxObjectFound @ 004e5ad0 treats the object
   *  as not found) and the radar (gmRadarUI::AddObject @ 004d9a00 refuses
   *  it; GetBlipColor/GetBlipShape bail). FAITHFUL.364 +
   *  BUG.uihidden-never-read. */
  uiHidden?: boolean;
  /** PropertyInt.Value mirror — shipped on CreateObject via
   *  WeenieHeaderFlag.Value (ACE WorldObject_Networking.cs:99-100). 0 when
   *  the flag is not set on the wire. FAITHFUL.541 — without this on
   *  ServerObject, the trade panel's partner-side item rows always
   *  displayed value=0 because the AddToTrade handler fell back to 0
   *  whenever lookup hit ServerObject (vs inventory for own items). */
  value?: number;
  /** EncumbranceVal mirror — shipped on CreateObject via
   *  WeenieHeaderFlag.Burden (ACE WorldObject_Networking.cs:156-157, as
   *  ushort). Per-item weight used for trade-window burden totals + the
   *  inventory burden bar. Same FAITHFUL.541 propagation gap. */
  burden?: number;
  /** BUG.icon-overlay-underlay-dropped — see CreateObjectData.iconOverlayId
   *  doc (packages/network/src/MessageSerializer.ts). 0 = no overlay. */
  iconOverlayId?: number;
  /** BUG.icon-overlay-underlay-dropped — see CreateObjectData.iconUnderlayId
   *  doc. 0 = no underlay. */
  iconUnderlayId?: number;
  /** CORE.17.d — allegiance monarch IID off the CreateObject wire
   *  (WeenieHeaderFlag.Monarch), kept current by PublicUpdateInstanceId
   *  Monarch. Retail radar: ACCWeenieObject::IsAllegianceMember @ 0058c630
   *  draws same-monarch players as the hollow-box blip. 0 = none. */
  monarchGuid?: number;
  /** PublicWeenieDesc hook fields (CreateObjectData.hookType / hookItemTypes /
   *  houseOwnerId): a housing hook's store gate, ItemHolder::CheckHookStatus. */
  hookType?: number;
  hookItemTypes?: number;
  houseOwnerId?: number;
  /** BUG.cooldown-id-duration-discarded — see CreateObjectData.cooldownId
   *  doc. 0 = no use cooldown. */
  cooldownId?: number;
  /** BUG.cooldown-id-duration-discarded — see
   *  CreateObjectData.cooldownDuration doc. 0 = not sent. */
  cooldownDuration?: number;
  /** BUG.structure-maxstructure-discarded — see CreateObjectData.structure
   *  doc. Uses remaining on a limited-use item; kept live by
   *  PublicUpdatePropertyInt Structure broadcasts (ACE Healer.cs:191,
   *  Lock.cs:94, PetDevice.cs:94). */
  structure?: number;
  /** BUG.structure-maxstructure-discarded — see
   *  CreateObjectData.maxStructure doc. 0 = no uses meter. */
  maxStructure?: number;
  /**
   * BUG.setstate-sequence-guard-not-enforced — last-applied SetState
   * `stateSequence` (ushort, FAITHFUL.338), used by setPhysicsState to drop
   * out-of-order SetState packets the same way the retail client's
   * SmartBox::DoSetState (@0x004520d0) does. -1 = unset (no SetState
   * applied yet — the first one is always accepted).
   */
  lastStateSequence: number;
  /**
   * BUG.objdescevent-sequence-not-enforced — last-applied ObjDescEvent
   * `visualDescSequence` (ushort, ACE SequenceManager.cs registers
   * ObjectVisualDesc as a UShortSequence alongside ObjectState), used by
   * updateAppearance to drop out-of-order appearance updates the same way
   * setPhysicsState drops out-of-order SetState packets. -1 = unset (no
   * ObjDescEvent applied yet — the first one is always accepted).
   */
  lastVisualDescSeq: number;
  /**
   * BUG.door-collision-static-pose-no-hold — transient state 0x100
   * CHECK_ETHEREAL: set_ethereal(0) @ 00511c40 found something overlapping
   * the object, so it stayed Ethereal; CPhysicsObj::UpdateObjectInternal
   * @ 005156b0 calls set_ethereal(0) again every frame until it is clear.
   */
  checkEthereal?: boolean;
}

/**
 * Wraparound-aware ushort "is newer" comparison for FAITHFUL.338-style
 * sequence-numbered messages (SetState.stateSequence and similar). Treats
 * the 16-bit sequence space as circular via a half-range gate, so a small
 * forward step across the 0xFFFF→0 wrap still counts as newer, while an
 * equal sequence (a retransmit, not a new update) does not. Matches the
 * decompiled retail client's abs-diff comparison in e.g.
 * SmartBox::DoSetState (@0x004520d0), which resolves to `diff = (newSeq -
 * lastSeq) & 0xFFFF; return diff > 0 && diff < 0x8000` for its
 * `uVar1 < param_3` / `param_3 < uVar1` branch pair.
 */
export function isSequenceNewer(newSeq: number, lastSeq: number): boolean {
  const diff = (newSeq - lastSeq) & 0xffff;
  return diff > 0 && diff < 0x8000;
}

/**
 * PhysicsState bits that stop the mesh from being drawn.
 *
 * BUG.physicsstate-nodraw-ignored — NoDraw (0x20) hides the object exactly
 * like Hidden (0x4000) does in the retail client (CPhysicsObj::set_nodraw,
 * client-eol demangled.txt:70648). ACE relies on it for empty house hooks
 * with hooks hidden (Hook.cs:247 UpdateHookVisibility → NoDraw=true +
 * EnqueueBroadcastPhysicsState) and @cloak'd admins (Player_Tracking.cs:200);
 * both stay alive server-side, so the client must keep the object but stop
 * drawing it.
 */
export const PHYSICS_HIDE_MASK = PhysicsState.Hidden | PhysicsState.NoDraw;

/** Why an object left the table (the removal journal, ServerObjectManager.onBulkRemoval). */
export type ObjectRemovalReason =
  | 'server' | 'recreate' | 'maint' | 'clear'
  | 'own-inventory' | 'pickup' | 'wield';
/** Removals in one maintenance pass at or above this are reported. */
export const BULK_REMOVAL_REPORT = 5;

/** PositionPack flag IsGrounded (ACE PositionFlags 0x4, retail has_contact). */
const POSITION_FLAG_IS_GROUNDED = 0x4;

/**
 * PropertyDataId (ACE.Entity.Enum.Properties.PropertyDataId) → ServerObject
 * field mapping for live PublicUpdatePropertyDataID broadcasts. Pulled out
 * of the onPublicUpdatePropertyDataID switch in main.ts so it's a plain
 * function the wire handler can delegate to instead of an inline switch.
 */
export function applyPropertyDataIdUpdate(obj: ServerObject, key: number, val: number): void {
  switch (key) {
    case 1: /* PropertyDataId.Setup */
      obj.setupId = val;
      break;
    case 2: /* PropertyDataId.MotionTable */
      obj.motionTableId = val;
      break;
    case 3: /* PropertyDataId.SoundTable */
      obj.soundTableId = val;
      // BUG.remote-anim-sound-hooks — the hook anchor plays from it.
      if (obj.mesh) obj.mesh.userData[SOUND_TABLE_KEY] = val;
      break;
    case 8: /* PropertyDataId.Icon */
      obj.iconId = val;
      break;
    case 50: /* PropertyDataId.IconOverlay */
      obj.iconOverlayId = val;
      break;
    case 52: /* PropertyDataId.IconUnderlay */
      obj.iconUnderlayId = val;
      break;
  }
}

/** Convert AC landblock position to world coordinates. */
/**
 * ACCWeenieObject::IsStorage @ 0058cbe0's wcid: DBObj::GetDIDByEnum with
 * enum 12 / 0x10000001 through the DAT header's master map (master[12] →
 * a DidMapper, its [0x10000001]). 0 when the DAT has no master map (AC1999).
 */
export function storageWcidOf(db: { masterMapId: number; getFileData(id: number): ArrayBuffer | null | undefined }): number {
  const read = (id: number | undefined) => {
    if (!id) return null;
    try { const d = db.getFileData(id); return d ? readDidMapper(new DatReader(d)) : null; } catch { return null; }
  };
  return read(read(db.masterMapId)?.client.enumToId.get(12))?.client.enumToId.get(0x10000001) ?? 0;
}

function acPositionToWorld(pos: ACPosition): { x: number; y: number; z: number } {
  const lbX = landblockX(pos.landblock);
  const lbY = landblockY(pos.landblock);
  return {
    x: lbX * 192 + pos.x,
    y: pos.z, // AC Z → Three.js Y (height)
    z: lbY * 192 + pos.y, // AC Y → Three.js Z
  };
}

/**
 * FAITHFUL.375 / DECOMP.transparent-tween-clobbers — the server's
 * Translucency (0 = opaque, 1 = invisible) on an object: it becomes the
 * object's translucencyOriginal floor and its current translucency, applied
 * part by part the retail way (models/ObjectTranslucency: CPhysicsObj::
 * SetTranslucencyInternal @ 0050f960 → CPhysicsPart::SetTranslucency, the
 * material alpha over each surface's own; 1.0 = the parts are not drawn).
 * The current value is remembered on the root (TRANSLUCENCY_KEY) so an
 * appearance rebuild re-applies it (CPhysicsObj::DoObjDescChanges @ 0050fa30).
 */
export { TRANSLUCENCY_KEY, TRANSLUCENCY_ORIGINAL_KEY };

export function applyTranslucency(root: THREE.Object3D, translucency: number): void {
  setServerTranslucency(root, translucency);
}

/**
 * FAITHFUL.344 — Route a PublicUpdatePropertyInt broadcast to the mirrored
 * ServerObject fields it affects, so nearby observers see the change live
 * instead of it staying frozen at CreateObject-time values.
 *
 * ACE emit sites for the keys handled here:
 *   PropertyInt.RadarBlipColor     — AdvocateItem.cs:35,44 (admin advocate-item
 *     activate/deactivate flips the radar-dot color).
 *   PropertyInt.PlayerKillerStatus — Player_Death.cs:966,971,1018 (PK
 *     transitions). GAP.64: feeds the examine/assess PK-status row; does NOT
 *     drive radar color (radarColorToTargetType keys off obj.radarColor).
 *   PropertyInt.UiEffects          — ManaStone.cs:56, RecipeManager.cs:737
 *     (magical-glow visual state on items).
 *
 * Extracted out of main.ts's inline onPublicUpdatePropertyInt closure so the
 * routing table is independently testable (was previously covered only by a
 * source-text-regex pin over main.ts).
 */
export function applyPublicUpdatePropertyInt(obj: ServerObject, key: number, value: number): void {
  switch (key) {
    case PropertyInt.RadarBlipColor:
      obj.radarColor = value;
      break;
    case PropertyInt.PlayerKillerStatus:
      obj.playerKillerStatus = value;
      break;
    case PropertyInt.UiEffects:
      obj.uiEffects = value;
      break;
    case PropertyInt.Level:
      obj.level = value;
      break;
    // BUG.structure-maxstructure-discarded — world-visible uses-remaining
    // updates. ACE emit sites: Lock.cs:94 (unlocker), Healer.cs:191
    // (healing kit), PetDevice.cs:94/576 (pet device drain + refill).
    case PropertyInt.Structure:
      obj.structure = value;
      break;
    case PropertyInt.MaxStructure:
      obj.maxStructure = value;
      break;
  }
}

/**
 * FAITHFUL.384 — When a PublicUpdatePropertyInt Level broadcast is for the
 * player's currently-selected target, mirror it into the live HUD target
 * panel too (not just the ServerObject). Pre-fix the HUD target panel
 * captured level=0 at selectTarget time and never refreshed on later
 * level-up broadcasts.
 *
 * Takes only the minimal HUD-target shape (not the full GameUI instance)
 * so this is testable without constructing GameUI's heavy dependency graph.
 */
export function applyPublicUpdatePropertyIntToHudTarget(
  hudTarget: { level: number } | null | undefined,
  currentTargetGuid: number | null,
  guid: number,
  key: number,
  value: number,
): void {
  if (key === PropertyInt.Level && currentTargetGuid === guid && hudTarget) {
    hudTarget.level = value;
  }
}

/** A held object's mesh lifted off its holding part (`part_N`) of a setup group. */
interface HeldAttachment { partName: string; child: THREE.Object3D }

/**
 * DECOMP.objdesc-drops-held-item — remove every held-object mesh (the
 * `wielded_<ParentLocation>` children main.ts attaches to a holding part)
 * from a setup group's parts, remembering which part held it.
 */
export function takeHeldAttachments(root: THREE.Object3D): HeldAttachment[] {
  const held: HeldAttachment[] = [];
  for (const part of root.children ?? []) {
    for (const child of [...(part.children ?? [])]) {
      if (!child.name?.startsWith('wielded_')) continue;
      part.remove(child);
      held.push({ partName: part.name, child });
    }
  }
  return held;
}

/**
 * Put held-object meshes back on the same-named parts of a rebuilt setup
 * group. Their local transform is the holding location's frame in part
 * space, so it carries over unchanged. Returns the ones with no such part.
 */
export function restoreHeldAttachments(root: THREE.Object3D, held: HeldAttachment[]): HeldAttachment[] {
  const orphans: HeldAttachment[] = [];
  for (const h of held) {
    // A direct child: a held item's own setup has `part_N` groups too.
    const part = root.children.find(c => c.name === h.partName);
    if (part) part.add(h.child);
    else orphans.push(h);
  }
  return orphans;
}

export class ServerObjectManager {
  private objects = new Map<number, ServerObject>();
  private setupModelRenderer: SetupModelRenderer;
  private appearanceManager: AppearanceManager;
  private scene: THREE.Scene;
  private playerGuid: number = 0;
  /** Our own character's ObjectDescriptionFlags (PK / PK-Lite bits) from its CreateObject. */
  private localDescFlags = 0;
  /** The local player's own ObjectDescriptionFlag bits (its CreateObject), for ObjectIsAttackable's PK pairing. */
  get playerDescFlags(): number { return this.localDescFlags; }
  /** The player's own CreateObject / UpdateObject flags (main.ts routes 'self' away before createObject). */
  setPlayerDescFlags(flags: number): void { this.localDescFlags = flags >>> 0; }
  /** The player's own PublicWeenieDesc use fields (its CreateObject) — the
   *  toolbar Use button's state when the player selects themself. */
  private localUseDesc = { itemType: 0, usable: 0, combatUse: 0 };
  get playerUseDesc(): { itemType: number; usable: number; combatUse: number } { return this.localUseDesc; }
  setPlayerUseDesc(d: { itemType?: number; usable?: number; combatUse?: number }): void {
    this.localUseDesc = { itemType: d.itemType ?? 0, usable: d.usable ?? 0, combatUse: d.combatUse ?? 0 };
  }
  private portalDb: DatDatabase | null = null;
  private terrainCollision: TerrainCollision | null = null;
  /**
   * BUG.gravity-item-placed-midair — where a Gravity object entering the
   * world comes to rest (outdoorGround.objectLandingZ). Null = no
   * collision world wired (objects stay at the server's frame).
   */
  private objectLandingQuery: NonNullable<RemotePhysicsEnv['landingZ']> | null = null;
  /** AnimatedEntity instances for objects with motion tables (idle animations). */
  private animatedObjects = new Map<number, AnimatedEntity>();
  /** CMotionInterp::server_action_stamp per object (0 on a new object — the ctor's). */
  private serverActionStamps = new Map<number, number>();
  /**
   * BUG.setup-default-animation-never-played — CPartArray::InitDefaults
   * @ 00518980 (from SetSetupID, for every object): a Setup with a
   * default_anim_id gets a sequence looping it (frames 0..-1 at 30 fps).
   * A motion table, when there is one, replaces it. Missiles included:
   * frost / lightning / force bolts, whirling blades, house signs, flags.
   */
  private defaultAnims = new Map<number, { player: AnimationPlayer; mesh: THREE.Object3D; parts: (THREE.Object3D | null)[] }>();
  /**
   * STREAM.cold-creature-never-animates — the latest interpreted motion state
   * (CreateObject Movement blob or MovementEvent) of an object that has no
   * sequence yet because its streamed motion table / animation was not
   * resident. Retail's CMotionInterp holds the state whatever the parts can
   * show; ours is applied when the streamed rebuild brings the sequence up
   * (rebuildMesh → initStreamedAnimation).
   */
  private pendingMotion = new Map<number, ParsedMovementData>();

  /** The local player's GUID — movement events for this entity skip stance/forward
   *  changes since CharacterAnimController handles those locally. Attack actions
   *  from the server still get processed. */
  private localPlayerGuid: number = 0;
  /**
   * The local player's sequence is advanced by its physics step
   * (CameraController.sequenceStep → player/LocalSequenceStep, retail's
   * UpdatePositionInternal), so updateAnimations must not advance it again.
   */
  localPlayerSequenceStepped = false;
  /**
   * Our character's position (THREE axes: x, z horizontal, y = feet), radius
   * and height — a creature's MoveTo / TurnTo target is usually us.
   */
  localPlayerPosition: (() => {
    x: number; z: number; radius: number; y?: number; height?: number;
    /** The body spheres (radius, centre heights above the feet); absent = the Human default. */
    bodySpheres?: { radius: number; heights: readonly number[] };
  } | null) | null = null;
  /**
   * An object's physics model by Setup / GfxObj id (main.ts objectPhysics) —
   * what set_ethereal(0)'s overlap test (ethereal_check_for_collisions)
   * reads. Null: no test, Ethereal clears at once.
   */
  objectPhysics: ((setupId: number) => ObjectPhysicsModel | null) | null = null;
  /** The scratch collider ethereal_check_for_collisions poses one object in (made on first use). */
  private etherealCheckCollider: DungeonCollision | null = null;
  /**
   * A non-autonomous server MoveTo / TurnTo (MovementType 6–9) for our own
   * character: main.ts runs it on the player's MoveToManager.
   */
  onLocalPlayerMovement: ((movementType: number, move: { moveTo?: ParsedMoveTo; turnTo?: ParsedTurnTo }) => void) | null = null;
  /**
   * Any live non-autonomous movement for our own character (a windup, a
   * gesture, a swing, a server Ready, a MoveTo / TurnTo, a stance change):
   * CPhysics::SetObjectMovement @ 00509690 applies it, and its caller
   * (ACSmartBox::DispatchSmartBoxEvent 0xF74C) then calls cmdinterp
   * LoseControlToServer — main.ts → CameraController.loseControlToServer.
   */
  onLocalPlayerServerMotion: (() => void) | null = null;
  /**
   * The style of a non-autonomous movement for our own character
   * (CPhysics::SetObjectMovement @ 00509690 applies it to the player like
   * any object's): the server's stance wins over the one the client guessed
   * from the wielded weapon.
   */
  onLocalPlayerStyle: ((stanceId: number) => void) | null = null;

  /**
   * An animation-frame hook fired on a server object's animation (its
   * CSequence) — main.ts executes the particle hooks on `anchor`.
   */
  onAnimationHook: ((guid: number, hook: AnimationHook, anchor: THREE.Object3D) => void) | null = null;

  /**
   * CSequence::execute_hooks → CAnimHook::Execute on one object. The physics
   * hooks act on the object's own state here; the rest go to onAnimationHook.
   * EtherealHook::Execute @ 00526bc0 → CPhysicsObj::set_ethereal @ 00511c40:
   * 1 sets ETHEREAL_PS (0x4) in the state, 0 clears it. That is how a door
   * opens for collision when its server only plays the On / Off motion: the
   * AC1999 server (CBaseDoor::OpenDoor) sends no SetState, so the client
   * kept the door solid while the server walked the player through it, then
   * snapped them on (BUG.ac1999-forced-position-snap). ACE also sends
   * SetState, which replaces the whole state as before.
   * BUG.door-collision-static-pose-no-hold: set_ethereal(0) keeps an object
   * that overlaps something Ethereal until it is clear (setEthereal).
   */
  private runObjectHook(guid: number, hook: AnimationHook, anchor: THREE.Object3D): void {
    if (hook.hookType === AnimationHookType.Ethereal) {
      const obj = this.objects.get(guid);
      if (obj) this.setEthereal(obj, (hook as EtherealHookData).ethereal !== 0);
    }
    this.onAnimationHook?.(guid, hook, anchor);
  }

  /**
   * BUG.door-collision-static-pose-no-hold — CPhysicsObj::set_ethereal
   * @ 00511c40. On: set ETHEREAL_PS (0x4). Off: clear it, then, for an
   * unparented object in a cell, ethereal_check_for_collisions @ 00510a40:
   * if anything overlaps it as it stands it stays Ethereal and sets
   * CHECK_ETHEREAL (0x100), which UpdateObjectInternal @ 005156b0 retries
   * every frame (updateAnimations) — a player standing in a closing door
   * holds it open and can walk out (ACE allow_door_hold, Door.cs:182-207,
   * PhysicsObj.cs:3605). Either way the state reaches the object's physics
   * and its mesh, as setPhysicsState does. Returns false when held.
   */
  private setEthereal(obj: ServerObject, ethereal: boolean): boolean {
    let held = false;
    if (ethereal) {
      obj.physicsState |= PhysicsState.Ethereal;
    } else {
      obj.physicsState &= ~PhysicsState.Ethereal;
      if (!obj.wielderId && obj.physics?.inCell && !obj.lostCell && !obj.outOfWorld && this.etherealCheckForCollisions(obj)) {
        obj.physicsState |= PhysicsState.Ethereal;
        held = true;
      }
    }
    obj.checkEthereal = held;
    obj.physics?.setState(obj.physicsState);
    if (obj.mesh) obj.mesh.userData[PHYSICS_STATE_KEY] = obj.physicsState;
    return !held;
  }

  /**
   * CPhysicsObj::ethereal_check_for_collisions @ 00510a40 → CObjCell::
   * check_collisions @ 0052b7b0 → CPhysicsObj::check_collision @ 00512ed0:
   * does any other unparented, non-Static object around this one overlap it
   * at rest — its body spheres (CPartArray::GetSphere, at most two, × its
   * scale) against this object's shape at its current pose
   * (FindObjCollisions: part BSPs for HasPhysicsBSP, else CylSpheres, else
   * Spheres)? The others are our character (localPlayerPosition) and the
   * creatures within reach.
   */
  private etherealCheckForCollisions(obj: ServerObject): boolean {
    if (!this.objectPhysics || !obj.mesh) return false;
    const collider = (this.etherealCheckCollider ??= new DungeonCollision());
    const keys = addCreatureObstacles(collider, [this.blockerOf(obj)], this.objectPhysics);
    if (keys.length === 0) return false;
    try {
      const reach = 10;
      const me = this.localPlayerPosition?.();
      if (me && Math.hypot(me.x - obj.worldX, me.z - obj.worldZ) < reach) {
        const body = me.bodySpheres ?? {
          radius: DungeonCollision.BODY_SPHERE_RADIUS,
          heights: [DungeonCollision.LOWER_SPHERE_HEIGHT, DungeonCollision.UPPER_SPHERE_HEIGHT],
        };
        const feet = me.y ?? obj.worldY;
        if (collider.spheresOverlap(body.heights.map((h) => ({ x: me.x, y: me.z, z: feet + h, radius: body.radius })))) return true;
      }
      for (const other of this.objects.values()) {
        if (other === obj || !(other.itemType & ItemType.Creature) || other.guid === this.localPlayerGuid) continue;
        if (other.wielderId || !other.physics?.inCell || other.outOfWorld || !other.mesh) continue;
        if (other.physicsState & PhysicsState.Static) continue;
        if (Math.hypot(other.worldX - obj.worldX, other.worldZ - obj.worldZ) >= reach) continue;
        const model = this.objectPhysics(other.setupId);
        if (!model || model.spheres.length === 0) continue;
        const q = other.mesh.quaternion;
        const quat = { w: q.w, x: -q.x, y: -q.z, z: -q.y };
        const scale = other.mesh.scale.x || 1;
        const spheres = model.spheres.slice(0, 2).map((sp) => {
          const c = DungeonCollision.composeFrames({ x: other.worldX, y: other.worldZ, z: other.worldY }, quat,
            { x: sp.origin.x * scale, y: sp.origin.y * scale, z: sp.origin.z * scale }, { w: 1, x: 0, y: 0, z: 0 }).origin;
          return { ...c, radius: sp.radius * scale };
        });
        if (collider.spheresOverlap(spheres)) return true;
      }
      return false;
    } finally {
      for (const k of keys) collider.removeKey(k);
    }
  }

  /** Register an externally-created AnimatedEntity (e.g. the player character). */
  registerAnimatedEntity(guid: number, animated: AnimatedEntity, isLocalPlayer = false): void {
    this.animatedObjects.set(guid, animated);
    if (isLocalPlayer) {
      this.localPlayerGuid = guid;
      // The player's CreateObject came before its sequence existed: its
      // style (a login already in combat mode) is the stance to start in.
      const initial = this.pendingMotion.get(guid);
      if (initial && initial.movementType === 0 && initial.styleIndex > 0) this.onLocalPlayerStyle?.(motionStanceFromIndex(initial.styleIndex));
    }
  }

  /** Look up the AnimatedEntity for a server-tracked object (null if not animated). */
  getAnimated(guid: number): AnimatedEntity | undefined {
    return this.animatedObjects.get(guid);
  }
  /** Objects playing death animation — don't return to idle. */
  private dyingObjects = new Set<number>();
  /**
   * BUG.spell-projectile-physics — every server Missile object, flown
   * locally like retail's CPhysicsObj (MissilePhysics.ts): server velocity
   * and omega, gravity only with the Gravity state bit, AlignPath heading,
   * collision with the world and creatures. AC world axes.
   */
  private projectiles = new Map<number, MissileBody>();
  /**
   * The world a missile collides with (terrain, building/static/cell BSPs,
   * scenery CylSpheres/Spheres), wired by main.ts — AC world axes. Creatures
   * are swept here from the objects map. Null → missiles fly unobstructed.
   */
  missileEnvironmentSweep: MissileSweep | null = null;
  /**
   * Sweep a missile's sphere against one non-creature server object's own
   * collision (its Setup's part BSPs / CylSpheres / Spheres at the object's
   * frame and scale) — wired by main.ts. AC world axes. Which objects count,
   * and whether a hit is an object or an environment collision, is decided
   * here (classifyMissileObstacle).
   */
  missileObjectSweep: ((obj: ServerObject, from: V3, to: V3, radius: number) => MissileContact | null) | null = null;
  /**
   * Our character's collision cylinder for missile sweeps — base centre in
   * AC world axes (x east, y north, z = feet), per-heritage Setup radius /
   * height — wired by main.ts (our own CreateObject never reaches the
   * objects map). Null → missiles pass through us until the server says.
   * `physicsRadius`: the first collision sphere's radius (ACE GetPhysicsRadius, 0.48 for a human), which places the
   * server's projectile spawn points; the Setup radius when not given.
   */
  missileLocalPlayer: (() => { x: number; y: number; z: number; radius: number; height: number; physicsRadius?: number } | null) | null = null;
  /**
   * `ACCWeenieObject::DoCollision(AtkCollisionProfile)` @ 0058c3a0 — a
   * ScriptedCollision missile that hits an object plays its PhysicsDesc
   * default script (ACE: PlayScript.ProjectileCollision). main.ts resolves
   * it through the object's PhysicsScriptTable.
   */
  onMissileDefaultScript: ((obj: ServerObject) => void) | null = null;

  constructor(
    setupModelRenderer: SetupModelRenderer,
    appearanceManager: AppearanceManager,
    scene: THREE.Scene,
  ) {
    this.setupModelRenderer = setupModelRenderer;
    this.appearanceManager = appearanceManager;
    this.scene = scene;
  }

  /** Set the portal DAT database for animation loading. */
  setPortalDb(db: DatDatabase): void {
    this.portalDb = db;
    this.storageWcid = null;
  }

  /** Set terrain collision for ground-clamping objects. */
  setTerrainCollision(tc: TerrainCollision): void {
    this.terrainCollision = tc;
  }

  /** The house storage chest's wcid (resolved once from the portal DAT; 0 = none / unknown). */
  private storageWcid: number | null = null;

  /**
   * BUG.gravity-item-placed-midair — CPhysicsObj::SetPositionInternal
   * @ 00515bd0 puts a hook, the house storage chest or a corpse in its cell
   * with ForceIntoCell @ 00515660 (weenie vtable +0x74 / +0x78 / +0x7c =
   * ACCWeenieObject::IsHook @ 0058c660 / IsStorage @ 0058cbe0 / IsCorpse
   * @ 0058c8e0), which never runs calc_acceleration: their acceleration
   * stays zero and they never fall, Gravity or not. IsHook: hook type and
   * hook item types both set; IsCorpse: PublicWeenieDesc bit 0x2000;
   * IsStorage: the wcid GetDIDByEnum(0x10000001, 12) names — master map
   * [12] → DidMapper 0x25000015 [0x10000001] = 9687 in the end-of-retail
   * and Dark Majesty DATs (the 400 house storage chests ACE places 0.326 m
   * up, their mesh hanging under the origin).
   */
  private forcedIntoCell(data: CreateObjectData): boolean {
    if ((data.hookType ?? 0) !== 0 && (data.hookItemTypes ?? 0) !== 0) return true;
    if (((data.objectDescFlags ?? 0) & ObjectDescriptionFlag.Corpse) !== 0) return true;
    if (this.storageWcid === null && this.portalDb) this.storageWcid = storageWcidOf(this.portalDb);
    return !!this.storageWcid && data.weenieClassId === this.storageWcid;
  }

  /** Wire the landing query (AC landblock-global x / y / z) a placed Gravity object falls by. */
  setObjectLandingQuery(q: NonNullable<RemotePhysicsEnv['landingZ']> | null): void {
    this.objectLandingQuery = q;
  }

  setPlayerGuid(guid: number): void {
    this.playerGuid = guid;
  }

  /**
   * Optional callback invoked after a ServerObject's mesh is created and
   * added to the scene. Used by the PhysicsScript runtime (FAITHFUL.177) to
   * fire DAT-resident defaultScript playback on world objects (ambient
   * creature/object visual effects). Callback receives the populated
   * ServerObject so it can introspect setupId / position / etc.
   */
  onObjectCreated: ((obj: ServerObject) => void) | null = null;

  /**
   * Optional callback invoked just before a ServerObject's mesh is removed
   * from the scene and disposed (deleteObject/forceDelete). Mirrors
   * onObjectCreated so the PhysicsScript runtime can stop any scripts still
   * running against the about-to-be-disposed mesh (ACE PhysicsObj.cs
   * Destroy() nulls MovementManager/ScriptManager so nothing pending fires
   * against a dead object).
   */
  onObjectDeleted: ((obj: ServerObject) => void) | null = null;

  /**
   * BUG.invented-portal-burst-and-spell-effects — CPhysicsObj::set_hidden @
   * 00514c60: an edge of PhysicsState Hidden (a SetState, or a CreateObject
   * arriving Hidden against the ctor default) plays the object's Hidden /
   * UnHide script (effects/HiddenStateScripts). The owner resolves it through
   * the object's PhysicsScriptTable like any PlayScript.
   */
  onHiddenStateScript: ((guid: number, script: PlayScript.Hidden | PlayScript.UnHide) => void) | null = null;

  /**
   * REND.appearance-rebuild-orphans-emitters — invoked after an appearance
   * update (ObjDescEvent) swapped `obj.mesh` for a rebuilt one (`obj.mesh`
   * may be null if the rebuild failed). `oldMesh` is already out of the
   * scene and disposed; the owner stops anything anchored on it.
   */
  onMeshReplaced: ((obj: ServerObject, oldMesh: THREE.Object3D) => void) | null = null;

  get objectCount(): number {
    return this.objects.size;
  }

  getObject(guid: number): ServerObject | undefined {
    return this.objects.get(guid);
  }

  /**
   * The object's part-array cylinder (CPartArray::GetRadius/GetHeight @
   * 005180a0/005180b0: Setup radius/height × scale) and, for a creature, its
   * cylsphere blocking radius × scale. 0 when the Setup can't load.
   */
  private applyPartArrayCylinder(obj: ServerObject, setupId: number, scale: number): void {
    let setup: ReturnType<SetupModelRenderer['loadSetupModel']> | null = null;
    try { setup = this.setupModelRenderer.loadSetupModel(setupId); } catch { setup = null; }
    const cyl = partArrayCylinder(setup, scale);
    obj.collisionRadius = cyl.radius;
    obj.collisionHeight = cyl.height;
    obj.blockRadius = (obj.itemType & ItemType.Creature) !== 0 ? creatureBlockRadius(setup, scale) : 0;
  }

  /**
   * A live ObjScale change (PublicUpdatePropertyFloat DefaultScale):
   * CPhysicsObj::SetScaleInternal @ 00511bb0 feeds the part array's scale,
   * which GetRadius / GetHeight read — so the cylinder rescales with the mesh.
   */
  setObjectScale(guid: number, scale: number): void {
    const obj = this.objects.get(guid);
    if (!obj || !Number.isFinite(scale) || scale <= 0) return;
    // SetScaleInternal sets the object's m_scale whether or not it has parts
    // yet (STREAM.meshless-translucency-lost: a streamed build takes it).
    if (obj.physics) obj.physics.scale = scale;
    if (!obj.mesh) return;
    // Held items keep their own scale (CPhysicsObj::UpdateChild: frames carry none).
    rescaleHeldCopiesForHolder(obj.mesh, scale / obj.mesh.scale.y);
    obj.mesh.scale.setScalar(scale);
    if (!this.projectiles.has(guid)) this.applyPartArrayCylinder(obj, obj.setupId, scale);
  }

  /**
   * FAITHFUL.375 — a live Translucency (PublicUpdatePropertyFloat 76): the
   * server's value becomes the object's translucencyOriginal and its
   * translucency (models/ObjectTranslucency setServerTranslucency). Kept on
   * the record for an object with no parts yet (STREAM.meshless-translucency-
   * lost). Out-of-range values are ignored.
   */
  setServerTranslucency(guid: number, value: number): void {
    const obj = this.objects.get(guid);
    if (!obj || !Number.isFinite(value) || value < 0 || value > 1) return;
    obj.translucency = value;
    if (obj.mesh) applyTranslucency(obj.mesh, value);
  }

  /** True if this object is playing its death animation or is a corpse — the local
   *  equivalent of ACE's Creature.IsAlive going false (Player_Melee.cs:127). */
  isDying(guid: number): boolean {
    return this.dyingObjects.has(guid);
  }

  getAllObjects(): Map<number, ServerObject> {
    return this.objects;
  }

  /**
   * The objects that may block our character near (wx, wz) — FindObjCollisions'
   * rules (world/CreatureCollision.ts): ethereal objects and non-PK players
   * don't block; a HasPhysicsBSP object collides by its part BSPs, any other
   * by its Setup's cylspheres/spheres × scale. RECON.closed-doors-walkthrough:
   * every object in a cell, not only creatures — a closed door or gate is a
   * BSP-only object. Missiles, held/wielded items and contained items (never
   * placed in a cell) are not in the player's way. A dying creature still
   * is (BUG.dying-creature-loses-collision): CPhysicsObj::FindObjCollisions
   * @ 0050f050 has no motion or death test, so it collides until its
   * DeleteObject (ACE Creature_Death.cs sets no Ethereal).
   */
  getBlockersNear(wx: number, wz: number, range: number): CreatureBlocker[] {
    const result: CreatureBlocker[] = [];
    const r2 = range * range;
    for (const obj of this.objects.values()) {
      if (!obj.mesh || obj.outOfWorld || obj.wielderId || !obj.physics?.inCell) continue;
      if (this.projectiles.has(obj.guid)) continue;
      if ((obj.itemType & ItemType.Creature) && obj.blockRadius <= 0) continue;
      if (!blocksLocalPlayer(obj, this.localDescFlags)) continue;
      const dx = obj.worldX - wx, dz = obj.worldZ - wz;
      if (dx * dx + dz * dz > r2) continue;
      result.push(this.blockerOf(obj));
    }
    return result;
  }

  /**
   * An object posed for collision: its frame, scale and state, and — for a
   * HasPhysicsBSP object with a sequence — each part's frame at the current
   * animation frame (CreatureBlocker.partFrames; CPartArray::UpdateParts
   * @ 005190f0), so an open door collides as its open leaf.
   */
  private blockerOf(obj: ServerObject): CreatureBlocker {
    // THREE mesh quaternion (x, y, z, w) = AC (−x, −z, −y, w).
    const q = obj.mesh?.quaternion;
    const blocker: CreatureBlocker = {
      guid: obj.guid, worldX: obj.worldX, worldY: obj.worldY, worldZ: obj.worldZ,
      collisionRadius: obj.blockRadius, setupId: obj.setupId,
      quat: q ? { w: q.w, x: -q.x, y: -q.z, z: -q.y } : { w: 1, x: 0, y: 0, z: 0 },
      scale: obj.mesh?.scale.x || 1,
      physicsState: obj.physicsState,
    };
    if (obj.physicsState & PhysicsState.HasPhysicsBSP) {
      const frames = this.animatedObjects.get(obj.guid)?.motionManager.getPartTransforms()
        ?? this.defaultAnims.get(obj.guid)?.player.getPartTransforms();
      if (frames && frames.length > 0) blocker.partFrames = frames;
    }
    return blocker;
  }

  /**
   * Create a server object from CreateObject data. Returns the object if model was built.
   *
   * DECOMP.recreate-teardown — `SmartBox::HandleCreateObject` @ 00454c80 for
   * a guid it already holds compares the wire INSTANCE_TS with the held
   * object's: an older instance is dropped (NETBLOB_OLD_INSTANCE), the SAME
   * instance updates the object in place (updateInPlace), and only a newer
   * instance — or an UpdateObject (`isUpdate`, `HandleUpdateObject` @
   * 00455580 passes is_update=1) — destroys it and builds a new one.
   */
  createObject(data: CreateObjectData, isUpdate = false): ServerObject | null {
    // Skip our own player — handled separately (its PK flags decide who blocks us)
    if (data.guid === this.playerGuid) { this.localDescFlags = data.objectDescFlags ?? 0; this.setPlayerUseDesc(data); return null; }

    const held = this.objects.get(data.guid);
    if (held) {
      const instance = data.timestamps?.[PhysicsTimestamp.Instance];
      if (!isUpdate && instance !== undefined && held.instanceSequence !== undefined
        && !isSequenceNewer(instance, held.instanceSequence)) {
        if (instance !== held.instanceSequence) return held; // NETBLOB_OLD_INSTANCE
        this.updateInPlace(held, data);
        return held;
      }
      this.deleteObject(data.guid, 'recreate');
    }

    const obj: ServerObject = {
      guid: data.guid,
      name: data.name,
      pluralName: data.pluralName || '',
      weenieClassId: data.weenieClassId,
      setupId: data.setupId,
      peTableId: data.peTableId,
      iconId: data.iconId,
      itemType: data.itemType,
      physicsState: data.physicsState,
      position: data.position,
      worldX: 0,
      worldY: 0,
      worldZ: 0,
      radarColor: data.radarColor,
      radarBehavior: data.radarBehavior,
      usable: data.usable,
      combatUse: data.combatUse ?? 0,
      targetType: data.targetType ?? 0,
      useRadius: data.useRadius ?? 0.6,
      stackSize: data.stackSize || 0,
      maxStackSize: data.maxStackSize || 0,
      mesh: null,
      basePalette: data.basePalette,
      subPalettes: data.subPalettes,
      textureChanges: data.textureChanges,
      animPartChanges: data.animPartChanges,
      motionTableId: data.motionTableId || 0,
      soundTableId: data.soundTableId || 0,
      defaultScriptOverride: data.defaultScript || 0,
      defaultScriptIntensity: data.defaultScriptIntensity ?? 0,
      objectDescFlags: data.objectDescFlags || 0,
      petOwner: data.petOwner ?? 0,
      itemsCapacity: data.itemsCapacity ?? 0,
      containersCapacity: data.containersCapacity ?? 0,
      // BUG.uihidden-never-read — seed the mirror from the CreateObject
      // ObjectDescriptionFlag bits (ACE WorldObject_Networking.cs:867
      // UpdateObjectDescriptionFlag(UiHidden, UiHidden)); live PropertyBool
      // broadcasts (Hook.cs) update it afterwards.
      uiHidden: ((data.objectDescFlags || 0) & ObjectDescriptionFlag.UiHidden) !== 0,
      wielderId: data.wielderId || 0,
      wieldedLocation: data.currentWieldedLocation || 0,
      // BUG.clothingpriority-never-lands — per-object wire value (see the
      // field docblock); undefined when WeenieHeaderFlag.Priority absent.
      clothingPriority: data.clothingPriority,
      ammoType: data.ammoType,
      placement: data.placement,
      translucency: data.translucency ?? 0,
      parentLocation: data.parentLocation || 0,
      collisionRadius: 0,
      blockRadius: 0,
      collisionHeight: 0,
      cellId: data.position ? (data.position.landblock & 0xFFFF) : 0xFFFF,
      objCellId: data.position ? (data.position.landblock >>> 0) : 0,
      // FAITHFUL.581 — public vital state, 0 until first PublicUpdateVital
      // broadcast for this guid.
      healthCurrent: 0, healthMax: 0,
      staminaCurrent: 0, staminaMax: 0,
      manaCurrent: 0, manaMax: 0,
      // FAITHFUL.541 — propagate value + burden from CreateObject wire so the
      // trade panel can render partner-side items with accurate columns
      // (pre-fix the value/burden columns always showed 0 for items not in
      // the local player's inventory).
      value: data.value || 0,
      burden: data.burden || 0,
      iconOverlayId: data.iconOverlayId || 0,
      iconUnderlayId: data.iconUnderlayId || 0,
      monarchGuid: data.monarchGuid || 0,
      hookType: data.hookType || 0,
      hookItemTypes: data.hookItemTypes || 0,
      houseOwnerId: data.houseOwnerId || 0,
      cooldownId: data.cooldownId || 0,
      cooldownDuration: data.cooldownDuration || 0,
      // BUG.structure-maxstructure-discarded — uses-remaining bar inputs.
      structure: data.structure || 0,
      maxStructure: data.maxStructure || 0,
      // CPhysicsObj::set_description copies the PhysicsDesc timestamps into
      // update_times[]: later events gate against the create's values.
      lastStateSequence: data.timestamps?.[PhysicsTimestamp.State] ?? -1,
      lastVisualDescSeq: data.timestamps?.[PhysicsTimestamp.ObjDesc] ?? -1,
      instanceSequence: data.timestamps?.[PhysicsTimestamp.Instance],
      positionSequence: data.timestamps?.[PhysicsTimestamp.Position],
      // HandleCreateObject enters a parented object into no cell (only a
      // parentless one with a position gets enter_world): it draws as its
      // holder's attachment, never as a mesh of its own. ACE's create for an
      // item wielded in view carries the Parent block AND a position
      // (BUG.wielded-item-left-behind-on-teleport: the stone drew at the
      // wielder's feet as well as in hand, and stayed when they portaled).
      // A parentless object with no position (cell 0) enters no cell either.
      outOfWorld: !!data.physicsParentId || !data.position || data.position.landblock === 0,
      createData: data,
    };
    this.maintReleased.delete(data.guid >>> 0);

    // Check if this is a missile/projectile
    const isMissile = !!(data.physicsState & PhysicsState.Missile);

    // Compute world position
    if (data.position) {
      // DECOMP.invented-terrain-snap — the server's Z as sent: retail
      // `CPhysicsObj::enter_world` places the object at its Position; the
      // old 5 m snap-to-terrain pulled objects on bridges, docks and stairs
      // into the ground.
      const wp = acPositionToWorld(data.position);
      obj.worldX = wp.x;
      obj.worldY = wp.y;
      obj.worldZ = wp.z;
      obj.serverPlace = { cell: data.position.landblock >>> 0, worldX: wp.x, worldY: wp.y, worldZ: wp.z };
      obj.serverPlaceAt = performance.now();
    }
    // The object's physics: its CreateObject position, velocity, omega and
    // update timestamps (CPhysicsObj::set_description / makeObject).
    if (!isMissile) {
      const ts = data.timestamps;
      obj.physics = new RemotePhysicsObject({
        position: data.position ? {
          cell: data.position.landblock >>> 0,
          pos: { x: obj.worldX, y: obj.worldZ, z: obj.worldY },
          orient: { w: data.position.rw, x: data.position.rx, y: data.position.ry, z: data.position.rz },
        } : null,
        state: data.physicsState,
        stamps: ts ? { position: ts[0], vector: ts[3], teleport: ts[4] } : undefined,
        velocity: { x: data.velocityX || 0, y: data.velocityY || 0, z: data.velocityZ || 0 },
        omega: { x: data.omegaX ?? 0, y: data.omegaY ?? 0, z: data.omegaZ ?? 0 },
        scale: data.objScale || 1,
      });
      obj.motionState = readyMotion();
      obj.myRunRate = 1;
      this.bindPhysics(obj);
      // BUG.gravity-item-placed-midair — SmartBox::HandleCreateObject calls
      // CPhysicsObj::enter_world for a parentless object with a cell: a
      // Gravity item the server sends over a surface (the Academy's
      // Application Form at z 1.5 over a 0.92 m desk) falls onto it
      // (RemotePhysicsObject.enterWorld). Creatures are left to the server's
      // position stream (their heights come with contact every update).
      if (!obj.outOfWorld && data.setupId && (data.itemType & ItemType.Creature) === 0 && !this.forcedIntoCell(data)) {
        const setupId = data.setupId;
        obj.physics.enterWorld(() => {
          let setup: ReturnType<SetupModelRenderer['loadSetupModel']> | null = null;
          try { setup = this.setupModelRenderer.loadSetupModel(setupId); } catch { setup = null; }
          return setup ? { spheres: setup.spheres ?? [], stepDownHeight: setup.stepDownHeight ?? 0 } : null;
        });
      }
    }

    this.buildObjectMesh(obj, data, isMissile);

    this.objects.set(data.guid, obj);

    // BUG.createobject-movement-placement-skipped — apply the object's
    // authoritative initial motion state from the PhysicsDesc Movement blob
    // (ACE SerializePhysicsData writes CurrentMotionState there). Corpses
    // carry MotionCommand.Dead (Corpse.cs:58), doors On/Off (Door.cs
    // motionOpen/motionClosed), so already-open doors and lying corpses
    // render correctly on first sight — this replaces the old "Corpse of "
    // name-prefix hack, which could never cover doors/chests/posed
    // creatures. Runs after objects.set so the death branch's collision
    // zeroing sees the registered object.
    if (!isMissile && data.initialMotion) {
      const animated = this.animatedObjects.get(data.guid);
      if (animated) {
        this.applyParsedMotion(data.guid, animated, data.initialMotion);
        // CPhysicsObj::enter_world (SmartBox::HandleCreateObject, for a
        // parentless object with a cell) removes the link animations the
        // state just queued: the object appears already in its final pose.
        if (!data.wielderId) animated.motionManager.removeAllLinkAnimations();
      } else {
        // STREAM.cold-creature-never-animates — no sequence yet (a streamed
        // motion table / animation is not resident): the state waits for it.
        this.pendingMotion.set(data.guid, data.initialMotion);
      }
    }

    if (obj.mesh && this.onObjectCreated) {
      try { this.onObjectCreated(obj); } catch { /* never let the callback block object spawn */ }
    }
    const hiddenScript = hiddenEdgeScript(PHYSICS_STATE_CTOR_DEFAULT, obj.physicsState);
    if (hiddenScript !== null && this.onHiddenStateScript) {
      try { this.onHiddenStateScript(obj.guid, hiddenScript); } catch { /* never block object spawn */ }
    }
    return obj;
  }

  /**
   * The object's parts (CPhysicsObj::SetSetupID → CPartArray): its mesh at
   * the object's position, lights, visibility, translucency, animation and
   * part-array cylinder — and a missile's local flight. Shared by
   * createObject and the streamed rebuild of an object whose first build
   * produced no mesh (rebuildMesh), which builds the parts for the object it
   * already holds.
   */
  private buildObjectMesh(obj: ServerObject, data: CreateObjectData, isMissile: boolean): void {
    // Build 3D model if we have a setup ID
    if (data.setupId) {
      try {
        obj.mesh = this.buildMesh(data);
        this.syncCellLighting(obj);
      } catch (err) {
        console.warn(`[AC] Failed to build mesh for guid=0x${data.guid.toString(16)} setupId=0x${data.setupId.toString(16)}:`, err);
        obj.mesh = null;
      }

      if (obj.mesh) {
        obj.mesh.name = `server_${data.guid.toString(16)}_${data.name}`;
        obj.mesh.position.set(obj.worldX, obj.worldY, obj.worldZ);
        // BUG.remote-anim-sound-hooks — the object's sound table is its wire
        // stable_id (CPhysicsObj::set_description @ 00514f40; 0 = none): the
        // SoundTable hooks its animations / scripts fire play from it.
        obj.mesh.userData[SOUND_TABLE_KEY] = obj.soundTableId || 0;
        // CPhysicsPart::SetTranslucency @ 0050e670 reads the owner's state (Cloaked).
        obj.mesh.userData[PHYSICS_STATE_KEY] = obj.physicsState;

        // Apply rotation from server position
        if (data.position) {
          const p = data.position;
          obj.mesh.quaternion.set(-p.rx, -p.rz, -p.ry, p.rw);
        }

        // FAITHFUL.374 — Apply ObjScale from the PhysicsDesc. Pre-fix
        // every mesh rendered at scale 1.0 because the parser
        // discarded the float; mob "tier"/growth/polymorph visuals
        // were lost.
        if (data.objScale && data.objScale !== 1.0) {
          obj.mesh.scale.setScalar(data.objScale);
        }

        // BUG.server-object-setup-lights — CPartArray::InitLights: the
        // Setup's LightInfos, present while PhysicsState LightingOn is set.
        this.syncLights(obj);

        // FAITHFUL.375 — Apply Translucency from the PhysicsDesc.
        // Pre-fix every mesh rendered fully opaque even when the
        // server sent translucency=1.0 (ghost creatures, fading
        // lifestone, dispelled summons). Each material's opacity =
        // 1 - translucency.
        if (data.translucency > 0) {
          applyTranslucency(obj.mesh, data.translucency);
        }

        // BUG.physicsstate-nodraw-ignored — an object can arrive with
        // Hidden/NoDraw already set in its CreateObject physicsState (e.g.
        // an empty house hook with hooks hidden). Apply the hide mask at
        // build time so it never flashes visible for the frame before
        // updateInteriorVisibility next runs.
        this.applyVisibility(obj);

        this.scene.add(obj.mesh);

        // Initialize idle animation if the model has a motion table (skip for missiles)
        if (!isMissile) {
          this.tryInitAnimation(obj);
        }
        // …else the Setup's DefaultAnimation loops (missiles too).
        if (!this.animatedObjects.has(obj.guid)) this.tryInitDefaultAnimation(obj);

        // SWEEP1006B.world-objects.remote-objects-radius-height-are — every
        // object with a part array (chests, doors, corpses, portals,
        // lifestones as well as creatures) has the bounding cylinder retail's
        // MoveToObject / melee / range checks measure from:
        // CPartArray::GetRadius/GetHeight = Setup radius/height × ObjScale; 0
        // when the Setup can't load (CPhysicsObj::GetRadius with no part
        // array). Only creatures get the cylsphere blocking radius.
        if (!isMissile) {
          this.applyPartArrayCylinder(obj, data.setupId, data.objScale || 1);
        }
      }
    }

    // BUG.spell-projectile-physics — every Missile is flown locally from its
    // CreateObject physics (CPhysicsObj::set_description: velocity, omega,
    // elasticity, state), including a zero-velocity one: the server's
    // SetState / VectorUpdate / DeleteObject drive what happens next.
    if (isMissile && obj.mesh) {
      const p = data.position;
      let radius = 0;
      try {
        const setup = this.setupModelRenderer.loadSetupModel(data.setupId);
        radius = (setup?.spheres?.[0]?.radius ?? 0) * (data.objScale || 1);
      } catch { radius = 0; }
      this.projectiles.set(data.guid, createMissileBody({
        pos: { x: obj.worldX, y: obj.worldZ, z: obj.worldY },
        vel: { x: data.velocityX, y: data.velocityY, z: data.velocityZ },
        omega: { x: data.omegaX ?? 0, y: data.omegaY ?? 0, z: data.omegaZ ?? 0 },
        orient: p ? { w: p.rw, x: p.rx, y: p.ry, z: p.rz } : { w: 1, x: 0, y: 0, z: 0 },
        state: data.physicsState,
        elasticity: data.elasticity,
        radius,
      }));

      // BUG.spellcast-effects / BUG.projectile-glow-invented — no invented
      // glow: a spell projectile looks like its Setup (e.g. Flame Bolt
      // 0x0200040D) plus the DAT Launch script its PlayScript resolves
      // (trail emitters on part 0, Scale 2). The name-coloured PointLight +
      // emissive override this used to add was client art (and a PointLight
      // add recompiles every lit shader).
    }
  }

  /**
   * DECOMP.recreate-teardown — the same-instance branch of
   * `SmartBox::HandleCreateObject` @ 00454c80: the held CPhysicsObj stays
   * (mesh, animation, scripts, lights, attachments) and each desc is applied
   * through its own gated path, in retail's order: UpdateVisualDesc
   * (OBJDESC_TS), then the parent (DoParentEvent) or the position
   * (HandleReceivedPosition; no position → DoPickupEvent), the movement,
   * DoSetState (STATE_TS), DoVectorUpdate, and the weenie desc.
   */
  private updateInPlace(obj: ServerObject, data: CreateObjectData): void {
    const ts = data.timestamps ?? [];
    obj.createData = data;
    this.updateAppearance({
      guid: obj.guid,
      basePalette: data.basePalette, subPalettes: data.subPalettes,
      textureChanges: data.textureChanges, animPartChanges: data.animPartChanges,
      instanceSequence: ts[PhysicsTimestamp.Instance] ?? 0,
      visualDescSequence: ts[PhysicsTimestamp.ObjDesc] ?? 0,
    });
    const positionTs = ts[PhysicsTimestamp.Position] ?? 0;
    // The PhysicsDesc parent decides, as in the new-object branch (the
    // weenie Wielder can be set with no Parent block — worn armour).
    if (data.physicsParentId) {
      this.parentEvent(obj.guid, data.physicsParentId, data.parentLocation || 0, positionTs);
    } else if (data.position && data.position.landblock !== 0) {
      const p = data.position;
      // HandleReceivedPosition: a CreateObject's position is grounded
      // unless it moves (has_contact from the desc is not on the wire).
      this.applyPositionUpdate(obj.guid, p.landblock >>> 0, p.x, p.y, p.z, p.rw, p.rx, p.ry, p.rz, {
        contact: true,
        positionTs: ts[PhysicsTimestamp.Position],
        teleportTs: ts[PhysicsTimestamp.Teleport],
      });
      obj.position = p;
    } else {
      this.pickupEvent(obj.guid, positionTs);
    }
    if (data.initialMotion) {
      const animated = this.animatedObjects.get(obj.guid);
      if (animated) this.applyParsedMotion(obj.guid, animated, data.initialMotion);
      else this.pendingMotion.set(obj.guid, data.initialMotion);
    }
    this.setPhysicsState(obj.guid, data.physicsState, ts[PhysicsTimestamp.State]);
    this.applyVectorUpdate(obj.guid, data.velocityX ?? 0, data.velocityY ?? 0, data.velocityZ ?? 0,
      data.omegaX ?? 0, data.omegaY ?? 0, data.omegaZ ?? 0, ts[PhysicsTimestamp.Vector]);
    // The weenie desc (CObjectMaint's weenie update): name, icon, stack,
    // value, radar, use data — everything the UI reads off the record.
    obj.name = data.name;
    obj.pluralName = data.pluralName || '';
    obj.weenieClassId = data.weenieClassId;
    obj.iconId = data.iconId;
    obj.itemType = data.itemType;
    obj.radarColor = data.radarColor;
    obj.radarBehavior = data.radarBehavior;
    obj.usable = data.usable;
    obj.combatUse = data.combatUse ?? 0;
    obj.targetType = data.targetType ?? 0;
    obj.useRadius = data.useRadius ?? 0.6;
    obj.stackSize = data.stackSize || 0;
    obj.maxStackSize = data.maxStackSize || 0;
    obj.objectDescFlags = data.objectDescFlags || 0;
    obj.petOwner = data.petOwner ?? 0;
    obj.uiHidden = ((data.objectDescFlags || 0) & ObjectDescriptionFlag.UiHidden) !== 0;
    obj.itemsCapacity = data.itemsCapacity ?? 0;
    obj.containersCapacity = data.containersCapacity ?? 0;
    obj.wieldedLocation = data.currentWieldedLocation || 0;
    obj.clothingPriority = data.clothingPriority;
    obj.ammoType = data.ammoType;
    obj.value = data.value || 0;
    obj.burden = data.burden || 0;
    obj.iconOverlayId = data.iconOverlayId || 0;
    obj.iconUnderlayId = data.iconUnderlayId || 0;
    obj.monarchGuid = data.monarchGuid || 0;
    obj.hookType = data.hookType || 0;
    obj.hookItemTypes = data.hookItemTypes || 0;
    obj.houseOwnerId = data.houseOwnerId || 0;
    obj.cooldownId = data.cooldownId || 0;
    obj.cooldownDuration = data.cooldownDuration || 0;
    obj.structure = data.structure || 0;
    obj.maxStructure = data.maxStructure || 0;
  }

  /**
   * DECOMP.pickup-event-ignored — `SmartBox::DoPickupEvent` @ 00452240: when
   * the event's position timestamp is newer than the object's
   * (`update_times[POSITION_TS]`), `CPhysicsObj::unset_parent` @ 00513470
   * then `leave_world` @ 005155a0 — off its holder, out of every cell (not
   * drawn, not updated, off the destruction queue). The record is kept: a
   * later position (CreateObject / UpdatePosition) puts it back in the
   * world, a ParentEvent onto a new holder. `SmartBox::HandlePickupEvent`
   * @ 00453530 only runs it for the object's current instance. Returns
   * whether it was applied; the owner detaches the held mesh copy. A guid
   * that is not a tracked world object (the local player's own items — the
   * nocked arrow, a thrown weapon) has nothing to gate on: true, as
   * parentEvent answers, so its held copy comes off the hand
   * (BUG.own-ammo-pickup-event-ignored — ACE Player_Missile.cs:335 on
   * launch, Creature_Combat.cs HideAmmo on leaving missile mode).
   */
  pickupEvent(guid: number, positionSequence: number, instanceSequence?: number): boolean {
    const obj = this.objects.get(guid);
    if (!obj) return true;
    if (instanceSequence !== undefined && obj.instanceSequence !== undefined
      && instanceSequence !== obj.instanceSequence) return false;
    if (obj.positionSequence !== undefined && !isSequenceNewer(positionSequence, obj.positionSequence)) return false;
    obj.positionSequence = positionSequence;
    // unset_parent
    obj.wielderId = 0;
    obj.parentLocation = 0;
    this.leaveWorld(obj);
    return true;
  }

  /**
   * `SmartBox::DoParentEvent` @ 00452290 on the ServerObject record: gated
   * on the item's position timestamp like DoPickupEvent, then set_parent —
   * the object is held (drawn as its holder's attachment, not in a cell of
   * its own). Returns false for a stale event; true when applied or the
   * guid is not a tracked world object (the local player's own items).
   */
  parentEvent(guid: number, holderGuid: number, parentLocation: number, positionSequence: number): boolean {
    const obj = this.objects.get(guid);
    if (!obj) return true;
    if (obj.positionSequence !== undefined && !isSequenceNewer(positionSequence, obj.positionSequence)) return false;
    obj.positionSequence = positionSequence;
    obj.wielderId = holderGuid;
    obj.parentLocation = parentLocation;
    this.leaveWorld(obj);
    return true;
  }

  /** `CPhysicsObj::leave_world` @ 005155a0 on the record (see ServerObject.outOfWorld). */
  private leaveWorld(obj: ServerObject): void {
    obj.objCellId = 0;
    obj.lostCell = false;
    this.destructionQueue.delete(obj.guid);
    // leave_world: the MoveTo ends, the physics object has no cell — the
    // next position places it afresh (applyPositionUpdate).
    obj.moveTo?.cancelMoveTo();
    if (obj.physics) {
      obj.physics.interp.stopInterpolating();
      obj.physics.sticky.unStick();
      obj.physics.inCell = false;
      obj.physics.setVelocity({ x: 0, y: 0, z: 0 });
    }
    if (obj.outOfWorld) return;
    obj.outOfWorld = true;
    this.applyVisibility(obj);
    if (this.onObjectLeftWorld) {
      try { this.onObjectLeftWorld(obj); } catch { /* never block the event */ }
    }
  }

  /** Delete a server object and remove from scene. `reason` names the caller for the removal journal. */
  deleteObject(guid: number, reason: ObjectRemovalReason = 'server'): void {
    // The server deleted it: a copy ObjectMaint let go is not to come back.
    if (reason === 'server') this.maintReleased.delete(guid >>> 0);
    const obj = this.objects.get(guid);
    if (!obj) return;

    // Projectiles are removed instantly (no death fade)
    if (this.projectiles.has(guid)) {
      this.projectiles.delete(guid);
      this.forceDelete(guid, reason);
      return;
    }

    // BUG.double-corpse — a dead creature leaves at once. ACE's die chain
    // (Creature_Death.cs:131-135) runs CreateCorpse + Destroy in one action
    // after the death animation, and retail's SmartBox::HandleDeleteObject
    // @ 00451ea0 hands the delete straight to CObjectMaint::DeleteObject —
    // no linger. The corpse object is the body from here on; holding the
    // creature's mesh drew two bodies for 4.5 s.
    this.animatedObjects.delete(guid);
    this.serverActionStamps.delete(guid);
    this.pendingMotion.delete(guid);
    this.dyingObjects.delete(guid);
    this.destructionQueue.delete(guid);

    if (obj.mesh) {
      if (this.onObjectDeleted) {
        try { this.onObjectDeleted(obj); } catch { /* never let the callback block object teardown */ }
      }
      this.scene.remove(obj.mesh);
      this.disposeMesh(obj);
      obj.mesh = null;
    }

    this.objects.delete(guid);
    this.removals.push({ guid, reason });
    this.unparentChildren(guid);
  }

  /**
   * CObjectMaint::DeleteObject @ 00508460 → CPhysicsObj::unparent_children:
   * the objects a deleted holder held lose their parent (unset_parent) and
   * stay out of the world, kept for a later CreateObject / ParentEvent.
   * Their held copies went with the holder's mesh.
   */
  private unparentChildren(holderGuid: number): void {
    for (const child of this.objects.values()) {
      if (child.wielderId !== holderGuid) continue;
      child.wielderId = 0;
      child.parentLocation = 0;
    }
  }

  /** Force-delete an object (bypass fade). */
  private forceDelete(guid: number, reason: ObjectRemovalReason): void {
    this.dyingObjects.delete(guid);
    this.projectiles.delete(guid);
    this.destructionQueue.delete(guid);
    const obj = this.objects.get(guid);
    if (!obj) return;

    this.animatedObjects.delete(guid);
    this.serverActionStamps.delete(guid);
    this.pendingMotion.delete(guid);
    if (obj.mesh) {
      if (this.onObjectDeleted) {
        try { this.onObjectDeleted(obj); } catch { /* never let the callback block object teardown */ }
      }
      this.scene.remove(obj.mesh);
      this.disposeMesh(obj);
      obj.mesh = null;
    }
    this.objects.delete(guid);
    this.removals.push({ guid, reason });
    this.unparentChildren(guid);
  }

  /**
   * UpdatePosition (0xF748) — `SmartBox::HandleReceivedPosition @ 00453fd0`
   * (DECOMP.position-interpolation): stale / out-of-order positions are
   * dropped on the object's POSITION_TS and TELEPORT_TS, then
   * `CPhysicsObj::MoveOrTeleport @ 00516330` snaps a teleport, interpolates
   * a grounded position (PositionPack IsGrounded 0x4) within
   * MAX_PHYSICS_DISTANCE of us, and ignores an airborne one — the object is
   * flying on its own velocity (world/RemotePhysics.ts).
   */
  updatePosition(data: UpdatePositionData): void {
    this.applyPositionUpdate(data.guid, data.landblock >>> 0, data.x, data.y, data.z, data.rw, data.rx, data.ry, data.rz, {
      contact: (data.flags & POSITION_FLAG_IS_GROUNDED) !== 0,
      positionTs: data.positionSequence,
      teleportTs: data.teleportSequence,
      placement: data.placementId,
    });
  }

  /**
   * AutonomousPosition (GameMessageAutonomousPosition.cs) never carries a
   * landblock on the wire -- it's a peer's continuous-motion update within
   * its already-established landblock, unlike UpdatePosition's PositionPack.
   * Reconstruct the grid coordinates from the object's last known world
   * position instead.
   */
  updateAutonomousPosition(data: AutonomousPositionData): void {
    const obj = this.objects.get(data.guid);
    if (!obj) return;
    const lbX = Math.floor(obj.worldX / 192) & 0xFF;
    const lbY = Math.floor(obj.worldZ / 192) & 0xFF;
    const cell = (((lbX << 24) | (lbY << 16) | (obj.cellId & 0xFFFF)) >>> 0);
    this.applyPositionUpdate(data.guid, cell, data.x, data.y, data.z, data.rw, data.rx, data.ry, data.rz, {
      contact: data.contact !== 0,
      teleportTs: data.teleportSequence,
    });
  }

  private applyPositionUpdate(
    guid: number, cell: number,
    x: number, y: number, z: number, rw: number, rx: number, ry: number, rz: number,
    stamps: { contact: boolean; positionTs?: number; teleportTs?: number; placement?: number },
  ): void {
    const obj = this.objects.get(guid);
    if (!obj) return;
    const lbX = landblockX(cell);
    const lbY = landblockY(cell);
    const cellId = cell & 0xFFFF;
    const newX = lbX * 192 + x;
    const newY = z; // AC Z → Three.js Y
    const newZ = lbY * 192 + y; // AC Y → Three.js Z

    // BUG.spell-projectile-physics — a flying missile takes a server
    // position as-is (no lerp that would fight the local flight) and keeps
    // simulating from it.
    const missile = this.projectiles.get(guid);
    if (missile) {
      obj.objCellId = cell;
      missile.pos = { x: newX, y: newZ, z: newY };
      missile.orient = { w: rw, x: rx, y: ry, z: rz };
      obj.cellId = cellId;
      // The object's cell picks its draw pass and whether its lights pool.
      this.syncCellLighting(obj);
      this.syncMissileMesh(obj, missile);
      return;
    }

    const body = obj.physics;
    if (!body) return;
    // DECOMP.pickup-event-ignored — a position for an object that left the
    // world puts it back (HandleReceivedPosition → MoveOrTeleport →
    // enter_world): placed at the position, not slid there.
    const reentering = !!obj.outOfWorld;
    if (reentering) body.inCell = false;
    const me = this.localPlayerPosition?.();
    // CPhysicsObj::player_distance — the 3-D offset from the player (update_object @ 00515d10).
    const playerDistance = me ? Math.hypot(me.x - newX, me.z - newZ, (me.y ?? z) - z) : 0;
    const r = body.receivePosition({
      cell, pos: { x: newX, y: newZ, z }, orient: { w: rw, x: rx, y: ry, z: rz },
      contact: stamps.contact, positionTs: stamps.positionTs, teleportTs: stamps.teleportTs,
    }, playerDistance);
    if (r === 'stale') return;
    // Where the server says it is, for the agent's observations (an airborne one the body ignores included).
    obj.serverPlace = { cell: cell >>> 0, worldX: newX, worldY: newY, worldZ: newZ };
    obj.serverPlaceAt = performance.now();
    obj.lastServerPosition = {
      position: { landblock: cell >>> 0, x, y, z, rw, rx, ry, rz },
      positionTs: stamps.positionTs ?? obj.lastServerPosition?.positionTs,
      teleportTs: stamps.teleportTs ?? obj.lastServerPosition?.teleportTs,
    };
    if (r === 'ignored') return;
    // SmartBox::HandleReceivedPosition @ 00453fd0: an object without
    // animations takes the position's placement (SetPlacementFrame; 0 when
    // the PositionPack had none).
    if (stamps.placement !== undefined && !this.animatedObjects.has(guid)) this.setPlacementFrame(obj, stamps.placement);
    // BUG.teleport-leaves-stale-objects — the cell the object now stands in
    // (updateObjectMaint moves it out of / back into the world by it).
    obj.objCellId = cell;
    obj.cellId = cellId;
    this.syncCellLighting(obj);
    if (reentering) obj.outOfWorld = false;
    if (r === 'teleport' || r === 'snap') this.syncBodyToMesh(obj);
    if (reentering) {
      if (obj.mesh) this.applyVisibility(obj);
      if (this.onObjectReenteredWorld) {
        try { this.onObjectReenteredWorld(obj); } catch { /* never block the update */ }
      }
    }
  }

  /** CPhysicsObj::SetPlacementFrame: re-pose a built object's parts (rebuilds keep obj.placement). */
  setPlacementFrame(obj: ServerObject, placement: number): void {
    if ((obj.placement ?? PLACEMENT_RESTING) === placement) return;
    obj.placement = placement;
    if (obj.mesh && obj.setupId) this.setupModelRenderer.posePlacement(obj.mesh, obj.setupId, placement);
  }

  /**
   * Update object appearance from ObjDescEvent.
   *
   * BUG.objdescevent-sequence-not-enforced — `visualDescSequence` (ushort,
   * ACE SequenceManager.cs ObjectVisualDesc) gates the update the same way
   * setPhysicsState's `stateSequence` guard does: a stale/out-of-order
   * appearance change (e.g. an unwield undoing a wield's texture swap
   * arriving after the wield) is silently dropped instead of clobbering the
   * newer appearance.
   */
  updateAppearance(data: ObjDescEventData): void {
    const obj = this.objects.get(data.guid);
    if (!obj) return;

    if (obj.lastVisualDescSeq !== -1 && !isSequenceNewer(data.visualDescSequence, obj.lastVisualDescSeq)) {
      return;
    }
    obj.lastVisualDescSeq = data.visualDescSequence;

    obj.basePalette = data.basePalette;
    obj.subPalettes = data.subPalettes;
    obj.textureChanges = data.textureChanges;
    obj.animPartChanges = data.animPartChanges;

    // Rebuild the mesh with new appearance
    if (obj.setupId && obj.mesh) {
      const oldMesh = obj.mesh;
      const oldPos = oldMesh.position.clone();
      const oldQuat = oldMesh.quaternion.clone();
      const oldScale = oldMesh.scale.x || 1.0;
      const oldTranslucency = (oldMesh.userData[TRANSLUCENCY_KEY] as number | undefined) ?? 0;
      // DECOMP.objdesc-drops-held-item — held objects are the CPhysicsObj's
      // CHILDLIST, not its parts: DoObjDescChanges swaps parts and leaves
      // the children, which follow their holding part every frame
      // (CPhysicsObj::UpdateChild @ 00512d50). Lift them off the old parts
      // before those are disposed; they go back on the rebuilt ones below.
      const held = takeHeldAttachments(oldMesh);
      const oldTranslucencyOriginal = (oldMesh.userData[TRANSLUCENCY_ORIGINAL_KEY] as number | undefined) ?? 0;
      this.scene.remove(oldMesh);
      this.disposeMesh(obj); // the lighting copies die with the old parts

      try {
        const createData: CreateObjectData = {
          guid: obj.guid, name: obj.name, pluralName: obj.pluralName, weenieClassId: obj.weenieClassId,
          itemType: obj.itemType, position: obj.position, setupId: obj.setupId, motionTableId: obj.motionTableId,
          iconId: obj.iconId, physicsState: obj.physicsState, objectDescFlags: obj.objectDescFlags,
          itemsCapacity: obj.itemsCapacity ?? 0,
          containersCapacity: obj.containersCapacity ?? 0,
          radarColor: obj.radarColor, radarBehavior: obj.radarBehavior,
          basePalette: data.basePalette, subPalettes: data.subPalettes,
          textureChanges: data.textureChanges, animPartChanges: data.animPartChanges,
          usable: obj.usable,
          useRadius: obj.useRadius ?? 0.6,
          containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0,
          // These two are structurally required by CreateObjectData but
          // inert here — buildMesh() never reads .value/.burden (it only
          // consumes setupId/animPartChanges/textureChanges/palettes).
          // obj.value/obj.burden themselves live on the persisted
          // ServerObject and are never touched by updateAppearance(), so
          // they survive appearance-triggered mesh rebuilds regardless of
          // what's passed here.
          stackSize: 0, maxStackSize: 0, value: obj.value ?? 0, burden: obj.burden ?? 0,
          uiEffects: 0,
          velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: obj.soundTableId,
          // FAITHFUL.374 — preserve scale across appearance-update rebuilds.
          objScale: oldScale,
          // FAITHFUL.375 — translucency is re-applied after the build below
          // (buildMesh() doesn't consume this field).
          translucency: oldTranslucency,
          // FAITHFUL.376 — preserve defaultScript fields across rebuilds.
          defaultScript: obj.defaultScriptOverride ?? 0,
          defaultScriptIntensity: obj.defaultScriptIntensity ?? 0,
          // BUG.icon-overlay-underlay-dropped — structurally required;
          // buildMesh() doesn't consume these either, same as value/burden
          // above. Preserved from obj so a future consumer of buildMesh()
          // wouldn't silently lose them on an appearance-only rebuild.
          iconOverlayId: obj.iconOverlayId ?? 0,
          iconUnderlayId: obj.iconUnderlayId ?? 0,
          // BUG.cooldown-id-duration-discarded — same preservation rationale.
          cooldownId: obj.cooldownId ?? 0,
          cooldownDuration: obj.cooldownDuration ?? 0,
          // BUG.structure-maxstructure-discarded — same preservation rationale.
          structure: obj.structure ?? 0,
          maxStructure: obj.maxStructure ?? 0,
          // BUG.weenie-targettype-discarded — same preservation rationale.
          targetType: obj.targetType,
          // STREAM.rebuild-resets-placement — the new parts take the held
          // placement frame (a Resting ground item stays Resting).
          placement: obj.placement,
        };
        obj.mesh = this.buildMesh(createData);
        this.syncCellLighting(obj);
        if (obj.mesh) {
          obj.mesh.position.copy(oldPos);
          obj.mesh.quaternion.copy(oldQuat);
          // FAITHFUL.374 — the object's scale survives the rebuild (buildMesh
          // does not read objScale; it was dropped here before).
          obj.mesh.scale.setScalar(oldScale);
          obj.mesh.name = `server_${obj.guid.toString(16)}_${obj.name}`;
          obj.mesh.userData[SOUND_TABLE_KEY] = obj.soundTableId || 0;
          obj.mesh.userData[PHYSICS_STATE_KEY] = obj.physicsState;
          obj.mesh.userData.setupId = obj.setupId;
          const orphans = restoreHeldAttachments(obj.mesh, held);
          held.length = 0;
          held.push(...orphans);
          // BUG.server-object-setup-lights — the physics object keeps its
          // LIGHTLIST across an ObjDesc change; the new parts carry it.
          this.syncLights(obj);
          // BUG.physicsstate-nodraw-ignored — a rebuilt mesh defaults
          // visible; re-apply the current hide bits + cell culling so an
          // appearance update can't reveal a Hidden/NoDraw object.
          this.applyVisibility(obj);
          // FAITHFUL.375 — the object's current translucency survives the
          // rebuild (retail DoObjDescChanges re-applies it to the new parts).
          obj.mesh.userData[TRANSLUCENCY_ORIGINAL_KEY] = oldTranslucencyOriginal;
          if (oldTranslucency !== 0) setObjectTranslucency(obj.mesh, oldTranslucency);
          this.scene.add(obj.mesh);
          // BUG.remote-player-anim-lost-on-objdesc — keep animating: the
          // AnimatedEntity moves to the new group (the local player's is
          // re-collected in place by main.ts, not rebuilt here).
          const animated = this.animatedObjects.get(obj.guid);
          if (animated && obj.guid !== this.localPlayerGuid && obj.mesh instanceof THREE.Group) animated.rebind(obj.mesh);
        }
      } catch (err) {
        obj.mesh = null;
        // REND.appearance-rebuild-orphans-emitters — the object is now
        // invisible; say so (console only — never chat).
        ServerObjectManager.rebuildWarn.warn(
          `appearance rebuild failed for 0x${obj.guid.toString(16)} (setup 0x${obj.setupId.toString(16)}) — object left without a mesh`, err);
      }
      // A failed rebuild has no part to hold them: they go with the old parts.
      for (const h of held) { releaseObjectLightsIn(h.child); disposeObjectTree(h.child); }
      // REND.appearance-rebuild-orphans-emitters — scripts/emitters anchored
      // on the old mesh must not keep running on the orphan: hand both
      // meshes to the owner, which moves them to the new mesh (retail keeps
      // the CPhysicsObj's script/particle managers across an ObjDesc change,
      // only the parts are swapped) or stops them if the rebuild failed.
      if (this.onMeshReplaced) {
        try { this.onMeshReplaced(obj, oldMesh); } catch { /* never let the callback block the rebuild */ }
      }
    }
  }

  /**
   * RELEASE.dat-streaming — rebuild an object's mesh because DAT files its
   * first build missed are resident now (docs/dat-streaming.md §3.1 "rebuild
   * on arrival"). A built mesh is re-done through the ObjDesc rebuild path
   * with its current appearance (parts swapped, held items, lights,
   * translucency and animation kept).
   *
   * STREAM.meshless-rebuild-drops-held-items — an object whose build produced
   * no mesh at all (its Setup was not resident) gets its parts built for the
   * object already held: retail's CPhysicsObj persists and only its part
   * array changes (SetSetupID), so the record keeps its held items
   * (wielderId / parentLocation), its latest ObjDesc, SetState, position and
   * motion. Re-creating it from the CreateObject (deleteObject →
   * unparent_children) dropped every held item and rolled the object back to
   * its create. `createData` supplies the create-only fields the record does
   * not keep (translucency, velocity). Returns 'built' when the object got
   * its first mesh (the owner re-attaches its held items' copies and runs
   * the creation hooks), 'rebuilt' for a redone mesh, else null.
   *
   * STREAM.initial-motion-not-retried — a running sequence whose current
   * state's animation missed (MotionManager.retryMissedAnimation) plays it.
   *
   * STREAM.cold-creature-never-animates — either way, an object whose
   * sequence could not start (its motion table's cycle animation or the
   * Setup's DefaultAnimation missed) is started now, with the motion state
   * the server sent meanwhile.
   */
  rebuildMesh(guid: number, createData?: CreateObjectData): 'built' | 'rebuilt' | null {
    const obj = this.objects.get(guid);
    if (!obj || !obj.setupId) return null;
    // createObject flies a Missile locally and gives every other object a physics record.
    const isMissile = !obj.physics;
    if (obj.mesh) {
      const seq = obj.lastVisualDescSeq;
      obj.lastVisualDescSeq = -1;
      this.updateAppearance({
        guid, basePalette: obj.basePalette, subPalettes: obj.subPalettes, textureChanges: obj.textureChanges,
        animPartChanges: obj.animPartChanges, instanceSequence: obj.instanceSequence ?? 0, visualDescSequence: seq,
      });
      obj.lastVisualDescSeq = seq;
      if (!obj.mesh) return null;
      // STREAM.initial-motion-not-retried — a state whose cycle animation
      // missed is drawn now (the old cycle had kept looping).
      this.retryMissedAnimation(guid);
      this.initStreamedAnimation(obj, isMissile);
      return 'rebuilt';
    }
    if (!createData || createData.guid !== guid) return null;
    this.buildObjectMesh(obj, {
      ...createData,
      name: obj.name, setupId: obj.setupId, physicsState: obj.physicsState,
      position: obj.position ?? createData.position,
      basePalette: obj.basePalette, subPalettes: obj.subPalettes,
      textureChanges: obj.textureChanges, animPartChanges: obj.animPartChanges,
      motionTableId: obj.motionTableId, soundTableId: obj.soundTableId, placement: obj.placement,
      translucency: obj.translucency ?? createData.translucency,
      objScale: obj.physics?.scale ?? createData.objScale,
    }, isMissile);
    if (!obj.mesh) return null;
    this.applyPendingMotion(obj);
    if (this.onObjectCreated) {
      try { this.onObjectCreated(obj); } catch { /* never let the callback block the rebuild */ }
    }
    return 'built';
  }

  /**
   * STREAM.initial-motion-not-retried — once the streamed files a motion
   * missed are resident (a MovementEvent into a style whose animations were
   * not prefetched, an emote, a rebuild), draw the object's committed state
   * (MotionManager.retryMissedAnimation). Our own character too: the retry
   * replays the state CharacterAnimController committed, it chooses nothing.
   */
  retryMissedAnimation(guid: number): boolean {
    return this.animatedObjects.get(guid)?.motionManager.retryMissedAnimation() ?? false;
  }

  /** retryMissedAnimation for every animated object (main.ts runs it when missed DAT files land). Returns how many caught up. */
  retryMissedAnimations(): number {
    let n = 0;
    for (const animated of this.animatedObjects.values()) if (animated.motionManager.retryMissedAnimation()) n++;
    return n;
  }

  /**
   * STREAM.cold-creature-never-animates — CPartArray::InitDefaults @ 00518980
   * and the motion table's default state, for an object whose first attempt
   * (createObject) found the animation not yet resident. A sequence that is
   * already running is left alone; a motion table that comes up replaces a
   * DefaultAnimation loop started in its place (as createObject chooses).
   */
  private initStreamedAnimation(obj: ServerObject, isMissile: boolean): void {
    if (this.animatedObjects.has(obj.guid)) return;
    if (!isMissile) this.tryInitAnimation(obj);
    if (this.animatedObjects.has(obj.guid)) {
      this.defaultAnims.delete(obj.guid);
      this.applyPendingMotion(obj);
    } else if (!this.defaultAnims.has(obj.guid)) {
      this.tryInitDefaultAnimation(obj);
    }
  }

  /**
   * The motion state held for an object while its sequence waited on streamed
   * files (pendingMotion), applied the way createObject applies a create's
   * state: the object is already where the state puts it — its link
   * animations go (CPhysicsObj::enter_world), unless it is held.
   */
  private applyPendingMotion(obj: ServerObject): void {
    const parsed = this.pendingMotion.get(obj.guid);
    const animated = this.animatedObjects.get(obj.guid);
    if (!parsed || !animated) return;
    this.pendingMotion.delete(obj.guid);
    this.applyParsedMotion(obj.guid, animated, parsed);
    if (!obj.wielderId) animated.motionManager.removeAllLinkAnimations();
  }

  /** Failed appearance rebuilds (rate-limited console channel). */
  static readonly rebuildWarn = new RateLimitedWarn('ServerObjectManager');

  /**
   * REND.shared-cached-material-disposed-faded — free an object's mesh with
   * the material-ownership rule: geometry + the object's own material copies
   * go, the MaterialFactory-cached (shared) materials stay for every other
   * object drawing the same surface. Active selection-lighting copies are
   * handed back first so the part's owned originals are the ones freed.
   */
  private disposeMesh(obj: ServerObject): void {
    if (!obj.mesh) return;
    // BUG.server-object-setup-lights — CPartArray::DestroyLights with the object.
    releaseObjectLightsIn(obj.mesh);
    if (obj.lightingCopies) restoreObjectLighting(obj.lightingCopies);
    obj.lightingCopies = undefined;
    disposeObjectTree(obj.mesh);
  }

  /**
   * Set physics state on object.
   *
   * BUG.setstate-sequence-guard-not-enforced — `stateSequence` (ushort,
   * FAITHFUL.338) gates the update the same way the retail client's
   * SmartBox::DoSetState (@0x004520d0) does: a stale/out-of-order SetState
   * (e.g. a delayed "Dead" flag arriving just after a fresh post-respawn
   * "alive" one) is silently dropped instead of clobbering the newer state.
   * Omit `stateSequence` (or pass it as unset) to always apply, matching
   * pre-fix behavior for call sites that don't have a sequence to offer.
   */
  setPhysicsState(guid: number, state: number, stateSequence?: number): void {
    const obj = this.objects.get(guid);
    if (!obj) return;

    if (stateSequence !== undefined && obj.lastStateSequence !== -1) {
      if (!isSequenceNewer(stateSequence, obj.lastStateSequence)) return;
    }
    if (stateSequence !== undefined) obj.lastStateSequence = stateSequence;

    const hiddenScript = hiddenEdgeScript(obj.physicsState, state);
    obj.physicsState = state;
    if (obj.mesh) obj.mesh.userData[PHYSICS_STATE_KEY] = state;
    // CPhysicsObj::set_state — the server's state replaces the missile's
    // local one (including any Missile bits it dropped on a local contact).
    const missile = this.projectiles.get(guid);
    if (missile) missile.state = state;
    // CPhysicsObj::set_state → calc_acceleration (Gravity may have flipped).
    obj.physics?.setState(state);

    // Handle visibility — Hidden and NoDraw both gate server-driven hide
    if (obj.mesh) {
      this.applyVisibility(obj);
    }
    // BUG.server-object-setup-lights — CPhysicsObj::set_state @ 00514dd0:
    // a LightingOn (0x800) edge builds / destroys the Setup lights.
    this.syncLights(obj);
    // …and a Hidden (0x4000) edge runs set_hidden's Hidden / UnHide script.
    if (hiddenScript !== null) {
      this.onHiddenStateScript?.(guid, hiddenScript);
      // CPhysicsObj::set_hidden @ 00514c60 ends both branches with
      // CPartArray::RemoveLinkAnimations: what a teleporting object was
      // still playing (a lifestone recall frozen while this client sat in
      // portal space) is dropped, not resumed on arrival
      // (BUG.recall-replays-on-arrival).
      this.animatedObjects.get(guid)?.motionManager.removeAllLinkAnimations();
    }
  }

  /**
   * The mesh is drawn unless its PhysicsState has Hidden / NoDraw or its
   * cell is culled. A Hidden / NoDraw object is still in the world, so it is
   * flagged not-drawn and keeps its Setup lights
   * (BUG.hidden-object-lights-leave-pool — `set_hidden` @ 00514c60 leaves
   * the LIGHTOBJs in the cell); a cell-culled one is not.
   */
  private applyVisibility(obj: ServerObject): void {
    if (!obj.mesh) return;
    const hidden = (obj.physicsState & PHYSICS_HIDE_MASK) !== 0;
    // A lost-cell object (BUG.teleport-leaves-stale-objects) is out of every
    // cell: not drawn and its lights leave the lists, like a culled one.
    // An object that left the world (PickupEvent / ParentEvent) is in no
    // cell either (DECOMP.pickup-event-ignored).
    const culled = !!obj._culledByCell || !!obj.lostCell || !!obj.outOfWorld;
    obj.mesh.visible = !hidden && !culled;
    setObjectNoDraw(obj.mesh, hidden && !culled);
  }

  /**
   * BUG.server-object-setup-lights — the object's Setup lights exist exactly
   * while its PhysicsState has LightingOn (CPartArray::InitLights /
   * DestroyLights, see effects/ObjectLights). Idempotent.
   */
  private syncLights(obj: ServerObject): void {
    if (!obj.mesh || !obj.setupId) return;
    let lights;
    try { lights = this.setupModelRenderer.loadSetupModel(obj.setupId)?.lights; } catch { lights = undefined; }
    syncObjectLights(obj.mesh, lights, obj.physicsState);
  }

  /**
   * CORE.17.q.b — `PView::DrawCells` @ 005a4840 draws the objects in an env
   * cell (`DrawObjCell` @ 005a1a40) inside its `useSunlightSet(0)` span,
   * from inside the cell (`PView::DrawInside`) and through a building
   * portal from the street (`PView::DrawPortal`) alike; an outdoor object
   * is drawn by the landscape pass under `useSunlightSet(1)` (the sun as the
   * only active light). The object's own cell picks the light set.
   */
  syncCellLighting(obj: ServerObject, force = false): void {
    if (!obj.mesh) return;
    const indoor = isInteriorCellIndex(obj.cellId);
    setCellLighting(obj.mesh, indoor, force);
    // CORE.17.h.g.c.c.c — RenderDeviceD3D::UpdateObjCell: an object in a
    // LAND cell degrades by its cell's 2-D viewer distance beyond 50 m.
    obj.mesh.userData[DegradeLod.LAND_CELL_KEY] = !indoor;
  }

  /**
   * BUG.setlight-hook-emissive-only — `SetLightHook::Execute` @ 00526fd0 →
   * `CPhysicsObj::set_lights` @ 0050fcf0: flip PhysicsState LightingOn
   * (0x800) and build (`CPartArray::InitLights`) or destroy
   * (`DestroyLights`) the object's Setup lights. Local only — the server's
   * next SetState replaces the state as usual. Returns false for an unknown
   * object.
   */
  setLights(guid: number, on: boolean): boolean {
    const obj = this.objects.get(guid);
    if (!obj) return false;
    obj.physicsState = on
      ? (obj.physicsState | PhysicsState.LightingOn) >>> 0
      : (obj.physicsState & ~PhysicsState.LightingOn) >>> 0;
    if (obj.mesh) obj.mesh.userData[PHYSICS_STATE_KEY] = obj.physicsState;
    // A missile's own state keeps its locally dropped bits; flip only this one.
    const missile = this.projectiles.get(guid);
    if (missile) {
      missile.state = on
        ? (missile.state | PhysicsState.LightingOn) >>> 0
        : (missile.state & ~PhysicsState.LightingOn) >>> 0;
    }
    this.syncLights(obj);
    return true;
  }

  /**
   * BUG.nodraw-hook-overwritten — `NoDrawHook::Execute` @ 00526be0 →
   * `CPhysicsObj::set_nodraw` @ 0050fca0: set / clear the PhysicsState NoDraw
   * bit (0x20) and the part array's no-draw. The bit is what applyVisibility
   * reads every frame, so writing the STATE (not just mesh.visible) keeps a
   * script's NoDraw (e.g. 0x33000109 on a hit bolt) from being undone the
   * next frame. Local only — the server's next SetState replaces it.
   */
  setNoDraw(guid: number, on: boolean): boolean {
    const obj = this.objects.get(guid);
    if (!obj) return false;
    const flip = (s: number): number => (on ? (s | PhysicsState.NoDraw) : (s & ~PhysicsState.NoDraw)) >>> 0;
    obj.physicsState = flip(obj.physicsState);
    if (obj.mesh) obj.mesh.userData[PHYSICS_STATE_KEY] = obj.physicsState;
    const missile = this.projectiles.get(guid);
    if (missile) missile.state = flip(missile.state);
    this.applyVisibility(obj);
    return true;
  }

  /** The server object whose root mesh is `mesh` (a script / hook anchor), if any. */
  objectForMesh(mesh: THREE.Object3D): ServerObject | undefined {
    for (const obj of this.objects.values()) if (obj.mesh === mesh) return obj;
    return undefined;
  }

  /**
   * The server object a PhysicsScript / anim-hook anchor stands for: an
   * object's own mesh, an animated object's group (the local player's is
   * not its `mesh`), or a wielded item's held copy (`userData.wieldedGuid`,
   * the child on its wielder's part — DefaultScriptPart's target).
   */
  objectForAnchor(anchor: THREE.Object3D): ServerObject | undefined {
    const byMesh = this.objectForMesh(anchor);
    if (byMesh) return byMesh;
    for (const [guid, animated] of this.animatedObjects) {
      if (animated.group === anchor) return this.objects.get(guid);
    }
    const wielded = anchor.userData.wieldedGuid as number | undefined;
    return wielded !== undefined ? this.objects.get(wielded) : undefined;
  }

  /** guid → the time (seconds) the lost object is destroyed (CObjectMaint's destruction queue). */
  private destructionQueue = new Map<number, number>();

  /**
   * BUG.teleport-leaves-stale-objects — CPhysicsObj::leave_visibility: the
   * object's cell was released. The owner freezes everything anchored on it
   * (scripts, emitters, hook sounds — update_object stops running).
   */
  onObjectLeftWorld: ((obj: ServerObject) => void) | null = null;
  /** …and CPhysicsObj::reenter_visibility: its cell is loaded again; it carries on. */
  onObjectReenteredWorld: ((obj: ServerObject) => void) | null = null;
  /**
   * One line per maintenance pass that changed something: the objects that
   * left the world (guid + cell) and those destroyed. A diagnostic for
   * BUG.ac1999-world-objects-missing-after-login (static objects gone a
   * minute after a 1999 login, not reproduced on demand): the owner logs it
   * with the viewer's state, so the next occurrence names its cause.
   */
  onObjectMaintReport: ((report: { left: Array<{ guid: number; cell: number }>; destroyed: number[] }) => void) | null = null;
  /** A pass that removed BULK_REMOVAL_REPORT or more objects, each with its reason (flushRemovalJournal). */
  onBulkRemoval: ((removed: Array<{ guid: number; reason: ObjectRemovalReason }>) => void) | null = null;
  /** Removals since the last maintenance pass (flushRemovalJournal). */
  private removals: Array<{ guid: number; reason: ObjectRemovalReason }> = [];

  /** Objects currently out of the world, waiting in the destruction queue (probes / tests). */
  get lostObjectCount(): number {
    return this.destructionQueue.size;
  }

  /**
   * BUG.teleport-leaves-stale-objects — CObjectMaint's visibility upkeep
   * (world/ObjectMaint.ts): every placed object whose cell `isLoaded`
   * rejects leaves the world and is queued for destruction
   * NONVISIBLE_OBJECT_DESTRUCTION_TIME (25 s) out; one whose cell is loaded
   * again comes back; an expired entry is deleted outright
   * (CObjectMaint::UseTime @ 005089b0 → DeleteObject @ 00508460). A wielded
   * item follows its wielder (prepare_to_leave_visibility queues the
   * children with the parent). The local player and carried / contained
   * items (no cell) are never queued. `nowSec` is any monotonic clock.
   *
   * `viewerCell` (the viewer's own cell, given in a dungeon): an expired
   * object is deleted only once the viewer has changed cell since it
   * expired. ACE expires its copy of the queue only then
   * (PhysicsObj.handle_visible_cells → ObjMaint.DestroyObjects, run from
   * enter_cell_server on the player's cell change), and until it does it
   * still counts the object as known: one that walks back into view is
   * never re-sent (handle_visible_obj: prevKnown, no CreateObject), so a
   * client that had already deleted it would be hit by an unseen monster.
   * Held this way the object stays hidden (lostCell) as retail's would, and
   * either side forgets it at the same moment.
   */
  private maintViewer: { cell: number; changedAt: number } | null = null;
  updateObjectMaint(isLoaded: (cellId: number) => boolean, nowSec: number, viewerCell?: number): void {
    if (viewerCell === undefined) this.maintViewer = null;
    else if (!this.maintViewer || this.maintViewer.cell !== (viewerCell >>> 0)) this.maintViewer = { cell: viewerCell >>> 0, changedAt: nowSec };
    const left: Array<{ guid: number; cell: number }> = [];
    const destroyed: number[] = [];
    const leave = (obj: ServerObject) => {
      if (obj.lostCell) return;
      obj.lostCell = true;
      left.push({ guid: obj.guid, cell: obj.objCellId ?? 0 });
      this.destructionQueue.set(obj.guid, nowSec + NONVISIBLE_OBJECT_DESTRUCTION_TIME);
      this.applyVisibility(obj);
      if (this.onObjectLeftWorld) {
        try { this.onObjectLeftWorld(obj); } catch { /* never block the upkeep */ }
      }
    };
    const reenter = (obj: ServerObject) => {
      if (!obj.lostCell) return;
      obj.lostCell = false;
      this.destructionQueue.delete(obj.guid);
      this.applyVisibility(obj);
      if (this.onObjectReenteredWorld) {
        try { this.onObjectReenteredWorld(obj); } catch { /* never block the upkeep */ }
      }
    };
    const placedLoaded = (obj: ServerObject): boolean | null => {
      if (obj.guid === this.playerGuid || obj.guid === this.localPlayerGuid) return null;
      const cell = obj.objCellId ?? 0;
      if (cell !== 0) return isLoaded(cell);
      return null;
    };
    for (const obj of this.objects.values()) {
      let loaded = placedLoaded(obj);
      if (loaded === null && obj.wielderId) {
        const wielder = this.objects.get(obj.wielderId);
        if (wielder) loaded = placedLoaded(wielder);
      }
      if (loaded === null) continue;
      if (loaded) reenter(obj);
      else leave(obj);
    }
    // CObjectMaint::UseTime — delete every object whose time ran out.
    for (const [guid, at] of [...this.destructionQueue]) {
      if (nowSec < at) continue;
      if (this.maintViewer && this.maintViewer.changedAt < at) continue;
      this.destructionQueue.delete(guid);
      const gone = this.objects.get(guid);
      if (gone?.lostCell) {
        this.keepReleasedRecord(gone);
        this.forceDelete(guid, 'maint');
        destroyed.push(guid);
      }
    }
    if ((left.length > 0 || destroyed.length > 0) && this.onObjectMaintReport) {
      try { this.onObjectMaintReport({ left, destroyed }); } catch { /* diagnostics never block the upkeep */ }
    }
    this.flushRemovalJournal();
  }

  /**
   * Objects ObjectMaint deleted (out of sight 25 s), each kept as the
   * CreateObject that re-makes it as last known (its latest position,
   * appearance and state). ACE forgets an object on its own schedule
   * (Physics/Common/ObjectMaint.cs DestroyObjects, run only from the
   * player's server-side cell change, with a clock the object's own cell
   * changes reset) and until then counts it as known: it never re-sends the
   * CreateObject (PhysicsObj.handle_visible_obj: prevKnown) and keeps
   * sending the object's movement, positions and states to every player in
   * its KnownPlayers. Whenever our release ran ahead of ACE's, every later
   * message for it named a guid we no longer held (retail queues such a blob
   * for a create that never comes, SmartBox::HandleVectorUpdate @ 00453480 →
   * CObjectMaint::QueueBlobForObject), so the object stayed invisible while
   * it moved beside us: Claude Bulwark for 8 minutes in Mountain Keep
   * 0x01D2010C (2026-10-17). The owner re-makes it from here on the first
   * such message ({@link takeReleasedRecord}); one the server never speaks
   * of again (a monster that died out of sight) stays gone.
   */
  private maintReleased = new Map<number, CreateObjectData>();
  /** Most released records kept (oldest dropped first). */
  static readonly MAINT_RELEASED_MAX = 1024;

  private keepReleasedRecord(obj: ServerObject): void {
    const d = obj.createData;
    if (!d || obj.guid === this.playerGuid || obj.guid === this.localPlayerGuid || this.projectiles.has(obj.guid)) return;
    const ts = [...(d.timestamps ?? [])];
    const last = obj.lastServerPosition;
    if (last?.positionTs !== undefined) ts[PhysicsTimestamp.Position] = last.positionTs;
    if (last?.teleportTs !== undefined) ts[PhysicsTimestamp.Teleport] = last.teleportTs;
    if (obj.lastStateSequence >= 0) ts[PhysicsTimestamp.State] = obj.lastStateSequence;
    if (obj.lastVisualDescSeq >= 0) ts[PhysicsTimestamp.ObjDesc] = obj.lastVisualDescSeq;
    const rec: CreateObjectData = {
      ...d,
      name: obj.name,
      position: last?.position ?? obj.position ?? d.position,
      physicsState: obj.physicsState,
      basePalette: obj.basePalette, subPalettes: obj.subPalettes,
      textureChanges: obj.textureChanges, animPartChanges: obj.animPartChanges,
      placement: obj.placement,
      // Its motion and velocity at create time are long over: the message that
      // brings it back (or the next) carries the current ones.
      initialMotion: undefined,
      velocityX: 0, velocityY: 0, velocityZ: 0,
      timestamps: ts,
    };
    const g = obj.guid >>> 0;
    this.maintReleased.delete(g);
    this.maintReleased.set(g, rec);
    while (this.maintReleased.size > ServerObjectManager.MAINT_RELEASED_MAX) {
      const oldest = this.maintReleased.keys().next().value;
      if (oldest === undefined) break;
      this.maintReleased.delete(oldest);
    }
  }

  /**
   * The record of an object ObjectMaint let go, to re-make it now that the
   * server speaks of it again (UpdatePosition, a movement, a vector, a state,
   * an ObjDesc): the server still counts it as known and sends no new
   * CreateObject. Taken once; null when the guid was never let go (or the
   * server deleted it since, or it is held again).
   */
  takeReleasedRecord(guid: number): CreateObjectData | null {
    const g = guid >>> 0;
    const rec = this.maintReleased.get(g);
    if (!rec) return null;
    this.maintReleased.delete(g);
    return this.objects.has(guid) ? null : rec;
  }

  /** The released records of the items `holderGuid` held (they went with it): re-made with it. */
  takeReleasedHeldBy(holderGuid: number): CreateObjectData[] {
    const out: CreateObjectData[] = [];
    for (const [g, rec] of this.maintReleased) {
      if (((rec.physicsParentId || rec.wielderId || 0) >>> 0) !== (holderGuid >>> 0)) continue;
      this.maintReleased.delete(g);
      if (!this.objects.has(g)) out.push(rec);
    }
    return out;
  }

  /**
   * The server spoke of `guid` (a position, movement, vector, state or
   * ObjDesc): if ObjectMaint had let it go, re-make it, and the items it
   * held, through `make` (the owner's CreateObject path) before the message
   * applies. True when it was re-made.
   */
  reviveReleased(guid: number, make: (rec: CreateObjectData) => void): boolean {
    if (guid === this.playerGuid || guid === this.localPlayerGuid || this.objects.has(guid)) return false;
    const rec = this.takeReleasedRecord(guid);
    if (!rec) return false;
    make(rec);
    for (const held of this.takeReleasedHeldBy(guid)) make(held);
    return true;
  }

  /** How many released records are kept (probes / tests). */
  get releasedRecordCount(): number {
    return this.maintReleased.size;
  }

  /**
   * BUG.ac1999-world-objects-missing-after-login — every removal since the
   * last pass, whatever its path (a server DeleteObject, a pickup or wield,
   * a recreate, CObjectMaint): a burst of BULK_REMOVAL_REPORT or more is
   * reported once, with each removal's reason, so a recurrence of the
   * missing-statics bug names the path that took them.
   */
  private flushRemovalJournal(): void {
    if (this.removals.length >= BULK_REMOVAL_REPORT && this.onBulkRemoval) {
      try { this.onBulkRemoval(this.removals.slice()); } catch { /* diagnostics never block the upkeep */ }
    }
    this.removals.length = 0;
  }

  /**
   * DECOMP.interior-objects-culled — an object in an env cell is drawn
   * exactly when its cell is: retail has no per-object indoor/outdoor gate.
   * `PView::DrawCells` @ 005a4840 walks the cells the portal view reached
   * (`cell_draw_list`) and draws each one's objects with it (`DrawObjCell`
   * @ 005a1a40); a building's doorway cells reach the view from the street
   * through its portals (`RenderDeviceD3D::DrawBuilding` @ 0059f2a0). So a
   * shopkeeper is seen through the open door and from inside, and an
   * object in a room no portal view reaches is not drawn. The pre-fix
   * `!playerInDungeon && indoor` rule (UI.32) hid every surface-building
   * object from a player who walked in — shopkeepers, doors, chests, the
   * Meeting Hall portal.
   *
   * `cellDrawn(objCellId)` answers from the cell renderers (surface
   * building cells, dungeon cells): true / false, or undefined when no
   * renderer holds the cell (then nothing is culled). Land-cell objects are
   * never culled here. Call once per frame after the cell visibility pass.
   * Still respects PHYSICS_HIDE_MASK (Hidden 0x4000 | NoDraw 0x20).
   */
  updateInteriorVisibility(cellDrawn: (objCellId: number) => boolean | undefined): void {
    for (const obj of this.objects.values()) {
      if (!obj.mesh) continue;
      const objCellId = obj.objCellId ?? 0;
      obj._culledByCell = isInteriorCellIndex(obj.cellId) && objCellId !== 0
        && cellDrawn(objCellId) === false;
      // Combine with the physicsState hide bits (Hidden | NoDraw).
      this.applyVisibility(obj);
    }
  }

  /** Get objects near a world position within radius. */
  getObjectsInRange(wx: number, wz: number, radius: number): ServerObject[] {
    const r2 = radius * radius;
    const result: ServerObject[] = [];
    for (const obj of this.objects.values()) {
      const dx = obj.worldX - wx;
      const dz = obj.worldZ - wz;
      if (dx * dx + dz * dz <= r2) {
        result.push(obj);
      }
    }
    return result;
  }

  /**
   * Retail radar-dot eligibility, shared by the main-loop radar populate:
   * gmRadarUI::AddObject @ 004d9a00 refuses a UI-hidden object (bitfield
   * 0x80, BUG.uihidden-never-read) and any object whose
   * ACCWeenieObject::InqShowableOnRadar @ 0058c250 is false — RadarBehavior
   * must be ShowMovement / ShowAttacking / ShowAlways (Undefined, the
   * default when the wire omits it, and ShowNever get no blip).
   * BUG.radar-monsters-missing: the blip COLOR is not a gate — ACE sends no
   * RadarBlipColor for monsters (drudges, rats: ShowableOnRadar 2 only), and
   * retail's GetBlipColor colors them Creature gold from their type.
   * Range filtering stays at the call site (it needs player position).
   */
  static radarDotEligible(
    obj: Pick<ServerObject, 'radarBehavior' | 'uiHidden'>,
  ): boolean {
    return showableOnRadar(obj.radarBehavior, !!obj.uiHidden);
  }

  /** Get the nearest object to a screen ray for click targeting. */
  getObjectAtScreenPos(raycaster: THREE.Raycaster): ServerObject | null {
    return this.pickAtScreenPos(raycaster)?.obj ?? null;
  }

  /**
   * The nearest object under the ray and its hit distance. A hit on a held
   * copy (a `wielded_*` mesh hung on its holder's part) finds the held item,
   * not the holder (heldCopyGuidAt): clicking another player's sword
   * selects the sword.
   */
  pickAtScreenPos(raycaster: THREE.Raycaster): { obj: ServerObject; distance: number } | null {
    let closestObj: ServerObject | null = null;
    let closestDist = Infinity;

    for (const obj of this.objects.values()) {
      if (!obj.mesh || !obj.mesh.visible) continue;
      const intersections = raycaster.intersectObject(obj.mesh, true);
      if (intersections.length > 0 && intersections[0].distance < closestDist) {
        closestDist = intersections[0].distance;
        const held = heldCopyGuidAt(intersections[0].object, obj.mesh);
        closestObj = (held && this.objects.get(held)) || obj;
      }
    }

    // BUG.uihidden-never-read — retail UIElement_SmartBoxWrapper::
    // RecvNotice_SmartBoxObjectFound @ 004e5ad0 opens with: if the found
    // object's PublicWeenieDesc bitfield has 0x80 (BF_UI_HIDDEN) set, call
    // SmartBox::set_found_object(0, -1) and return — the mouse-over pipeline
    // treats a UI-hidden object as NOTHING found (no hover label, no cursor
    // change, no select, no use/examine), it does NOT fall through to the
    // object behind it. This is the equivalent chokepoint: all five pick
    // call sites (click, dblclick, hover, armed target mode, context menu)
    // route through here.
    if (!closestObj || closestObj.uiHidden) return null;

    return { obj: closestObj, distance: closestDist };
  }

  /**
   * FAITHFUL.581 — Apply a `GameMessagePublicUpdatePosition` Location
   * (PositionType=1) update. Distinct from the high-frequency
   * `UpdatePosition` (0xF748) which lerp-interpolates motion; this is a
   * one-shot teleport-style write triggered by server actions like an
   * ally setting Sanctuary or being moved by an admin. Skips interpolation
   * since the broadcast cadence is ad-hoc.
   *
   * For PositionTypes other than Location (Sanctuary/LinkedLifestone/etc.)
   * call sites should NOT use this path — those describe the visible
   * object's bind/portal destination, not its current location.
   */
  applyPublicLocationUpdate(
    guid: number,
    landblock: number,
    x: number, y: number, z: number,
    qw: number, qx: number, qy: number, qz: number,
  ): void {
    const obj = this.objects.get(guid);
    if (!obj) return;

    const wx = landblockX(landblock) * 192 + x;
    const wy = z;                                   // AC Z → Three.js Y
    const wz = landblockY(landblock) * 192 + y;     // AC Y → Three.js Z
    const cellId = landblock & 0xFFFF;
    // DECOMP.invented-terrain-snap — the server's Z as sent.
    const clampedY = wy;
    obj.objCellId = landblock >>> 0;

    obj.cellId = cellId;
    this.syncCellLighting(obj);
    obj.worldX = wx;
    obj.worldY = clampedY;
    obj.worldZ = wz;
    obj.serverPlace = { cell: landblock >>> 0, worldX: wx, worldY: clampedY, worldZ: wz };
    obj.serverPlaceAt = performance.now();
    obj.physics?.interp.stopInterpolating();
    obj.physics?.setPositionSimple({ cell: landblock >>> 0, pos: { x: wx, y: wz, z: clampedY }, orient: { w: qw, x: qx, y: qy, z: qz } });

    obj.position = { landblock, x, y, z, rw: qw, rx: qx, ry: qy, rz: qz };

    if (obj.mesh) {
      obj.mesh.position.set(wx, clampedY, wz);
    }
  }

  /**
   * FAITHFUL.581 — Apply a `GameMessagePublicUpdateVital` (0x02E8) update
   * to a tracked ServerObject. The `attribute` is PropertyAttribute2nd
   * (per ACE: 1=Health, 3=Stamina, 5=Mana), distinct from the Vital
   * enum used in PrivateUpdateVital. Stores current + max on the
   * ServerObject so any HP-bar / vital overlay rendering can pick them up.
   *
   * Visible NPC targeting + fellowship-member vital bars both depend on
   * this. Pre-fix the message was silently dropped, so allied health
   * bars only updated on bulk FellowshipFullUpdate broadcasts (every
   * few seconds) and visible NPC HP never updated mid-combat — players
   * had to re-target to see the new value.
   */
  applyPublicVital(guid: number, attribute: number, current: number, max: number): void {
    const obj = this.objects.get(guid);
    if (!obj) return;
    // 1=Health, 3=Stamina, 5=Mana per PropertyAttribute2nd enum.
    if (attribute === 1) {
      obj.healthCurrent = current;
      obj.healthMax = max;
    } else if (attribute === 3) {
      obj.staminaCurrent = current;
      obj.staminaMax = max;
    } else if (attribute === 5) {
      obj.manaCurrent = current;
      obj.manaMax = max;
    }
  }

  /**
   * Handle MovementEvent (0xF74C) from server.
   *
   * Wire format (from aclogview CM_Movement.cs, after guid + instance_timestamp):
   *
   * MovementData header:
   *   movement_timestamp: uint16
   *   server_control_timestamp: uint16
   *   autonomous: uint8
   *   padding: 1 byte (DWORD align)
   *
   * MovementDataUnpack:
   *   movement_type: uint8 (0 = Invalid → InterpretedMotionState)
   *   movement_options: uint8
   *   style: uint16 (wire command index = lower 16 bits of stance)
   *
   * InterpretedMotionState (for type 0):
   *   bitfield: uint32
   *     bit 0: has current_style (uint16)
   *     bit 1: has forward_command (uint16)
   *     bit 2: has forward_speed (float32)
   *     bit 3: has sidestep_command (uint16)
   *     bit 4: has sidestep_speed (float32)
   *     bit 5: has turn_command (uint16)
   *     bit 6: has turn_speed (float32)
   *     bits 7-11: num_actions
   *   Commands read in order: style, forward, sidestep, turn (all uint16)
   *   Then speeds: forward, sidestep, turn (all float32)
   *   Then actions: each = command_index(uint16) + packed_sequence(uint16) + speed(float32)
   *
   * Wire command indices ARE the lower 16 bits of MotionCommand values.
   * Stances reconstruct as 0x80000000 | index.
   */
  handleMovementEvent(data: MovementEventData): void {
    const animated = this.animatedObjects.get(data.guid);
    if (!animated) {
      // STREAM.cold-creature-never-animates — an object whose sequence is
      // waiting on streamed files keeps its latest interpreted state
      // (CMotionInterp::move_to_interpreted_state holds it either way); the
      // streamed rebuild applies it. A MoveTo / TurnTo is not a state.
      const waiting = data.guid !== this.localPlayerGuid ? this.objects.get(data.guid) : undefined;
      if (waiting?.setupId && waiting.physics) { // missiles (no physics record) have no motion state
        const parsed = parseMovementData(data.movementData, true);
        if (parsed?.movementType === 0) this.pendingMotion.set(data.guid, { ...parsed, actions: [] });
        else if (parsed) this.pendingMotion.delete(data.guid);
      }
      return;
    }

    // 0xF74C body = MovementData with the 6-byte header form (movement +
    // server-control timestamps, autonomous byte, DWORD pad). The wire
    // decoding lives in @ac/network parseMovementData (shared with the
    // CreateObject PhysicsDesc Movement blob —
    // BUG.createobject-movement-placement-skipped).
    const parsed = parseMovementData(data.movementData, true);
    if (!parsed) return;

    this.applyParsedMotion(data.guid, animated, parsed, true);
  }

  /**
   * Apply a decoded MovementData to an animated entity — from a live
   * MovementEvent (0xF74C) or from a CreateObject's initial motion state
   * (BUG.createobject-movement-placement-skipped: ACE sends the object's
   * CurrentMotionState in the PhysicsDesc, so already-open doors, corpses,
   * and non-default creature poses render correctly on first sight instead
   * of waiting for their next live motion broadcast).
   */
  private applyParsedMotion(guid: number, animated: AnimatedEntity, parsed: ParsedMovementData, live = false): void {
    const styleIndex = parsed.styleIndex;
    const forwardCmd = parsed.forwardCommand;
    const sidestepCmd = parsed.sidestepCommand;
    const turnCmd = parsed.turnCommand;
    const forwardSpeed = parsed.forwardSpeed;
    const sidestepSpeed = parsed.sidestepSpeed;
    const turnSpeed = parsed.turnSpeed;

    // Our own character: retail applies only NON-autonomous movements to the
    // player (CPhysics::SetObjectMovement @ 00509690). A server MoveTo / TurnTo
    // for us (ACE CreateMoveToChain — the melee approach, Use approaches, the
    // cast turn) is run by the player's MoveToManager in main.ts. An
    // autonomous one is ACE echoing our own MoveToState back
    // (Player_Networking BroadcastMovement → MovementData IsAutonomous =
    // true): it is dropped whole — its commands list replayed every emote
    // key / *wave* a second time (BUG.own-emote-echo-plays-twice).
    const isServerMove = parsed.movementType === MovementType.MoveToObject || parsed.movementType === MovementType.MoveToPosition
      || parsed.movementType === MovementType.TurnToObject || parsed.movementType === MovementType.TurnToHeading;
    if (guid === this.localPlayerGuid) {
      if (parsed.autonomous) return;
      if (live) this.onLocalPlayerServerMotion?.();
      if (isServerMove) {
        // unpack_movement @ 00524440 DoMotions the movement's style first for
        // every object, a MoveTo / TurnTo included (a melee approach begun in peace).
        if (live && parsed.styleIndex > 0) this.onLocalPlayerStyle?.(motionStanceFromIndex(parsed.styleIndex));
        this.onLocalPlayerMovement?.(parsed.movementType, { moveTo: parsed.moveTo, turnTo: parsed.turnTo });
        return;
      }
    } else {
      // MovementManager::unpack_movement @ 00524440: any movement first
      // cancels the object's MoveTo and unsticks it.
      const mover = this.objects.get(guid);
      if (mover) {
        mover.moveTo?.cancelMoveTo();
        mover.physics?.sticky.unStick();
      }
      if (isServerMove) {
        // DECOMP.remote-turnto-dropped / DECOMP.remote-moveto-walk-seed —
        // cases 6-9 on any object: the style first (DoMotion(style) when it
        // differs), then the MoveToManager (controllers/MoveToManager.ts)
        // turns in place, runs / walks as get_command decides, and returns
        // to Ready — for every object, not only the ones chasing us.
        const mm = animated.motionManager;
        if (parsed.styleIndex > 0) {
          const fullStanceId = motionStanceFromIndex(parsed.styleIndex);
          if (mm.currentStyleId !== fullStanceId) {
            if (live && mm.currentStyleId !== 0) mm.changeStyle(fullStanceId); else mm.setStanceFromId(fullStanceId);
          }
        }
        if (mover) {
          const mgr = this.moveToManagerFor(mover);
          const runRate = performServerMovement(mgr, parsed.movementType, parsed, (id) => this.knowsObject(id));
          if (runRate !== null) mover.myRunRate = runRate;
        }
        return;
      }
    }
    if (parsed.movementType !== 0) return; // Types 1-5 — not InterpretedMotionState

    const mm = animated.motionManager;
    if (!mm) return;

    // For the local player, CharacterAnimController manages stance and forward
    // motion locally. Server-echoed movement events would reset the run/walk
    // cycle causing animation stutters. Only process action nodes (attacks) and
    // death for the local player.
    const isLocalPlayer = guid === this.localPlayerGuid;

    // Apply stance change (wire index = lower 16 bits). A style command equal
    // to the current style is a no-op (CMotionTable::GetObjectSequence
    // @ 00522860: `if (state->style == motion) return 1;`, ACE
    // MotionTable.cs:78) — the substate transition below then links from the
    // CURRENT substate (get_link(style, state->substate, …), MotionTable.cs:144).
    // Re-entering the style's default cycle on every event snapped an open
    // door shut (door 0x09000016's style default is Off) before its On→Off
    // link could be found, and replayed the opening swing on a re-sent On
    // (BUG.holdframe-cycle-renders-frame-zero). An event with no substate at
    // all still settles on the style default, as before.
    const fullStanceId = motionStanceFromIndex(styleIndex);
    const hasSubstate = forwardCmd > 0 || sidestepCmd > 0 || turnCmd > 0;
    // SWEEP1006 same-style stop — a live event in the current style with no
    // substate (a combat-stance player stopping: ACE leaves the forward
    // command out) is applied as Ready through its link, keeping a swing or
    // emote in progress (move_to_interpreted_state @ 005289c0 →
    // apply_interpreted_movement: the style DoInterpretedMotion is a no-op,
    // the Ready one runs GetObjectSequence's SubState branch). Only a
    // CreateObject's state snaps to the style default.
    const sameStyleStop = live && styleIndex > 0 && !isLocalPlayer && !hasSubstate
      && mm.currentStyleId === fullStanceId && !!mm.activeMotionTable;
    if (styleIndex > 0 && !isLocalPlayer && !sameStyleStop && (mm.currentStyleId !== fullStanceId || !hasSubstate)) {
      // A live style change (a player drawing a weapon, a monster going to
      // combat) plays its transition (MotionManager.changeStyle — the
      // GetObjectSequence style branch); the state a CreateObject carries is
      // simply where the object already is. The style plays at 1.0, not the
      // forward speed (DECOMP.style-change-speed): MovementManager::
      // unpack_movement @ 00524440 and apply_interpreted_movement @ 00528600
      // DoMotion the style with a default MovementParameters (speed 1.0) —
      // a player drawing a weapon while running drew it 2–3× fast.
      if (live && mm.currentStyleId !== fullStanceId && mm.currentStyleId !== 0) mm.changeStyle(fullStanceId, 1.0);
      else mm.setStanceFromId(fullStanceId, 1.0);
    }

    // Wire format: forwardCmd is the low 16 bits of a MotionCommand.X value.
    if (forwardCmd === MOTION_DEAD_WIRE_INDEX) {
      // Death animation — always apply, even for local player
      mm.playDeath(forwardCmd, forwardSpeed);
      this.dyingObjects.add(guid);
      // BUG.dying-creature-loses-collision — it keeps its collision (and
      // stops missiles) until its DeleteObject; dyingObjects only gates targeting.
      const deadObj = this.objects.get(guid);
      if (deadObj?.motionState) Object.assign(deadObj.motionState, readyMotion(), { forward: MotionCommand.Dead, forwardSpeed });
      return;
    }

    // Our own character standing back up. The server's next non-autonomous
    // movement after its Dead leaves the Dead substate: retail applies a
    // server movement to the player like any other (SetObjectMovement
    // @ 00509690); GetObjectSequence's link(Dead → Ready) is absent from
    // the human table, so the body returns to the Ready cycle. The AC1999 server's Revive (WeenieObject.cpp) re-sends Dead
    // with the lifestone position (0xF619), then StopCompletely and the
    // peace stance, then the vitals; when the vitals were applied first, the
    // late Dead held the character as a corpse that walked around lying down.
    // (ACE's "Stand back up" SetCombatMode after the death teleport is the
    // same signal.)
    if (isLocalPlayer && !parsed.autonomous && mm.isDead) {
      mm.revive();
      this.dyingObjects.delete(guid);
      const standCmd = forwardCmd > 0 ? forwardCmd : MOTION_READY_WIRE_INDEX;
      mm.setForwardMotion(MotionManager.compositeKey(mm.currentStyleId, standCmd), forwardCmd > 0 ? forwardSpeed : 1.0);
    }

    // Retail CPhysics::SetObjectMovement @ 00509690 applies a movement to the
    // player object unless it is AUTONOMOUS (`if (!autonomous || !isPlayer)
    // unpack_movement`): the server's own motions for the player — ACE sends
    // a melee swing (Player_Melee DoSwingMotion) and Eat / Drink / Read
    // (Food/Healer UseItem motions) as a non-autonomous ForwardCommand —
    // play on the local character too. CharacterAnimController owns the
    // local locomotion cycle, so such a command plays as a one-shot action
    // (the server's following Ready is the controller's to handle); an
    // action already playing with the same command (a local prediction such
    // as a typed emote) is not restarted.
    //
    // A SUBSTATE-class command (the talisman cast gestures MagicBlast…
    // MagicPray 0x2b–0x39, CastSpell, Eat / Drink / Reading) is not a
    // one-shot: GetObjectSequence plays link(Ready → gesture), then the
    // gesture's hold cycle (framerate 0 — hands held out), and the server's
    // following Ready plays link(gesture → Ready) — the release / throw
    // (ACE Player_Magic DoCastGesture → FinishCast's Ready; human table
    // 0x09000001: link 0x490003→0x40000032 = 0x0300059d frames 0–21, cycle
    // 0x490032 holds frame 21, link 0x490032→0x41000003 = frames 21–52).
    // Played as a one-shot it snapped back to Ready and the release never
    // showed. ACTION-class commands (the windups MagicPowerUp01–10
    // 0x1000006f–78, swings) stay one-shots.
    //
    // The missile sequence is substates too (GAP.10; ACE Player_Missile
    // EnqueueMotionPersist(aim level), then Creature_Missile
    // ReloadMissileAmmo's Reload and Ready): Aim* 0x4000001e–2a hold the aim
    // frame, Reload 0x40000016 holds the arrow drawn back, and the Ready
    // plays link(Reload → Ready) — the nock (bow 0x030004ae frames 0–22,
    // hold 22, then 22–end). Atlatl / thrown link(Aim → Reload) 0x030004b0
    // frames 18–end is the throw itself. As one-shots the reload snapped
    // back at frame 22 and the throw never played
    // (BUG.missile-aim-reload-played-as-actions).
    if (isLocalPlayer && !parsed.autonomous) {
      // The style first: a swing or a reload is keyed to the server's style.
      if (styleIndex > 0 && live) this.onLocalPlayerStyle?.(fullStanceId);
      applyServerForwardToLocalPlayer(mm, forwardCmd, forwardSpeed, fullStanceId, sidestepCmd, turnCmd);
    }

    // The object's interpreted motion state (CMotionInterp::
    // move_to_interpreted_state): forward, sidestep and turn with their
    // speeds — an absent forward command is Ready (ACE InterpretedMotionState
    // default). GetObjectSequence decides which of them is the substate the
    // sequence plays and which only add their physics (world/RemoteMotion
    // resolveMotion): a creature strafing or pivoting in place with Ready
    // forward plays the sidestep / turn cycle, a runner who turns keeps
    // running. The state also gives the sequence its velocity / omega
    // (DECOMP.remote-motion-no-displacement, updateAnimations).
    // Skip for local player — CharacterAnimController handles this locally.
    if (!isLocalPlayer) {
      const obj = this.objects.get(guid);
      const full = (wire: number): number => (motionCommandFromWireIndex(wire) ?? wire) >>> 0;
      const fullForward = forwardCmd > 0 ? full(forwardCmd) : MotionCommand.Ready;
      const forwardIsAction = forwardCmd > 0 && isActionCommand(fullForward);
      const st = obj?.motionState;
      if (st) {
        if (!forwardIsAction) { st.forward = fullForward; st.forwardSpeed = forwardCmd > 0 ? forwardSpeed : 1; }
        // apply_interpreted_movement @ 00528600: a RunForward state's speed is
        // the object's run rate from now on (my_run_rate) — what the
        // InterpolationManager's catch-up speed (get_adjusted_max_speed) and
        // a leave-ground velocity scale by once it stops running.
        if (obj && st.forward === MotionCommand.RunForward) obj.myRunRate = st.forwardSpeed;
        // The motion table keys only the right-hand turn / sidestep: a left
        // one is the right one at negative speed (adjust_motion's direction
        // flip), so the sequence plays the cycle backwards.
        const side = sidestepCmd > 0 ? full(sidestepCmd) : 0;
        st.sidestep = side === MotionCommand.SideStepLeft ? MotionCommand.SideStepRight : side;
        st.sidestepSpeed = side === MotionCommand.SideStepLeft ? -sidestepSpeed : sidestepSpeed;
        const turn = turnCmd > 0 ? full(turnCmd) : 0;
        st.turn = turn === MotionCommand.TurnLeft ? MotionCommand.TurnRight : turn;
        st.turnSpeed = turn === MotionCommand.TurnLeft ? -turnSpeed : turnSpeed;
      }
      if (forwardIsAction) {
        // An ACTION-class forward command is a one-shot (setForwardMotion queues it).
        mm.setForwardMotion(MotionManager.compositeKey(fullStanceId, forwardCmd), forwardSpeed);
      } else if (hasSubstate) {
        if (obj && mm.activeMotionTable) {
          this.playMotionState(obj, mm);
        } else if (forwardCmd > 0 && forwardCmd !== MOTION_READY_WIRE_INDEX) {
          // No motion table to resolve against: the forward command, else
          // the sidestep, else the turn (ACE keeps forward at Ready while
          // strafing / pivoting in place).
          mm.setForwardMotion(MotionManager.compositeKey(fullStanceId, forwardCmd), forwardSpeed);
        } else if (sidestepCmd > 0) {
          mm.setForwardMotion(MotionManager.compositeKey(fullStanceId, sidestepCmd), sidestepSpeed);
        } else if (turnCmd > 0) {
          mm.setForwardMotion(MotionManager.compositeKey(fullStanceId, turnCmd), turnSpeed);
        } else {
          mm.setForwardMotion(MotionManager.compositeKey(fullStanceId, forwardCmd), forwardSpeed);
        }
      } else if ((styleIndex === 0 || sameStyleStop) && obj && mm.activeMotionTable) {
        // BUG.remote-stop-without-style — a stop with no style and no
        // substate still settles on Ready. The retail client packs
        // CurrentStyle only off NonCombat (RawMotionState::Pack @ 0051ed10),
        // so ACE broadcasts a peace-mode player's stop as style 0 with no
        // forward command (MovementData(Creature, MoveToState)). Retail
        // applies the whole state regardless: unpack_movement @ 00524440 →
        // CMotionInterp::move_to_interpreted_state @ 005289c0 copies it
        // (absent forward = Ready, InterpretedMotionState::UnPack @ 0051f400)
        // and apply_current_movement. The style branch above only settles a
        // stop that names a style, so these players walked in place forever.
        this.playMotionState(obj, mm);
      }
    }

    // Apply one-shot action commands (attacks, emotes, etc.) from the
    // MotionItem commands list (count at bitfield bits 7+).
    // SWEEP1006 action stamps — CMotionInterp::move_to_interpreted_state
    // @ 005289c0: an action plays only when its 15-bit server_action_stamp
    // is newer than the object's last (retail senders repeat an action until
    // it completes), and on our own character only when it is not
    // autonomous (bit 15, ACE MotionItem.PackedSequence).
    for (const action of parsed.actions) {
      if (action.command <= 0) continue;
      const stamp = action.sequence & 0x7fff;
      const autonomous = (action.sequence & 0x8000) !== 0;
      if (!isServerActionNewer(stamp, this.serverActionStamps.get(guid) ?? 0)) continue;
      if (isLocalPlayer && autonomous) continue;
      this.serverActionStamps.set(guid, stamp);
      const key = MotionManager.compositeKey(fullStanceId, action.command);
      mm.queueAction(key, action.speed);
    }
  }

  /** Remove all objects. */
  clear(): void {
    this.maintReleased.clear();
    this.dyingObjects.clear();
    this.projectiles.clear();
    this.destructionQueue.clear();
    for (const guid of [...this.objects.keys()]) {
      this.forceDelete(guid, 'clear');
    }
    // The teardown logs itself ("World state torn down"); no burst report.
    this.removals.length = 0;
  }

  /**
   * Update all server objects one frame — each remote object's
   * `CPhysicsObj::update_object`: its MoveToManager steps
   * (`MoveToManager::UseTime`), its sequence advances and yields the root
   * motion + velocity / omega offset (`CPartArray::Update`), and its physics
   * moves it by that offset, the interpolation / sticky adjustments and its
   * own velocity (`UpdatePositionInternal @ 00512c30`, world/RemotePhysics).
   * Call once per frame from the render loop.
   *
   * SOUND.hook-stall-burst — a step longer than HUGE_QUANTUM (2 s: a
   * backgrounded tab, a long load) advances nothing: update_object @
   * 00515d10 only resets update_time, so no sequence frames are stepped and
   * none of their hooks (footsteps, swing sounds) replay at once on return.
   */
  updateAnimations(deltaTime: number): void {
    if (deltaTime > HUGE_QUANTUM) return;
    const now = performance.now() / 1000;
    const env = this.physicsEnv;
    const stepped = new Set<number>();
    for (const obj of this.objects.values()) {
      if (!obj.mesh) continue;
      // BUG.teleport-leaves-stale-objects — CPhysicsObj::update_object
      // returns at once for an object with no cell (lost, or picked up —
      // DECOMP.pickup-event-ignored).
      if (obj.lostCell || obj.outOfWorld) continue;
      const body = obj.physics;
      // A carried / wielded object is placed by its parent, not by physics.
      if (!body || !body.inCell || obj.wielderId) continue;
      // UpdateObjectInternal @ 005156b0: a held object (CHECK_ETHEREAL)
      // tries set_ethereal(0) again before it moves.
      if (obj.checkEthereal) this.setEthereal(obj, false);
      obj.moveTo?.useTime();
      const anim = this.animatedObjects.get(obj.guid);
      let offset = null;
      let seqStep: SequenceStepInfo | undefined;
      if (anim && obj.guid !== this.localPlayerGuid) {
        const mm = anim.motionManager;
        const physics = sequencePhysicsFor(mm.activeMotionTable, mm.currentStyleId, this.appliedMotionState(obj));
        const motion = { frame: identityFrame(), velocity: physics.velocity, omega: physics.omega };
        // MOVE.chunked-motion-judder — how the sequence stepped, for the draw lag.
        const player = mm.animationPlayer as AnimationPlayer | undefined;
        player?.takeSteps();
        anim.update(deltaTime, motion);
        offset = motion.frame;
        if (player) seqStep = { steps: player.takeSteps(), phase: player.stepPhase, epoch: player.nodeEpoch };
        stepped.add(obj.guid);
      }
      body.update(deltaTime, offset, env, now, seqStep);
      this.syncBodyToMesh(obj);
    }

    // Update projectile physics (velocity + gravity + rotation)
    this.updateProjectiles(deltaTime);

    // Setup DefaultAnimation loops (objects without a motion table).
    for (const [guid, d] of this.defaultAnims) {
      const o = this.objects.get(guid);
      if (!o?.mesh || this.animatedObjects.has(guid)) { this.defaultAnims.delete(guid); continue; }
      if (o.lostCell || o.outOfWorld) continue;
      if (d.mesh !== o.mesh) { d.mesh = o.mesh; d.parts = collectPartObjects(o.mesh); }
      d.player.update(deltaTime);
      applyPartTransforms(d.parts, d.player.getPartTransforms());
    }

    // Advance the other animations (the local player's, objects not in a cell).
    for (const [guid, anim] of this.animatedObjects) {
      if (stepped.has(guid)) continue;
      if (guid === this.localPlayerGuid && this.localPlayerSequenceStepped) continue;
      // A lost-cell object's sequence stands still: no frames, no hooks.
      const o = this.objects.get(guid);
      if (o?.lostCell || o?.outOfWorld) continue;
      anim.update(deltaTime);
    }
  }

  /** Copy an object's physics position (AC axes) onto its world coordinates and mesh (THREE axes). */
  private syncBodyToMesh(obj: ServerObject): void {
    const body = obj.physics;
    if (!body) return;
    obj.worldX = body.pos.x;
    obj.worldY = body.pos.z;
    obj.worldZ = body.pos.y;
    obj.bodySyncedAt = performance.now();
    if (!obj.mesh || obj.wielderId || obj.outOfWorld) return;
    // MOVE.chunked-motion-judder — the mesh is drawn between the body's
    // whole-frame steps; worldX / Y / Z stay the simulated position.
    const draw = body.drawPosition();
    obj.mesh.position.set(draw.x, draw.z, draw.y);
    const [qx, qy, qz, qw] = acQuatToThree(body.drawOrientation());
    obj.mesh.quaternion.set(qx, qy, qz, qw);
  }

  /** What remote physics reads from the world: the terrain height (AC z) outdoors. */
  private readonly physicsEnv: RemotePhysicsEnv = {
    terrainHeight: (x, y) => this.terrainCollision?.getHeightAt(x, y) ?? null,
    landingZ: (cell, x, y, z, spheres) => this.objectLandingQuery?.(cell, x, y, z, spheres) ?? null,
  };

  /** Whether this client knows object `id` (CObjectMaint::GetObjectA) — us included. */
  private knowsObject(id: number): boolean {
    return id === this.playerGuid || id === this.localPlayerGuid || this.objects.has(id);
  }

  /** A MoveTo / TurnTo / sticky target's position (AC axes), radius and height. */
  targetInfo(id: number): { pos: SeqV3; radius: number; height: number } | null {
    if (id === this.playerGuid || id === this.localPlayerGuid) {
      const me = this.localPlayerPosition?.();
      if (!me) return null;
      return { pos: { x: me.x, y: me.z, z: me.y ?? 0 }, radius: me.radius, height: me.height ?? 0 };
    }
    const t = this.objects.get(id);
    if (!t) return null;
    const pos = t.physics?.inCell ? { ...t.physics.pos } : { x: t.worldX, y: t.worldZ, z: t.worldY };
    return { pos, radius: t.collisionRadius, height: t.collisionHeight };
  }

  /** Hook an object's physics up to its motion interpreter and MoveToManager. */
  private bindPhysics(obj: ServerObject): void {
    const body = obj.physics;
    if (!body) return;
    body.motion = {
      adjustedMaxSpeed: () => (this.animatedObjects.has(obj.guid) ? adjustedMaxSpeed(obj.motionState ?? readyMotion(), obj.myRunRate ?? 1) : 0),
      maxSpeed: () => (this.animatedObjects.has(obj.guid) ? maxSpeed(obj.myRunRate ?? 1) : 0),
      radius: () => obj.collisionRadius,
      isMovingTo: () => !!obj.moveTo?.isMovingTo(),
      cancelMoveTo: () => obj.moveTo?.cancelMoveTo(),
      // MovementManager::HitGround @ 00524300: the motion interpreter, then the MoveToManager.
      hitGround: () => { this.motionInterpGroundChange(obj, false); obj.moveTo?.hitGround(); },
      leaveGround: () => this.motionInterpGroundChange(obj, true),
      targetPosition: (id) => this.targetInfo(id)?.pos ?? null,
    };
  }

  /**
   * What the object's sequence plays for its interpreted state
   * (`apply_interpreted_movement @ 00528600`): a creature with Gravity off
   * the walkable ground plays Falling in place of its forward / sidestep
   * (`contact_allows_move @ 00528240`).
   */
  private appliedMotionState(obj: ServerObject): InterpretedMotion {
    const st = obj.motionState ?? readyMotion();
    const body = obj.physics;
    const isCreature = (obj.itemType & ItemType.Creature) !== 0;
    const gravity = ((body ? body.state : obj.physicsState) & PhysicsState.Gravity) !== 0;
    const onGround = !body || (body.contact && body.onWalkable);
    return appliedMotion(st, contactAllowsMove(st.forward, isCreature, gravity, onGround));
  }

  /**
   * `CMotionInterp::LeaveGround @ 00528b00` / `HitGround @ 00528ac0` for a
   * remote creature with Gravity: leaving the ground sets the object's
   * velocity to its state's (get_leave_ground_velocity — kept as it is when
   * the state is still); both drop the playing links (RemoveLinkAnimations)
   * and re-apply the interpreted state (apply_current_movement), which is
   * Falling in the air and the state's own motion once landed.
   */
  private motionInterpGroundChange(obj: ServerObject, leaving: boolean): void {
    const body = obj.physics;
    if (!body || (obj.itemType & ItemType.Creature) === 0 || (body.state & PhysicsState.Gravity) === 0) return;
    if (leaving) {
      const v = leaveGroundVelocity(obj.motionState ?? readyMotion(), obj.myRunRate ?? 1);
      if (v) body.setLocalVelocity(v);
    }
    const mm = this.animatedObjects.get(obj.guid)?.motionManager;
    if (!mm || mm.isDead) return;
    mm.removeLinkAnimations();
    this.playMotionState(obj, mm);
  }

  /**
   * Play an object's motion state: the substate GetObjectSequence would
   * (world/RemoteMotion resolveMotion); a forward command with no cycle in
   * the table (a link / modifier-only motion) is handed to the
   * MotionManager as it is.
   */
  private playMotionState(obj: ServerObject, mm: MotionManager): void {
    if (!obj.motionState) return;
    const st = this.appliedMotionState(obj);
    const table = mm.activeMotionTable;
    if (!table) {
      // No table to resolve against: the forward command, else the sidestep, else the turn.
      const style = mm.currentStyleId || MotionStance.NonCombat;
      const [cmd, speed] = st.forward !== MotionCommand.Ready ? [st.forward, st.forwardSpeed]
        : st.sidestep ? [st.sidestep, st.sidestepSpeed] : st.turn ? [st.turn, st.turnSpeed] : [st.forward, st.forwardSpeed];
      mm.setForwardMotion(MotionManager.compositeKey(style, cmd), speed);
      return;
    }
    const style = mm.currentStyleId || table.defaultStyle;
    const r = resolveMotion(table, style, st);
    const forwardHasCycle = table.cycles.has(MotionManager.compositeKey(style, st.forward))
      || table.cycles.has(MotionManager.compositeKey(table.defaultStyle, st.forward));
    const chosenIsForward = r.substate !== st.sidestep && r.substate !== st.turn;
    if (!forwardHasCycle && chosenIsForward && st.forward !== MotionCommand.Ready) {
      mm.setForwardMotion(MotionManager.compositeKey(style, st.forward), st.forwardSpeed);
      return;
    }
    mm.setForwardMotion(MotionManager.compositeKey(style, r.substate), r.substateSpeed);
  }

  /**
   * The object's MoveToManager, made on first use: its motions go through
   * the object's motion interpreter (`_DoMotion`: adjust_motion — creatures
   * only — then DoInterpretedMotion), its position is the object's physics.
   */
  private moveToManagerFor(obj: ServerObject): MoveToManager {
    if (obj.moveTo) return obj.moveTo;
    const isCreature = (obj.itemType & ItemType.Creature) !== 0;
    const motion = (cmd: number, speed: number, holdKey: number) =>
      (isCreature ? adjustMotion(cmd, speed, holdKey, HoldKey.None, obj.myRunRate ?? 1) : { motion: cmd, speed });
    const mm = () => this.animatedObjects.get(obj.guid)?.motionManager;
    const host: MoveToHost = {
      position: () => obj.physics?.pos ?? { x: obj.worldX, y: obj.worldZ, z: obj.worldY },
      heading: () => obj.physics?.heading ?? 0,
      setHeading: (h) => obj.physics?.setHeading(h),
      radius: () => obj.collisionRadius,
      height: () => obj.collisionHeight,
      doMotion: (cmd, speed, holdKey) => {
        const st = obj.motionState;
        const m = mm();
        if (!st || !m) return 0xb; // NoMotionInterpreter
        const a = motion(cmd, speed, holdKey);
        applyInterpretedMotion(st, a.motion, a.speed);
        this.playMotionState(obj, m);
        return 0;
      },
      stopMotion: (cmd, speed, holdKey) => {
        const st = obj.motionState;
        const m = mm();
        if (!st || !m) return 0xb;
        removeInterpretedMotion(st, motion(cmd, speed, holdKey).motion);
        this.playMotionState(obj, m);
        return 0;
      },
      stopCompletely: () => {
        const st = obj.motionState;
        const m = mm();
        if (!st || !m) return;
        Object.assign(st, readyMotion());
        this.playMotionState(obj, m);
      },
      motionsPending: () => { const m = mm(); return !!m && (m.isPlayingAction || m.isChangingStyle); },
      hasContact: () => obj.physics?.contact ?? true,
      target: (id) => this.targetInfo(id),
      stickTo: (id, radius) => obj.physics?.sticky.stickTo(id, radius, performance.now() / 1000),
      unstick: () => obj.physics?.sticky.unStick(),
      now: () => performance.now() / 1000,
    };
    obj.moveTo = new MoveToManager(host);
    return obj.moveTo;
  }

  // BUG.invented-portal-burst-and-spell-effects — playHitRecoil (FAITHFUL.201,
  // a 0.12 m sin-bell shove) and flashHitIndicator (an emissive flash) are
  // gone: retail moves a creature only by its motions and position updates,
  // and a hit's visual is the server's Splatter* PlayScript (ACE
  // Player_Combat.cs:175) through the target's own PhysicsScriptTable.

  /**
   * CORE.17.k.b.b.a.g.b — `CPhysicsObj::SetLighting(luminosity, diffuse) @
   * 00511a80` → `CPartArray::SetLightingInternal`: every part's material is
   * copied once and given the levels. Returns false for an unknown / meshless
   * object (retail: `CObjectMaint::GetObjectA` null → nothing).
   */
  setLighting(guid: number, levels: LightingLevels): boolean {
    const obj = this.objects.get(guid);
    const drawn = obj ? this.drawnRoot(obj) : null;
    if (!obj || !drawn) return false;
    const copies = obj.lightingCopies ?? (obj.lightingCopies = new Map());
    setObjectLighting(drawn, levels, copies);
    return true;
  }

  /**
   * What draws the object: its own mesh, or — while a holder holds it — its
   * held copy on the holder's part. A held item's own mesh enters no cell
   * (outOfWorld) and keeps a stale place; retail's child is placed by
   * UpdateChild every frame, so everything that lights, frames or measures
   * a held item reads the copy. Null when nothing draws it.
   */
  drawnRoot(obj: ServerObject): THREE.Object3D | null {
    if (!obj.wielderId) return obj.mesh ?? null;
    const holder = this.objects.get(obj.wielderId)?.mesh;
    return holder ? heldCopiesUnder(holder, obj.guid)[0] ?? null : null;
  }

  /** `CPhysicsObj::RestoreLighting @ 00511ab0` — the parts draw their own materials again. */
  restoreLighting(guid: number): boolean {
    const obj = this.objects.get(guid);
    if (!obj?.lightingCopies) return false;
    restoreObjectLighting(obj.lightingCopies);
    obj.lightingCopies = undefined;
    // The restored originals are landscape-pass materials; put the object
    // back in the pass its cell decides (CORE.17.q.b).
    this.syncCellLighting(obj, true);
    return true;
  }

  /**
   * Find a server object by name (case-insensitive).
   * Returns the first match. Used for combat notifications where only name is available.
   */
  findObjectByName(name: string): ServerObject | undefined {
    const lower = name.toLowerCase();
    for (const obj of this.objects.values()) {
      if (obj.name.toLowerCase() === lower) return obj;
    }
    return undefined;
  }

  // ─── Private ────────────────────────────────────────────────────

  /** Start the Setup's DefaultAnimation loop (see defaultAnims); false when it has none. */
  private tryInitDefaultAnimation(obj: ServerObject): boolean {
    if (!this.portalDb || !obj.mesh || !obj.setupId) return false;
    let animId = 0;
    try { animId = this.setupModelRenderer.loadSetupModel(obj.setupId)?.defaultAnimation ?? 0; } catch { animId = 0; }
    if (!animId) return false;
    const data = this.portalDb.getFileData(animId);
    if (!data) return false;
    let anim: Animation;
    try { anim = new Animation(new DatReader(data)); } catch { return false; }
    if (anim.numFrames === 0) return false;
    wavePrefetch().hooks(anim.partFrames); // SOUND.wave-precache
    const player = new AnimationPlayer();
    // InitDefaults: AnimData(default_anim_id, low 0, high -1, 30 fps), appended as the cyclic tail.
    player.play(anim, 0, -1, 30, 1.0, true);
    const guid = obj.guid;
    player.onHook((hook) => { const m = this.objects.get(guid)?.mesh; if (m) this.runObjectHook(guid, hook, m); });
    const parts = collectPartObjects(obj.mesh);
    applyPartTransforms(parts, player.getPartTransforms());
    this.defaultAnims.set(guid, { player, mesh: obj.mesh, parts });
    return true;
  }

  /** The DefaultAnimation loop's frame for an object (probes / tests); null when it has none. */
  defaultAnimationFrame(guid: number): number | null {
    const d = this.defaultAnims.get(guid);
    return d ? d.player.currentFrame : null;
  }

  /** Try to initialize idle animation for a server object. */
  private tryInitAnimation(obj: ServerObject): void {
    if (!this.portalDb || !obj.mesh || !obj.setupId) return;

    // Use motionTableId from CreateObject data (server-sent), fallback to SetupModel default
    let motionTableId = obj.motionTableId;
    if (!motionTableId) {
      const setup = this.setupModelRenderer.loadSetupModel(obj.setupId);
      motionTableId = setup?.defaultMotionTable ?? 0;
    }
    if (!motionTableId) return;

    obj.motionTableId = motionTableId;

    try {
      const animated = new AnimatedEntity(obj.mesh, this.portalDb);
      const ok = animated.initFromMotionTable(motionTableId);
      if (ok) {
        this.animatedObjects.set(obj.guid, animated);
        // CSequence::execute_hooks → CAnimHook::Execute on this object; the
        // group is read at fire time (an appearance rebuild rebinds it).
        const guid = obj.guid;
        animated.motionManager.onHook((hook) => this.runObjectHook(guid, hook, animated.group));
      }
    } catch {
      // Animation init failure is non-fatal
    }
  }

  /**
   * BUG.spell-projectile-physics — fly every tracked missile one frame
   * (MissilePhysics.advanceMissile: retail CPhysicsObj::update_object) and
   * copy the result onto its mesh. No homing, no lifetime guess: the server's
   * SetState / VectorUpdate / DeleteObject end the flight.
   */
  private updateProjectiles(dt: number): void {
    const toRemove: number[] = [];
    for (const [guid, body] of this.projectiles) {
      const obj = this.objects.get(guid);
      if (!obj?.mesh) {
        toRemove.push(guid);
        continue;
      }
      const events = advanceMissile(body, dt, this.missileSweepFor(guid));
      this.syncMissileMesh(obj, body);
      for (const e of events) {
        if (e.playDefaultScript && this.onMissileDefaultScript) {
          try { this.onMissileDefaultScript(obj); } catch { /* an effect never stops the flight */ }
        }
      }
    }
    for (const guid of toRemove) this.projectiles.delete(guid);
  }

  /** Copy a missile body (AC axes) onto its ServerObject + mesh (THREE axes). */
  private syncMissileMesh(obj: ServerObject, body: MissileBody): void {
    obj.worldX = body.pos.x;
    obj.worldY = body.pos.z;
    obj.worldZ = body.pos.y;
    if (!obj.mesh) return;
    obj.mesh.position.set(obj.worldX, obj.worldY, obj.worldZ);
    const [qx, qy, qz, qw] = acQuatToThree(body.orient);
    obj.mesh.quaternion.set(qx, qy, qz, qw);
  }

  /**
   * BUG.missile-creature-shape — a creature's collision for a missile, as
   * CPhysicsObj::FindObjCollisions @ 0050f050 tests it: its Setup's
   * CylSpheres if it has any, else its Spheres, each scaled by the object's
   * scale (m_scale) at its position and heading (CCylSphere / CSphere::
   * intersects_sphere). AC world axes. Null when the Setup is not loaded
   * (the caller falls back to the Setup's bounding cylinder).
   */
  private creatureMissileShapes(o: ServerObject): {
    cylinders: Array<{ guid: number; x: number; y: number; z: number; radius: number; height: number }>;
    spheres: Array<{ guid: number; x: number; y: number; z: number; radius: number }>;
    reach: number;
  } | null {
    let setup;
    try { setup = this.setupModelRenderer.loadSetupModel(o.setupId); } catch { setup = undefined; }
    if (!setup) return null;
    const scale = o.mesh?.scale.x || 1;
    // THREE mesh quaternion (x, y, z, w) = AC (−x, −z, −y, w).
    const q = o.mesh?.quaternion;
    const qw = q ? q.w : 1, qx = q ? -q.x : 0, qy = q ? -q.z : 0, qz = q ? -q.y : 0;
    const rot = (v: { x: number; y: number; z: number }) => {
      // v' = q v q*
      const tx = 2 * (qy * v.z - qz * v.y), ty = 2 * (qz * v.x - qx * v.z), tz = 2 * (qx * v.y - qy * v.x);
      return { x: v.x + qw * tx + (qy * tz - qz * ty), y: v.y + qw * ty + (qz * tx - qx * tz), z: v.z + qw * tz + (qx * ty - qy * tx) };
    };
    const base = { x: o.worldX, y: o.worldZ, z: o.worldY };
    const cylinders: Array<{ guid: number; x: number; y: number; z: number; radius: number; height: number }> = [];
    const spheres: Array<{ guid: number; x: number; y: number; z: number; radius: number }> = [];
    let reach = 0;
    const cyls = setup.cylSpheres ?? [];
    if (cyls.length > 0) {
      for (const c of cyls) {
        const off = rot(c.origin);
        cylinders.push({ guid: o.guid, x: base.x + off.x * scale, y: base.y + off.y * scale, z: base.z + off.z * scale, radius: c.radius * scale, height: c.height * scale });
        reach = Math.max(reach, (Math.hypot(off.x, off.y) + c.radius) * scale);
      }
    } else {
      for (const sp of setup.spheres ?? []) {
        const off = rot(sp.origin);
        spheres.push({ guid: o.guid, x: base.x + off.x * scale, y: base.y + off.y * scale, z: base.z + off.z * scale, radius: sp.radius * scale });
        reach = Math.max(reach, (Math.hypot(off.x, off.y) + sp.radius) * scale);
      }
    }
    return { cylinders, spheres, reach };
  }

  /**
   * The world + creatures a missile can hit this frame. Creatures are the
   * non-ethereal ones, by their Setup's CylSpheres / Spheres × scale
   * (creatureMissileShapes); a shape the missile starts inside only stops a
   * move heading inward (sweepCylinders).
   */
  private missileSweepFor(guid: number): MissileSweep {
    return (from: V3, to: V3, radius: number) => {
      let best = this.missileEnvironmentSweep ? this.missileEnvironmentSweep(from, to, radius) : null;
      const missileState = this.projectiles.get(guid)?.state ?? 0;
      const cylinders: { guid: number; x: number; y: number; z: number; radius: number; height: number }[] = [];
      const spheres: { guid: number; x: number; y: number; z: number; radius: number }[] = [];
      const kinds = new Map<number, MissileObstacleKind>();
      const reach = Math.hypot(to.x - from.x, to.y - from.y) + radius;
      for (const o of this.objects.values()) {
        if (o.guid === guid || !o.mesh) continue;
        const kind = classifyMissileObstacle(o.physicsState, missileState);
        if (kind === 'ignore') continue;
        const d = Math.hypot(o.worldX - from.x, o.worldZ - from.y);
        // A creature with a physics BSP collides by its parts, like any object (below).
        if ((o.itemType & ItemType.Creature) && !(o.physicsState & PhysicsState.HasPhysicsBSP)) {
          const shapes = this.creatureMissileShapes(o);
          if (!shapes) {
            // Setup not loaded: its bounding cylinder.
            if (o.collisionRadius <= 0 || o.collisionHeight <= 0) continue;
            if (d > reach + o.collisionRadius) continue;
            kinds.set(o.guid, kind);
            cylinders.push({ guid: o.guid, x: o.worldX, y: o.worldZ, z: o.worldY, radius: o.collisionRadius, height: o.collisionHeight });
            continue;
          }
          if (d > reach + shapes.reach) continue;
          kinds.set(o.guid, kind);
          cylinders.push(...shapes.cylinders);
          spheres.push(...shapes.spheres);
          continue;
        }
        // VERIFY.spell-projectile-arc-ring-dungeon — every other solid
        // weenie object (a closed door, a chest, a lifestone) obstructs a
        // missile too: FindObjCollisions runs on any object in the cells the
        // missile crosses, with its Setup's BSP / CylSpheres / Spheres.
        // A wielded / held object is parented to its wielder, not in a cell
        // (CPhysicsObj::set_parent leaves the cell's object list).
        if (o.wielderId || !ServerObjectManager.inWorldForMissiles(o)) continue;
        if (!this.missileObjectSweep || d > reach + ServerObjectManager.MISSILE_OBJECT_REACH) continue;
        best = nearestContact(best, applyObstacleKind(this.missileObjectSweep(o, from, to, radius), kind, o.guid));
      }
      // Our own character is a creature in the cell like any other (the
      // retail client's player CPhysicsObj): a monster's arrow or bolt
      // stops at us locally, not only when the server's verdict arrives.
      const me = this.missileLocalPlayer?.();
      if (me && me.radius > 0 && me.height > 0 && classifyMissileObstacle(0, missileState) !== 'ignore'
        && Math.hypot(me.x - from.x, me.y - from.y) <= reach + me.radius) {
        cylinders.push({ guid: this.playerGuid, x: me.x, y: me.y, z: me.z, radius: me.radius, height: me.height });
      }
      let creature = nearestContact(sweepCylinders(from, to, radius, cylinders), sweepSpheres(from, to, radius, spheres));
      if (creature?.objectGuid !== undefined) creature = applyObstacleKind(creature, kinds.get(creature.objectGuid) ?? 'object', creature.objectGuid);
      return nearestContact(best, creature);
    };
  }

  /**
   * Is there a clear line of fire from our character to `guid` for a bolt? The path the server flies one
   * ({@link boltLaunch}, ACE WorldObject_Magic): it spawns ahead of you at two thirds of your height, must see back to
   * your eye from there (IsProjectileVisible), then flies straight at the target's two-thirds point until it touches
   * the target. Both legs are swept through the same walls, terrain and solid objects (closed doors, …) our missiles
   * collide with; creatures other than the target are left out (they move, and a targeted bolt passes them). So an
   * obstacle hugging either body (a closed door you and a monster are both pressed against) blocks: the old
   * eye-to-target line skipped its first 0.6 m and stopped 0.7 m short of the target, and a skeleton clawing at the
   * mage through a timed door took its bolts in silence (2026-10-14). `blockedAt` is the ground distance (m) from you to where the bolt dies, null when it reaches the
   * target. null when the target or our body isn't known.
   */
  lineOfFire(guid: number, radius = DEFAULT_PROJECTILE_RADIUS): { dist: number; blockedAt: number | null; blocker?: string; beforeSpawn?: boolean; spawnAhead?: number; serverSpot?: { dist: number; dz: number } } | null {
    const o = this.objects.get(guid);
    const me = this.missileLocalPlayer?.();
    if (!o || !me || !this.missileEnvironmentSweep) return null;
    const shown = this.boltPathFrom(me, o, radius);
    if (shown.blockedAt !== null) return shown;
    // The server flies the bolt at the target where the SERVER has it. A creature whose MoveTo the client plays out on its
    // own can run far from the server's body: a Dread the server held on the floor 6 m over Arcanist ran down to her in
    // our view, so walk_to line=true "arrived (1.7 m away); the line of fire to it is open", the bolt that followed hit
    // nothing, and the next cast found it 12.9 m off and 6 m up (Mountain Keep 0x01D20200, 2026-10-17 20:32:06–17Z).
    // Split that far (a storey, or SERVER_SPLIT_M across), the line must be open to the server's spot as well.
    const sp = o.serverPlace;
    if (!sp || !Number.isFinite(sp.worldX) || !Number.isFinite(sp.worldZ)) return shown;
    const dz = sp.worldY - o.worldY;
    const across = Math.hypot(sp.worldX - o.worldX, sp.worldZ - o.worldZ);
    if (Math.abs(dz) < ServerObjectManager.SERVER_SPLIT_DZ_M && across < ServerObjectManager.SERVER_SPLIT_M) return shown;
    const there = this.boltPathFrom(me, { ...o, worldX: sp.worldX, worldY: sp.worldY, worldZ: sp.worldZ }, radius);
    if (there.blockedAt === null) return shown;
    return { ...there, serverSpot: { dist: Math.round(there.dist * 10) / 10, dz: Math.round((sp.worldY - me.z) * 10) / 10 } };
  }

  /**
   * How far the client's copy of a creature may stray from where the server last placed it before a line of fire is
   * checked to the server's spot too (m across; m up or down): a run between two of the server's position updates
   * stays inside these.
   */
  static readonly SERVER_SPLIT_M = 6;
  static readonly SERVER_SPLIT_DZ_M = 2.5;

  /**
   * {@link lineOfFire} as it would be with your body standing where `fromGuid` stands (a fellow): Arcanist got an open
   * line by walking to Bulwark after six of his 40 "no line of fire" refusals in Mountain Keep (2026-10-17 07:14–08:16Z),
   * while the 3 m open-spot search found a spot only once. null when either object or our body isn't known.
   */
  lineOfFireFrom(guid: number, fromGuid: number, radius = DEFAULT_PROJECTILE_RADIUS): { dist: number; blockedAt: number | null; blocker?: string } | null {
    const o = this.objects.get(guid);
    const at = this.objects.get(fromGuid);
    const me = this.missileLocalPlayer?.();
    if (!o || !at || !me || !this.missileEnvironmentSweep) return null;
    return this.boltPathFrom({ ...me, x: at.worldX, y: at.worldZ, z: at.worldY }, o, radius);
  }

  /**
   * {@link lineOfFire} from a caster body at `me` (feet, AC global metres). `beforeSpawn`: the blocker stands between
   * you and the spawn point (`spawnAhead` m out, ground distance): the bolt starts past it and can't see back to you
   * (ACE IsProjectileVisible), so stepping off the wall, not nearer the target, opens the line.
   */
  private boltPathFrom(me: { x: number; y: number; z: number; radius: number; height: number; physicsRadius?: number }, o: ServerObject, radius: number): { dist: number; blockedAt: number | null; blocker?: string; beforeSpawn?: boolean; spawnAhead?: number } {
    const feet = { x: o.worldX, y: o.worldZ, z: o.worldY };
    const dist = Math.hypot(feet.x - me.x, feet.y - me.y);
    const bolt = boltLaunch({
      from: { x: me.x, y: me.y, z: me.z }, to: feet,
      casterHeight: me.height, casterRadius: me.radius, casterPhysicsRadius: me.physicsRadius ?? me.radius,
      targetHeight: Math.max(o.collisionHeight, 0.6), targetRadius: Math.max(o.collisionRadius, 0), projectileRadius: radius,
    });
    const guid = o.guid;
    const ground = (a: V3, b: V3, t: number): number => Math.round(Math.hypot(a.x + (b.x - a.x) * t - me.x, a.y + (b.y - a.y) * t - me.y) * 10) / 10;
    // IsProjectileVisible: swept outward from your eye to the spawn point (a wall or door it crosses is met face on).
    const back = this.missileSegmentContact(bolt.eye, bolt.origin, radius, guid);
    if (back && back.t < 1) {
      const spawnAhead = Math.round(Math.hypot(bolt.origin.x - me.x, bolt.origin.y - me.y) * 10) / 10;
      return { dist, blockedAt: ground(bolt.eye, bolt.origin, back.t), blocker: this.missileBlockerName(back), beforeSpawn: true, spawnAhead };
    }
    // The flight, to the target's two-thirds point. A spawn point already inside the target hits at once (ACE's entry
    // collision). Otherwise an obstacle anywhere up to that point blocks, even one our copy of the target overlaps:
    // the server's target can't stand inside a closed door, so a door our view puts through its body is in front of
    // it (dungeon 0x0145's timed Door #70145010: our skeleton 0.1 m past the door's plane, its front already through it).
    if (this.missileTargetContact(o, bolt.origin, bolt.aim, radius) === 0) return { dist, blockedAt: null };
    const best = this.missileSegmentContact(bolt.origin, bolt.aim, radius, guid);
    if (!best || best.t >= 1) return { dist, blockedAt: null };
    return { dist, blockedAt: ground(bolt.origin, bolt.aim, best.t), blocker: this.missileBlockerName(best) };
  }

  /**
   * The nearest spot within `maxDist` m that you can step to in a straight line on your own floor and from which a
   * bolt reaches `guid` ({@link lineOfFire} from there): rings every 0.5 m, the 8 compass points (what walk_to's "1.5m northeast" takes), nearest ring first and, on a
   * ring, the bearing nearest the target's. `dx` / `dy` are metres east / north of you. null when there is none, or
   * the target or our body isn't known. For a refusal's advice only: the target may move meanwhile.
   */
  openLineSpot(guid: number, maxDist = 3, radius = DEFAULT_PROJECTILE_RADIUS): { dx: number; dy: number; dist: number } | null {
    const o = this.objects.get(guid);
    const me = this.missileLocalPlayer?.();
    if (!o || !me || !this.missileEnvironmentSweep) return null;
    const toTarget = Math.atan2(o.worldX - me.x, o.worldZ - me.y);
    // Your body's sphere (GetPhysicsRadius) at knee height for the step: a wall, pillar or closed door in the way stops it.
    const bodyR = Math.min(me.physicsRadius ?? me.radius, 0.48);
    const stepZ = me.z + bodyR + 0.25;
    for (let ring = 0.5; ring <= maxDist + 1e-6; ring += 0.5) {
      const bearings: number[] = [];
      for (let i = 0; i < 8; i++) bearings.push((i * Math.PI) / 4);
      const off = (b: number) => Math.abs(Math.atan2(Math.sin(b - toTarget), Math.cos(b - toTarget)));
      bearings.sort((a, b) => off(a) - off(b));
      for (const b of bearings) {
        const dx = Math.sin(b) * ring, dy = Math.cos(b) * ring;
        const at = { x: me.x + dx, y: me.y + dy };
        // The step there, clear of walls and solid objects.
        const step = this.missileSegmentContact({ x: me.x, y: me.y, z: stepZ }, { x: at.x, y: at.y, z: stepZ }, bodyR, guid);
        if (step && step.t < 1) continue;
        // Floor under it at about your height (no ledge or hole): a sphere dropped from above your knee lands on it.
        const top = me.z + 0.6, drop = 1.2, fr = 0.2;
        const floor = this.missileSegmentContact({ x: at.x, y: at.y, z: top }, { x: at.x, y: at.y, z: top - drop }, fr, guid);
        if (!floor || !floor.normal || floor.normal.z < 0.7) continue;
        const floorZ = top - drop * floor.t - fr;
        if (Math.abs(floorZ - me.z) > 0.5) continue;
        // A few cm of margin on the bolt: a line that only just grazes past a corner is no advice to walk to.
        if (this.boltPathFrom({ ...me, x: at.x, y: at.y, z: floorZ }, o, radius + ServerObjectManager.OPEN_SPOT_MARGIN).blockedAt === null) {
          return { dx: Math.round(dx * 10) / 10 || 0, dy: Math.round(dy * 10) / 10 || 0, dist: ring };
        }
      }
    }
    return null;
  }

  /**
   * How far along `from` → `to` (0..1) a missile sphere of `radius` first touches `o`'s own collision shape (its Setup
   * CylSpheres / Spheres × scale, else its bounding cylinder); 1 when it never does, 0 when it starts inside.
   */
  private missileTargetContact(o: ServerObject, from: V3, to: V3, radius: number): number {
    const shapes = (o.itemType & ItemType.Creature) && !(o.physicsState & PhysicsState.HasPhysicsBSP) ? this.creatureMissileShapes(o) : null;
    const cylinders = shapes ? shapes.cylinders
      : o.collisionRadius > 0 && o.collisionHeight > 0 ? [{ guid: o.guid, x: o.worldX, y: o.worldZ, z: o.worldY, radius: o.collisionRadius, height: o.collisionHeight }] : [];
    const hit = nearestContact(sweepCylinders(from, to, radius, cylinders), sweepSpheres(from, to, radius, shapes?.spheres ?? []));
    return hit ? hit.t : 1;
  }

  /**
   * The first wall, ground or solid object (creatures left out) a missile sphere of `radius` meets from `from` to `to`
   * (AC world axes), with the object's guid; `exclude` (the target) and our own body are not obstacles.
   */
  private missileSegmentContact(from: V3, to: V3, radius: number, exclude: number): MissileContact | null {
    if (!this.missileEnvironmentSweep) return null;
    let best: MissileContact | null = this.missileEnvironmentSweep(from, to, radius);
    const reach = Math.hypot(to.x - from.x, to.y - from.y) + radius;
    for (const s of this.objects.values()) {
      if (s.guid === exclude || s.guid === this.playerGuid || !s.mesh || s.wielderId || (s.itemType & ItemType.Creature)) continue;
      // Only objects in a cell: a held item (physics parent), one carried in a pack or a corpse, or one released out
      // of range has no place in the world for a bolt to hit (CPhysicsObj::set_parent / leave_world leave the cell).
      if (!ServerObjectManager.inWorldForMissiles(s)) continue;
      if (classifyMissileObstacle(s.physicsState, PhysicsState.Missile) === 'ignore' || !this.missileObjectSweep) continue;
      if (Math.hypot(s.worldX - from.x, s.worldZ - from.y) > reach + ServerObjectManager.MISSILE_OBJECT_REACH) continue;
      const hit = this.missileObjectSweep(s, from, to, radius);
      if (hit) best = nearestContact(best, { ...hit, objectGuid: s.guid });
    }
    return best;
  }

  /** What a missile contact is, as a player would see it: the object's name, else the wall / floor / ceiling its normal says. */
  private missileBlockerName(c: MissileContact): string {
    const n = c.normal;
    return c.objectGuid !== undefined ? (this.objects.get(c.objectGuid)?.name || 'an object')
      : n && Math.abs(n.z) > 0.7 ? (n.z < 0 ? 'the ceiling' : 'the floor or ground') : 'a wall';
  }

  /**
   * Would an arrow, bolt or thrown weapon reach `guid` from here? Unlike a bolt (which flies straight: lineOfFire), a
   * missile flies the server's arc ({@link missileArc}: ACE Player_Missile spawns it 2 × (your radius + its own) in
   * front of you at Height × 0.8454, tilted by the aim motion, and launches it on the low solve_ballistic_arc to the
   * target's Height / GetAimHeight). This samples that arc and sweeps each piece against the same walls, terrain and
   * solid objects lineOfFire does, plus the server's first check (WorldObject.IsProjectileVisible: from the spawn point
   * back to your eye, so a spawn point through a wall or over a lip is caught). `blockedAt` is the ground distance (m)
   * from you to the first contact, null when the arc reaches the target. `noArc`: no arc reaches it at this speed (the
   * server's "Out of Range!"). null when the target or our body isn't known.
   */
  missileArcOfFire(guid: number, shot: { speed: number; aim?: 'high' | 'medium' | 'low'; projectileRadius?: number }): { dist: number; blockedAt: number | null; blocker?: string; noArc?: boolean } | null {
    const o = this.objects.get(guid);
    const me = this.missileLocalPlayer?.();
    if (!o || !me || !this.missileEnvironmentSweep) return null;
    const radius = shot.projectileRadius ?? DEFAULT_PROJECTILE_RADIUS;
    const feet = { x: o.worldX, y: o.worldZ, z: o.worldY };
    const dist = Math.hypot(feet.x - me.x, feet.y - me.y);
    const arc = missileArc({
      // GetProjectileSpawnOrigin: your physics radius (the first collision sphere's), not the Setup radius.
      from: { x: me.x, y: me.y, z: me.z }, to: feet, speed: shot.speed, shooterHeight: me.height, shooterRadius: me.physicsRadius ?? me.radius,
      targetHeight: Math.max(o.collisionHeight, 0.6), aim: shot.aim ?? 'medium', projectileRadius: radius,
    });
    if (!arc) return { dist, blockedAt: null, noArc: true };
    const ground = (p: V3): number => Math.round(Math.hypot(p.x - me.x, p.y - me.y) * 10) / 10;
    // IsProjectileVisible: the spawn point must see you (at eye height less the projectile's own height).
    const eye = { x: me.x, y: me.y, z: me.z + me.height - radius * 2 };
    const back = this.missileSegmentContact(eye, arc.origin, radius, guid);
    if (back && back.t < 1) return { dist, blockedAt: ground({ x: eye.x + (arc.origin.x - eye.x) * back.t, y: eye.y + (arc.origin.y - eye.y) * back.t, z: 0 }), blocker: this.missileBlockerName(back) };
    // The arc, in pieces of about a metre, up to the target's surface (it is no obstacle to itself).
    const endOff = Math.max(o.collisionRadius, 0.3) + radius;
    const len = Math.hypot(arc.aim.x - arc.origin.x, arc.aim.y - arc.origin.y, arc.aim.z - arc.origin.z);
    if (len <= endOff) return { dist, blockedAt: null };
    const tEnd = arc.time * (1 - endOff / len);
    const n = Math.max(6, Math.ceil((len - endOff) / 1));
    let prev = arc.origin;
    for (let i = 1; i <= n; i++) {
      const p = missileArcPoint(arc, (tEnd * i) / n);
      const c = this.missileSegmentContact(prev, p, radius, guid);
      if (c && c.t < 1) return { dist, blockedAt: ground({ x: prev.x + (p.x - prev.x) * c.t, y: prev.y + (p.y - prev.y) * c.t, z: 0 }), blocker: this.missileBlockerName(c) };
      prev = p;
    }
    return { dist, blockedAt: null };
  }

  /**
   * Is there room `dist` metres ahead of our character along the compass
   * `headingDeg` (0 north, 90 east), at body height? The same walls, terrain
   * and solid objects {@link lineOfFire} sweeps (creatures left out). The
   * automation's pet summon asks it (VirindiTank checks 3 m of room before a
   * summon: the pet appears there). null when our body isn't known.
   */
  roomAhead(headingDeg: number, dist: number, radius = 0.4): boolean | null {
    const me = this.missileLocalPlayer?.();
    if (!me || !this.missileEnvironmentSweep) return null;
    const rad = (headingDeg * Math.PI) / 180;
    const u = { x: Math.sin(rad), y: Math.cos(rad), z: 0 };
    const startOff = me.radius + radius;
    const z = me.z + me.height * 0.5;
    const from = { x: me.x + u.x * startOff, y: me.y + u.y * startOff, z };
    const to = { x: from.x + u.x * dist, y: from.y + u.y * dist, z };
    let best = this.missileEnvironmentSweep(from, to, radius);
    for (const s of this.objects.values()) {
      if (s.guid === this.playerGuid || !s.mesh || s.wielderId || (s.itemType & ItemType.Creature)) continue;
      if (classifyMissileObstacle(s.physicsState, PhysicsState.Missile) === 'ignore' || !this.missileObjectSweep) continue;
      if (Math.hypot(s.worldX - from.x, s.worldZ - from.y) > dist + radius + ServerObjectManager.MISSILE_OBJECT_REACH) continue;
      best = nearestContact(best, this.missileObjectSweep(s, from, to, radius));
    }
    return !(best && best.t < 1);
  }

  /** openLineSpot's margin (m) on the bolt's radius: suggested spots clear corners by this much more than ACE needs. */
  static readonly OPEN_SPOT_MARGIN = 0.05;

  /** An object a missile can hit: in a cell (not held, carried, out of the world, or released out of range). */
  static inWorldForMissiles(o: ServerObject): boolean {
    return !o.outOfWorld && !o.lostCell;
  }

  /** Coarse cull for {@link missileObjectSweep}: no server object's collision reaches further than this (m) from its origin. */
  private static readonly MISSILE_OBJECT_REACH = 20;

  /** Check if an object is a tracked projectile. */
  isProjectile(guid: number): boolean {
    return this.projectiles.has(guid);
  }

  /**
   * VectorUpdate (0xF74E) — `SmartBox::DoVectorUpdate @ 004521c0`
   * (DECOMP.remote-vector-update): a VectorUpdate newer than the object's
   * VECTOR_TS sets its velocity (`set_velocity`, clamped to 50) and omega —
   * on ANY object: a peer's jump arc and a knockback fly on it
   * (world/RemotePhysics.ts), a missile corrects its flight (MissilePhysics;
   * ACE's SpellProjectile.ProjectileImpact sends VectorUpdate(0) to stop one).
   * AC axes. Returns true when it was applied.
   */
  applyVectorUpdate(
    guid: number, acVelX: number, acVelY: number, acVelZ: number,
    acOmegaX = 0, acOmegaY = 0, acOmegaZ = 0, vectorSequence?: number,
  ): boolean {
    const obj = this.objects.get(guid);
    if (!obj) return false;
    const isMissile = this.projectiles.has(guid) || (obj.physicsState & PhysicsState.Missile) !== 0;
    if (!isMissile) {
      const body = obj.physics;
      if (!body) return false;
      return body.receiveVector({ x: acVelX, y: acVelY, z: acVelZ }, { x: acOmegaX, y: acOmegaY, z: acOmegaZ }, vectorSequence);
    }
    // Require a mesh: a meshless missile is invisible, and registering it would
    // make updateProjectiles drop it on the next tick.
    if (!obj.mesh) return false;
    let body = this.projectiles.get(guid);
    if (!body) {
      const q = obj.mesh.quaternion; // THREE (x, y, z, w) = AC (−x, −z, −y, w)
      body = createMissileBody({
        pos: { x: obj.worldX, y: obj.worldZ, z: obj.worldY },
        vel: { x: 0, y: 0, z: 0 },
        orient: { w: q.w, x: -q.x, y: -q.z, z: -q.y },
        state: obj.physicsState,
      });
      this.projectiles.set(guid, body);
    }
    body.vel = { x: acVelX, y: acVelY, z: acVelZ };
    body.omega = { x: acOmegaX, y: acOmegaY, z: acOmegaZ };
    return true;
  }

  /** The missile body of a tracked projectile (AC axes) — probes and tests. */
  getMissileBody(guid: number): Readonly<MissileBody> | undefined {
    return this.projectiles.get(guid);
  }

  private buildMesh(data: CreateObjectData): THREE.Group | null {
    const partChanges = new Map<number, number>();
    for (const ap of data.animPartChanges) partChanges.set(ap.partIndex, ap.partId);

    // Group texture changes by partIndex — each change only applies to its specific part
    const perPartTextureOverrides = new Map<number, Map<number, number>>();
    for (const tc of data.textureChanges) {
      let partMap = perPartTextureOverrides.get(tc.partIndex);
      if (!partMap) {
        partMap = new Map<number, number>();
        perPartTextureOverrides.set(tc.partIndex, partMap);
      }
      partMap.set(tc.oldTexture, tc.newTexture);
    }

    let paletteColors: number[] | undefined;
    if (data.basePalette && data.subPalettes.length > 0) {
      const baseColors = this.appearanceManager.loadPaletteColors(data.basePalette);
      if (baseColors) {
        const composite = [...baseColors];
        const k = subPaletteScale(composite.length);
        for (const sp of data.subPalettes) {
          const colors = this.appearanceManager.loadPaletteColors(sp.paletteId);
          if (!colors) continue;
          const off = sp.offset * k, len = sp.length * k;
          for (let i = 0; i < len && (off + i) < composite.length; i++) {
            if ((off + i) < colors.length) {
              composite[off + i] = colors[off + i];
            }
          }
        }
        paletteColors = composite;
      }
    }

    // BUG.createobject-movement-placement-skipped — pass the PhysicsDesc
    // AnimationFrame Placement uint (sent when the object has no
    // CurrentMotionState) as the placement-frame key; getPartPlacements
    // falls back to key 0 (Default) on a miss, matching ACE
    // PartArray.SetPlacementFrame. Without one the object keeps the Resting
    // frame InitObjectEnd set (PLACEMENT_RESTING).
    return this.setupModelRenderer.createSetupMeshWithOverrides(
      data.setupId,
      data.placement ?? PLACEMENT_RESTING,
      partChanges.size > 0 ? partChanges : undefined,
      perPartTextureOverrides.size > 0 ? perPartTextureOverrides : undefined,
      paletteColors,
    );
  }
}

/**
 * SWEEP1006 action stamps — move_to_interpreted_state's wrap-aware 15-bit
 * comparison: within half the range (0x4000) the larger stamp is newer,
 * otherwise the smaller (it wrapped).
 */
export function isServerActionNewer(stamp: number, last: number): boolean {
  const a = stamp & 0x7fff, b = last & 0x7fff;
  const diff = a > b ? a - b : b - a;
  return diff < 0x4000 ? b < a : a < b;
}
