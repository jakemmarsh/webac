/**
 * BUG.remote-stop-without-style — "a couple of other players never stop
 * moving their feet" (Jake on Coldeve, 2026-10-04).
 *
 * The retail client packs CurrentStyle into its MoveToState only when the
 * style is not NonCombat (RawMotionState::Pack @ 0051ed10), so ACE's
 * MovementData(Creature, MoveToState) leaves CurrentStyle 0 and broadcasts a
 * peace-mode player's stop as an UpdateMotion with style 0 and an empty
 * InterpretedMotionState (no forward command = Ready). Retail applies the
 * whole state anyway (MovementManager::unpack_movement @ 00524440 →
 * CMotionInterp::move_to_interpreted_state @ 005289c0). We only settled a
 * stop that named a style, so a retail player who stopped kept walking in
 * place (and sliding on the walk's velocity) on our screen.
 *
 * Drives the real ServerObjectManager with UpdateMotion bytes in ACE's
 * write order (InterpretedMotionState.Write).
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { ServerObjectManager } from '../packages/renderer/src/world/ServerObjectManager.js';
import { MotionManager } from '../packages/renderer/src/animation/MotionManager.js';
import { MotionCommand } from '../packages/renderer/src/animation/MotionCommands.js';
import { PhysicsState } from '@ac/shared';
import type { CreateObjectData } from '@ac/network';

const STYLE = 0x8000003d;
const key = (m: number) => MotionManager.compositeKey(STYLE, m);
const LB = 0xA9B40017;

function table() {
  const cyc = (bitfield: number, extra: object = {}) => ({ numAnims: 1, bitfield, flags: 0, anims: [], ...extra });
  return {
    defaultStyle: STYLE,
    styleDefaults: new Map([[STYLE, MotionCommand.Ready]]),
    cycles: new Map<number, object>([
      [key(MotionCommand.Ready), cyc(0)],
      [key(MotionCommand.WalkForward), cyc(0)],
      [key(MotionCommand.RunForward), cyc(0)],
      [key(MotionCommand.TurnRight), cyc(2, { omega: { x: 0, y: 0, z: -1.5 } })],
      [key(MotionCommand.SideStepRight), cyc(2)],
    ]),
    modifiers: new Map<number, object>([
      [MotionCommand.TurnRight & 0xfffff, cyc(0, { omega: { x: 0, y: 0, z: -1.5 } })],
      [MotionCommand.SideStepRight & 0xfffff, cyc(0, { velocity: { x: 1.25, y: 0, z: 0 } })],
    ]),
    links: new Map(),
  };
}

function rig() {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const som = new ServerObjectManager({ loadSetupModel: () => ({ radius: 0.5, height: 1.8, cylSpheres: [], spheres: [] }) } as any, {} as any, { add: () => {}, remove: () => {} } as any);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (som as any).buildMesh = () => new THREE.Group();
  som.setPlayerGuid(0x50000001);
  som.setTerrainCollision({ getHeightAt: () => 10 } as never);
  som.localPlayerPosition = () => ({ x: 0xa9 * 192 + 100, z: 0xb4 * 192 + 110, y: 10, radius: 0.45, height: 1.8 });
  const guid = 0x50000099;
  som.createObject({
    guid, name: 'Retail Player', weenieClassId: 1, itemType: 0x10, setupId: 0x02000001, motionTableId: 0,
    position: { landblock: LB, x: 100, y: 100, z: 10, rw: 1, rx: 0, ry: 0, rz: 0 },
    physicsState: PhysicsState.Gravity, timestamps: [1, 1, 1, 1, 1, 1, 1, 1, 1],
    subPalettes: [], textureChanges: [], animPartChanges: [], objScale: 1, useRadius: 0.6,
  } as unknown as CreateObjectData);
  const played: number[] = [];
  const snaps: number[] = [];
  const mm = {
    activeMotionTable: table(), currentStyleId: STYLE, isPlayingAction: false, isChangingStyle: false, motion: 0,
    setForwardMotion: (k: number) => { played.push(k); return true; },
    setStanceFromId: () => { snaps.push(1); return true; }, changeStyle: () => true, queueAction: () => {}, playDeath: () => true,
    targetSubstate: 0, isDead: false, removeLinkAnimations: () => {},
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  som.registerAnimatedEntity(guid, { motionManager: mm, update: () => {} } as any);
  return { som, guid, played, snaps, obj: som.getObject(guid)! };
}

/**
 * 0xF74C body as ACE writes it for a retail client's MoveToState: 6-byte
 * header, type 0, options, header style (0 = none), then the
 * InterpretedMotionState flags and its u16 commands / f32 speeds.
 */
function motion(opts: { style?: number; fwd?: number; fwdSpeed?: number; side?: number; sideSpeed?: number; turn?: number; turnSpeed?: number } = {}): Uint8Array {
  const bytes: number[] = [0, 0, 0, 0, 1, 0, 0, 0];
  const push16 = (v: number) => bytes.push(v & 0xff, (v >> 8) & 0xff);
  const pushF = (v: number) => bytes.push(...new Uint8Array(new Float32Array([v]).buffer));
  push16(opts.style ?? 0);
  let flags = 0;
  if (opts.style) flags |= 0x1;
  if (opts.fwd !== undefined) flags |= 0x2;
  if (opts.side !== undefined) flags |= 0x8;
  if (opts.turn !== undefined) flags |= 0x20;
  if (opts.fwdSpeed !== undefined) flags |= 0x4;
  if (opts.sideSpeed !== undefined) flags |= 0x10;
  if (opts.turnSpeed !== undefined) flags |= 0x40;
  bytes.push(...new Uint8Array(new Uint32Array([flags]).buffer));
  if (opts.style) push16(opts.style);
  if (opts.fwd !== undefined) push16(opts.fwd & 0xffff);
  if (opts.side !== undefined) push16(opts.side & 0xffff);
  if (opts.turn !== undefined) push16(opts.turn & 0xffff);
  if (opts.fwdSpeed !== undefined) pushF(opts.fwdSpeed);
  if (opts.sideSpeed !== undefined) pushF(opts.sideSpeed);
  if (opts.turnSpeed !== undefined) pushF(opts.turnSpeed);
  return new Uint8Array(bytes);
}

const frames = (som: ServerObjectManager, seconds: number, dt = 1 / 60) => { for (let i = 0; i < seconds / dt; i++) som.updateAnimations(dt); };

describe('BUG.remote-stop-without-style — a retail player\'s stop (style 0, no commands) settles on Ready', () => {
  it('run → stop: the Ready cycle plays and the motion state is Ready', () => {
    const { som, guid, played, obj } = rig();
    som.handleMovementEvent({ guid, movementData: motion({ fwd: MotionCommand.RunForward, fwdSpeed: 2.5 }) } as never);
    expect(played.at(-1)).toBe(key(MotionCommand.RunForward));
    som.handleMovementEvent({ guid, movementData: motion() } as never);
    expect(played.at(-1)).toBe(key(MotionCommand.Ready));
    expect(obj.motionState?.forward).toBe(MotionCommand.Ready);
  });

  it('strafe → stop and turn → stop settle too, and the object stops turning', () => {
    const { som, guid, played, obj } = rig();
    som.handleMovementEvent({ guid, movementData: motion({ side: MotionCommand.SideStepRight, sideSpeed: 1.25 }) } as never);
    expect(played.at(-1)).toBe(key(MotionCommand.SideStepRight));
    som.handleMovementEvent({ guid, movementData: motion() } as never);
    expect(played.at(-1)).toBe(key(MotionCommand.Ready));
    som.handleMovementEvent({ guid, movementData: motion({ turn: MotionCommand.TurnRight, turnSpeed: 1 }) } as never);
    expect(played.at(-1)).toBe(key(MotionCommand.TurnRight));
    som.handleMovementEvent({ guid, movementData: motion() } as never);
    expect(played.at(-1)).toBe(key(MotionCommand.Ready));
    const h0 = obj.physics!.heading;
    frames(som, 0.5);
    expect(obj.physics!.heading).toBeCloseTo(h0, 6);
  });

  // SWEEP1006 same-style stop — move_to_interpreted_state @ 005289c0: the
  // style DoInterpretedMotion is a no-op for the current style and the absent
  // forward command is Ready, which plays through its link (a swing or emote
  // in progress is kept). Pre-fix setStanceFromId snapped it to the idle cycle.
  it('a live stop that names the CURRENT style settles on Ready through its link, no snap', () => {
    const { som, guid, played, snaps } = rig();
    som.handleMovementEvent({ guid, movementData: motion({ style: 0x3d, fwd: MotionCommand.RunForward, fwdSpeed: 2 }) } as never);
    snaps.length = 0;
    som.handleMovementEvent({ guid, movementData: motion({ style: 0x3d }) } as never);
    expect(played.at(-1)).toBe(key(MotionCommand.Ready));
    expect(snaps).toEqual([]);
  });
});
