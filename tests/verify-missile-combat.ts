/**
 * GAP.10 — missile combat: range gate + self aim/reload motions + ammo
 * stack tracking.
 *
 * ACE ground truth:
 *  - Creature_Missile.cs:402-433 GetMaxMissileRange: range =
 *    min(MaximumVelocity² × 0.1020408163265306, 85yd / 1.094) with
 *    DefaultMaxVelocity = 20; enforced at Player_Missile.cs:172
 *    TargetInRange → WeenieError.MissileOutOfRange.
 *  - Player_Missile.cs:227/:265 — the aim (GetAimLevel z-band motion,
 *    wire 0x1e-0x2a) and Reload (0x16) play as persistent forward
 *    commands broadcast to everyone INCLUDING the owner; the client's
 *    local-player guard must let these through or the own-client never
 *    sees its own aim/reload. They are SUBSTATES, so they go to
 *    setForwardMotion — as one-shot actions the reload snapped back at
 *    frame 22 (BUG.missile-aim-reload-played-as-actions; the real-DAT
 *    playback is verify-missile-aim-reload-substates.ts).
 *  - UpdateAmmoAfterLaunch → GameMessageSetStackSize keeps the equipped
 *    ammo stack fresh; client-side the inventory item object is shared
 *    with the equipment slot, so a stack update through the inventory
 *    handler must be visible on the equipped slot.
 */
import { describe, it, expect } from 'vitest';
import {
  getMaxMissileRange, MISSILE_RANGE_CAP, DEFAULT_MAX_VELOCITY, METERS_TO_YARDS,
} from '../packages/shared/src/combat/MissileRange.js';
import { canFireMissile, isAmmoLauncherCombatStyle } from '../packages/shared/src/combat/MissileAmmo.js';
import { canAttackTarget } from '../packages/shared/src/combat/AttackTargetGate.js';
import { CombatStyle } from '../packages/shared/src/ace-enums.js';

describe('GAP.10 — max missile range (Creature_Missile.cs:406)', () => {
  it('default velocity 20 → 40.816m; null/undefined use the default', () => {
    const expected = 20 * 20 * 0.1020408163265306;
    expect(getMaxMissileRange(null)).toBeCloseTo(expected, 6);
    expect(getMaxMissileRange(undefined)).toBeCloseTo(expected, 6);
    expect(getMaxMissileRange(DEFAULT_MAX_VELOCITY)).toBeCloseTo(expected, 6);
    expect(expected).toBeCloseTo(40.81632653061224, 8);
  });

  it('caps at 85 yards (≈77.697m) for fast weapons', () => {
    expect(MISSILE_RANGE_CAP).toBeCloseTo(85.0 / METERS_TO_YARDS, 8);
    expect(getMaxMissileRange(40)).toBeCloseTo(MISSILE_RANGE_CAP, 6); // 163m uncapped → capped
    expect(getMaxMissileRange(100)).toBeCloseTo(MISSILE_RANGE_CAP, 6);
  });

  it('sub-cap velocities scale quadratically', () => {
    expect(getMaxMissileRange(10)).toBeCloseTo(100 * 0.1020408163265306, 8);
    expect(getMaxMissileRange(27)).toBeCloseTo(27 * 27 * 0.1020408163265306, 6);
  });
});

// Build a MovementEvent buffer: 6-byte header + type/options/style +
// InterpretedMotionState with only ForwardCommand set.
function movementBuffer(styleIndex: number, forwardCmd: number): Uint8Array {
  const buf = new Uint8Array(6 + 4 + 4 + 2 + 2); // header + unpack + bitfield + fwd + pad
  const view = new DataView(buf.buffer);
  let o = 6;               // header (timestamps + autonomous + pad)
  view.setUint8(o, 0); o += 1;        // movement_type 0 = InterpretedMotionState
  view.setUint8(o, 0); o += 1;        // options
  view.setUint16(o, styleIndex, true); o += 2; // outer style
  view.setUint32(o, 0x2, true); o += 4;        // bitfield: ForwardCommand only
  view.setUint16(o, forwardCmd, true); o += 2;
  return buf;
}

describe('GAP.10 — self aim/reload motions pass the local-player guard', () => {
  async function makeSOM() {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
    const queued: Array<{ key: unknown; speed: number }> = [];
    const forward: unknown[] = [];
    const mm = {
      queueAction: (key: unknown, speed: number) => queued.push({ key, speed }),
      setForwardMotion: (key: unknown) => forward.push(key),
      setStanceFromId: () => {},
      isPlayingAction: false,
      currentStyleId: 0,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    som.registerAnimatedEntity(0x50000001, { motionManager: mm } as any, true); // local player
    return { som, queued, forward };
  }

  const BOW_STANCE_INDEX = 0x3f; // BowCombat = 0x8000003f

  it('Reload (0x16) and aim motions (0x1e-0x2a) are substates for the local player, not one-shot actions', async () => {
    const { som, queued, forward } = await makeSOM();
    som.handleMovementEvent({ guid: 0x50000001, movementData: movementBuffer(BOW_STANCE_INDEX, 0x16) } as never);
    som.handleMovementEvent({ guid: 0x50000001, movementData: movementBuffer(BOW_STANCE_INDEX, 0x22) } as never); // AimHigh60
    expect(queued.length).toBe(0);
    expect(forward).toEqual([(0x3f << 16) | 0x16, (0x3f << 16) | 0x22]);
  });

  it('locomotion forward commands are still skipped for the local player (anti-stutter guard intact)', async () => {
    const { som, queued, forward } = await makeSOM();
    som.handleMovementEvent({ guid: 0x50000001, movementData: movementBuffer(BOW_STANCE_INDEX, 0x05) } as never); // RunForward-ish wire index
    expect(queued.length).toBe(0);
    expect(forward.length).toBe(0);
  });

  it('non-local creatures still get forward motions applied', async () => {
    const { som, forward } = await makeSOM();
    const mm2 = {
      queueAction: () => {}, setForwardMotion: (k: unknown) => forward.push(k),
      setStanceFromId: () => {}, isPlayingAction: false, currentStyleId: 0,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).registerAnimatedEntity(0x60000002, { motionManager: mm2 } as any, false);
    som.handleMovementEvent({ guid: 0x60000002, movementData: movementBuffer(BOW_STANCE_INDEX, 0x05) } as never);
    expect(forward.length).toBe(1);
  });
});

describe('GAP.88 — canFireMissile mirrors Player_Missile.cs:84-88 silent weapon/ammo rejection', () => {
  it('no weapon equipped → cannot fire regardless of combat style or ammo', () => {
    expect(canFireMissile(false, CombatStyle.Bow, true)).toBe(false);
    expect(canFireMissile(false, CombatStyle.Undef, false)).toBe(false);
  });

  it('bow/crossbow/atlatl require ammo', () => {
    expect(canFireMissile(true, CombatStyle.Bow, false)).toBe(false);
    expect(canFireMissile(true, CombatStyle.Crossbow, false)).toBe(false);
    expect(canFireMissile(true, CombatStyle.Atlatl, false)).toBe(false);
    expect(canFireMissile(true, CombatStyle.Bow, true)).toBe(true);
    expect(canFireMissile(true, CombatStyle.Crossbow, true)).toBe(true);
    expect(canFireMissile(true, CombatStyle.Atlatl, true)).toBe(true);
  });

  it('thrown weapons need no separate ammo slot (IsAmmoLauncher excludes ThrownWeapon per WorldObject.cs:78-81)', () => {
    expect(canFireMissile(true, CombatStyle.ThrownWeapon, false)).toBe(true);
    expect(isAmmoLauncherCombatStyle(CombatStyle.ThrownWeapon)).toBe(false);
  });

  it('sling is NOT classified as an ammo launcher per ACE WorldObject.cs:78-80 (IsBow checks Bow/Crossbow only)', () => {
    expect(isAmmoLauncherCombatStyle(CombatStyle.Sling)).toBe(false);
    expect(canFireMissile(true, CombatStyle.Sling, false)).toBe(true);
  });

  it('unknown/zero combat style (weenie data not loaded) does not require ammo', () => {
    expect(canFireMissile(true, 0, false)).toBe(true);
  });
});

describe('GAP.88 — canAttackTarget mirrors Player_Melee.cs:103-131 / Player_Missile.cs:97-103 silent target-resolution gate', () => {
  it('a missing target guid is never attackable', () => {
    expect(canAttackTarget(false, false, false)).toBe(false);
    expect(canAttackTarget(false, true, false)).toBe(false);
  });

  it('a resolved non-creature object (e.g. a corpse container, a static) is never attackable', () => {
    expect(canAttackTarget(true, false, false)).toBe(false);
  });

  it('a dying/dead creature is never attackable even though it still resolves as a creature', () => {
    expect(canAttackTarget(true, true, true)).toBe(false);
  });

  it('a live, resolved creature target passes the gate', () => {
    expect(canAttackTarget(true, true, false)).toBe(true);
  });
});

describe('GAP.88 — ServerObjectManager.isDying tracks the Dead motion wire event (0x0011)', () => {
  it('a creature that plays the Dead cycle becomes isDying(guid) === true', async () => {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
    const mm = {
      queueAction: () => {}, setForwardMotion: () => {}, playDeath: () => {},
      setStanceFromId: () => {}, isPlayingAction: false, currentStyleId: 0,
    };
    const guid = 0x60000042;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    som.registerAnimatedEntity(guid, { motionManager: mm } as any, false);
    expect(som.isDying(guid)).toBe(false);

    som.handleMovementEvent({ guid, movementData: movementBuffer(0, 0x0011) } as never); // MotionCommand.Dead low 16 bits
    expect(som.isDying(guid)).toBe(true);
  });

  // BUG.dying-creature-loses-collision — CPhysicsObj::FindObjCollisions
  // @ 0050f050 has no motion/death test and ACE sets no Ethereal on death:
  // the falling creature blocks and stops missiles until its DeleteObject.
  it('a creature playing Dead keeps its collision (still a blocker); isDying only gates targeting', async () => {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const THREE = await import('three');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (som as any).buildMesh = () => { const g = new THREE.Group(); const p = new THREE.Group(); p.name = 'part_0'; g.add(p); return g; };
    const guid = 0x60000043;
    const obj = som.createObject({
      guid, name: 'Drudge', weenieClassId: 1, itemType: 0x10 /* Creature */,
      position: { landblock: 0xA9B40017, x: 100, y: 120, z: 12, rw: 1, rx: 0, ry: 0, rz: 0 },
      setupId: 0x02000999, motionTableId: 0, iconId: 0, physicsState: 0, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
      basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [],
      containerId: 0, wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0,
      stackSize: 0, maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, useRadius: 0.6,
      velocityX: 0, velocityY: 0, velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0,
      defaultScript: 0, defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0, cooldownId: 0, cooldownDuration: 0,
    } as never)!;
    obj.blockRadius = 0.5; obj.collisionRadius = 0.5; obj.collisionHeight = 1.8;
    const mm = { queueAction: () => {}, setForwardMotion: () => {}, playDeath: () => {}, setStanceFromId: () => {}, isPlayingAction: false, currentStyleId: 0 };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    som.registerAnimatedEntity(guid, { motionManager: mm } as any, false);
    som.handleMovementEvent({ guid, movementData: movementBuffer(0, 0x0011) } as never);
    expect(som.isDying(guid)).toBe(true);
    expect(obj.blockRadius).toBe(0.5);
    expect(obj.collisionHeight).toBe(1.8);
    expect(som.getBlockersNear(obj.worldX, obj.worldZ, 5).map((b) => b.guid)).toContain(guid);
  });

  it('isDying is false for a guid with no death event and for an unknown guid', async () => {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager({} as any, {} as any, { add: () => {}, remove: () => {} } as any);
    expect(som.isDying(0xdeadbeef)).toBe(false);
  });
});

describe('GAP.10 — equipped ammo stack tracks SetStackSize through the shared item object', () => {
  it('stack update via the inventory item is visible on the equipment slot', async () => {
    const { PlayerState } = await import('../packages/renderer/src/player/PlayerState.js');
    const { EquipMask } = await import('@ac/shared');
    const ps = new PlayerState();
    const arrows = {
      weenieClassId: 300, name: 'Arrow', stackSize: 250, stackable: true,
      maxStackSize: 250, burden: 50, value: 1, equipMask: EquipMask.MissileAmmo,
      validLocations: EquipMask.MissileAmmo, itemType: 256, containerId: 0,
    };
    // Same flow as the CreateObject handler: addItem with the server guid,
    // then equip the SAME object from inventory.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const id = ps.inventory.addItem(arrows as any, 0x70001234);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ps.equipment.equipItem(ps.inventory.getItem(id) as any, EquipMask.MissileAmmo);
    // The onSetStackSize handler path: equipment.updateStackSize (the
    // equipped map stores a COPY — this was the stale-ammo defect) plus the
    // inventory object update.
    const updated = ps.equipment.updateStackSize(id, 249);
    expect(updated).toBe(true);
    const invItem = ps.inventory.getItem(id)!;
    invItem.stackSize = 249;
    expect(ps.equipment.getSlot(EquipMask.MissileAmmo)?.stackSize).toBe(249);
    expect(ps.equipment.updateStackSize(0xdeadbeef, 5)).toBe(false);
  });
});
