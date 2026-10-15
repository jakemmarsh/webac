/**
 * BUG.recall-replays-on-arrival — another player's lifestone recall played
 * again when they arrived at the lifestone.
 *
 * The observer queues the recall action from the recaller's MovementEvent.
 * When the observer goes into portal space itself (a fellowship recalling
 * together), the recaller's object has no cell on its client and the
 * sequence stands still (CPhysicsObj::update_object), so the action was
 * still pending when the recaller reappeared and played from where it froze.
 *
 * Retail: ACE hides a teleporting player (Player.DoTeleportPhysicsStateChanges
 * → Hidden) and unhides it on arrival (OnTeleportComplete). CPhysicsObj::
 * set_state @ 00514dd0 calls set_hidden on each Hidden edge, and
 * CPhysicsObj::set_hidden @ 00514c60 ends both branches with
 * CPartArray::RemoveLinkAnimations: the leftover action is dropped.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { PhysicsState } from '@ac/shared';
import type { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand, MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

const RECALLER = 0x500000d9;
const HUMAN_MOTION_TABLE = 0x09000001;

function data(guid: number, physicsState: number) {
  return {
    guid, name: 'Recaller', weenieClassId: 1, itemType: 0x10, position: null, setupId: 0x02000001,
    motionTableId: 0, iconId: 0, physicsState, objectDescFlags: 0, radarColor: 0, radarBehavior: 0,
    basePalette: 0, subPalettes: [], textureChanges: [], animPartChanges: [], containerId: 0,
    wielderId: 0, currentWieldedLocation: 0, parentLocation: 0, validLocations: 0, stackSize: 0,
    maxStackSize: 0, value: 0, burden: 0, uiEffects: 0, usable: 0, velocityX: 0, velocityY: 0,
    velocityZ: 0, soundTableId: 0, objScale: 1, translucency: 0, defaultScript: 0,
    defaultScriptIntensity: 1, iconOverlayId: 0, iconUnderlayId: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function som(): ServerObjectManager {
  const setupModelRenderer = {
    createSetupMeshWithOverrides: () => new THREE.Group().add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshBasicMaterial())),
    loadSetupModel: () => null,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new ServerObjectManager(setupModelRenderer as any, { loadPaletteColors: () => null } as any, new THREE.Scene());
}

describe('a Hidden edge drops the link animations (set_hidden → RemoveLinkAnimations)', () => {
  function withSpy() {
    const m = som();
    m.createObject(data(RECALLER, PhysicsState.Gravity));
    let removed = 0;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    m.registerAnimatedEntity(RECALLER, { motionManager: { removeAllLinkAnimations: () => { removed++; } } } as any);
    return { m, removed: () => removed };
  }

  it('on the teleport hide and on the arrival unhide, once each', () => {
    const { m, removed } = withSpy();
    m.setPhysicsState(RECALLER, PhysicsState.Gravity | PhysicsState.Hidden | PhysicsState.IgnoreCollisions, 1);
    expect(removed()).toBe(1);
    m.setPhysicsState(RECALLER, PhysicsState.Gravity | PhysicsState.ReportCollisions, 2);
    expect(removed()).toBe(2);
  });

  it('not on a state change that leaves Hidden alone, nor on a stale one', () => {
    const { m, removed } = withSpy();
    m.setPhysicsState(RECALLER, PhysicsState.Gravity | PhysicsState.IgnoreCollisions, 5);
    m.setPhysicsState(RECALLER, PhysicsState.Gravity | PhysicsState.Hidden, 4);
    expect(removed()).toBe(0);
  });
});

const hasDat = existsSync(DAT_PATHS.portal);

describe.skipIf(!hasDat)('the recall frozen in portal space does not replay on arrival (human motion table)', () => {
  let portal: DatDatabase;
  beforeAll(() => { portal = openDat(DAT_PATHS.portal); });

  function recallingObserverView() {
    const m = som();
    m.createObject(data(RECALLER, PhysicsState.Gravity));
    const mm = new MotionManager(portal);
    expect(mm.loadMotionTable(HUMAN_MOTION_TABLE)).toBeTruthy();
    mm.setDefaultStance(1.0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    m.registerAnimatedEntity(RECALLER, { motionManager: mm } as any);
    mm.queueAction(MotionManager.compositeKey(MotionStance.NonCombat, MotionCommand.LifestoneRecall & 0xFFFF), 1.0);
    expect(mm.isPlayingAction).toBe(true);
    return { m, mm };
  }

  it('the teleport hide ends the pending recall: the recaller stands at Ready', () => {
    const { m, mm } = recallingObserverView();
    m.setPhysicsState(RECALLER, PhysicsState.Gravity | PhysicsState.Hidden | PhysicsState.IgnoreCollisions, 1);
    expect(mm.isPlayingAction).toBe(false);
    expect(mm.motionsPending).toBe(false);
    expect(mm.targetSubstate & 0xFFFF).toBe(MotionCommand.Ready & 0xFFFF);
    // Arrival: still nothing to play.
    m.setPhysicsState(RECALLER, PhysicsState.Gravity | PhysicsState.ReportCollisions, 2);
    expect(mm.isPlayingAction).toBe(false);
  });

  it('a state change without a Hidden edge leaves the recall playing', () => {
    const { m, mm } = recallingObserverView();
    m.setPhysicsState(RECALLER, PhysicsState.Gravity | PhysicsState.IgnoreCollisions, 1);
    expect(mm.isPlayingAction).toBe(true);
  });
});
