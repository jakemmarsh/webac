/**
 * BUG.respawn-corpse-pose (Jake on the AC1999 world, 2026-10-07): after a
 * fall death the character respawned at the lifestone drawn as a corpse,
 * walking around lying down.
 *
 * The AC1999 server's Revive (WeenieObject.cpp) re-sends Dead with the
 * lifestone position (0xF619, split by the adapter into 0xF748 + an 0xF74C
 * Dead), then StopCompletely + the peace stance (an 0xF74C with no forward
 * command), then the vitals. Our client stood the player up only when the
 * Health came back (CharacterAnimController.revive), and applied no other
 * server movement to its own character: when the vitals were applied before
 * the late Dead, the Dead held the body for good. Retail applies a
 * non-autonomous server movement to the player (CPhysics::SetObjectMovement
 * @ 00509690), so the server's stand-up leaves Dead. GetObjectSequence
 * would play link(Dead → Ready), but the human table has links into Dead
 * and none out of it, so the body goes straight to the Ready cycle.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import * as THREE from 'three';
import { AnimatedEntity } from '../packages/renderer/src/animation/AnimatedEntity.js';
import { CharacterAnimController } from '../packages/renderer/src/animation/CharacterAnimController.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand, MotionStance } from '../packages/renderer/src/animation/MotionCommands.js';
import { openDat } from './_harness/dat.js';

const DEAD_WIRE = MotionCommand.Dead & 0xffff;
const READY_WIRE = MotionCommand.Ready & 0xffff;
const NONCOMBAT_WIRE = MotionStance.NonCombat & 0xffff;

/** An 0xF74C body: header (autonomous at byte 4), then an InterpretedMotionState with a style and an optional forward command. */
function motionEvent(guid: number, forwardWire: number | null, autonomous = false): { guid: number; movementData: Uint8Array } {
  const flags = 0x1 | (forwardWire !== null ? 0x2 : 0);
  const bytes = [0, 0, 0, 0, autonomous ? 1 : 0, 0, 0x00, 0x00, NONCOMBAT_WIRE & 0xff, NONCOMBAT_WIRE >> 8,
    flags, 0, 0, 0, NONCOMBAT_WIRE & 0xff, NONCOMBAT_WIRE >> 8];
  if (forwardWire !== null) bytes.push(forwardWire & 0xff, forwardWire >> 8);
  while (bytes.length % 4 !== 0) bytes.push(0);
  return { guid, movementData: new Uint8Array(bytes) };
}

const hasDat = fs.existsSync('dat/client_portal.dat');

describe.skipIf(!hasDat)('the server stands our own character back up after a death (human table 0x09000001)', () => {
  let db: unknown;
  beforeAll(() => { db = openDat('dat/client_portal.dat'); });

  async function setup(local: boolean) {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const som = new ServerObjectManager({} as never, {} as never, { add: () => {}, remove: () => {} } as never);
    const group = new THREE.Group();
    const part = new THREE.Object3D(); part.name = 'part_0'; group.add(part);
    const entity = new AnimatedEntity(group, db as never);
    expect(entity.initFromMotionTable(0x09000001)).toBe(true);
    entity.motionManager.setStanceFromId(MotionStance.NonCombat);
    const guid = 0x50000001;
    som.registerAnimatedEntity(guid, entity, local);
    return { som, mm: entity.motionManager, guid };
  }

  it('the 1999 respawn order: Dead at the lifestone, then a stand-up with no forward command → alive, in the Ready cycle', async () => {
    const { som, mm, guid } = await setup(true);
    som.handleMovementEvent(motionEvent(guid, DEAD_WIRE) as never);
    mm.removeAllLinkAnimations();
    expect(mm.isDead).toBe(true);

    som.handleMovementEvent(motionEvent(guid, null) as never);
    expect(mm.isDead).toBe(false);
    expect(mm.targetSubstate & 0xffff).toBe(READY_WIRE);
    // No link out of Dead in the human table: straight to the Ready cycle.
    const links = mm.activeMotionTable!.links;
    expect([...links.keys()].some((k) => (k & 0xffff) === DEAD_WIRE)).toBe(false);
    for (let i = 0; i < 300; i++) som.updateAnimations(1 / 30);
    expect(mm.isDead).toBe(false);
    expect(mm.stance & 0xffff).toBe(READY_WIRE);
  });

  it('an explicit Ready stands up the same way', async () => {
    const { som, mm, guid } = await setup(true);
    som.handleMovementEvent(motionEvent(guid, DEAD_WIRE) as never);
    som.handleMovementEvent(motionEvent(guid, READY_WIRE) as never);
    expect(mm.isDead).toBe(false);
  });

  it('an autonomous echo of our own movement does not', async () => {
    const { som, mm, guid } = await setup(true);
    som.handleMovementEvent(motionEvent(guid, DEAD_WIRE) as never);
    som.handleMovementEvent(motionEvent(guid, null, true) as never);
    expect(mm.isDead).toBe(true);
  });

  it('another creature that died stays a corpse (its corpse is a new object)', async () => {
    const { som, mm, guid } = await setup(false);
    som.handleMovementEvent(motionEvent(guid, DEAD_WIRE) as never);
    som.handleMovementEvent(motionEvent(guid, null) as never);
    expect(mm.isDead).toBe(true);
  });
});

describe('CharacterAnimController.revive leaves a body the server already stood up alone', () => {
  function stub(dead: boolean) {
    const calls: string[] = [];
    let isDead = dead;
    return {
      calls,
      get isDead() { return isDead; },
      revive() { calls.push('revive'); isDead = false; },
      setStanceFromId(id: number) { calls.push(`stance ${id.toString(16)}`); return true; },
    };
  }

  it('Health back while the body is still dead: snap to the stance (ACE: the vitals come after the stand-up, which is in portal space)', () => {
    const s = stub(true);
    const c = new CharacterAnimController(s as unknown as MotionManager);
    c.markDead();
    c.revive();
    expect(s.calls).toEqual(['revive', `stance ${(MotionStance.NonCombat >>> 0).toString(16)}`]);
  });

  it('Health back after the server already stood us up: no second stance request', () => {
    const s = stub(false);
    const c = new CharacterAnimController(s as unknown as MotionManager);
    c.markDead();
    c.revive();
    expect(s.calls).toEqual([]);
  });
});
