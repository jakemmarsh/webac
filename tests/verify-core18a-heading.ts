/**
 * CORE.18.a — one yaw ↔ AC heading convention for arrivals, MovementSync and
 * the radar.
 *
 * CameraController moves along (−sin yaw, −cos yaw) in (east, north): yaw 0
 * faces south. ACE Position.GetCurrentDir (ACE.Entity/Position.cs:80) is
 * Transform(UnitY, Rotation): heading θ faces (−sin θ, cos θ). So θ = π − yaw.
 * Before the fix every site used θ = yaw: outdoor arrivals ignored the server
 * heading, interior arrivals turned to its E-W reflection, MovementSync sent
 * the reflection, and the radar showed S at the top while facing north
 * (verification/retail-client/ab/ours-core18-facing-north.png).
 *
 * Drives the shipped modules: CameraController.update (real movement),
 * MovementSync (real wire bytes decoded by the network parsers), the radar's
 * computeCompassTokenPositions / blipScreenPosition.
 */
import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { parseAutonomousPositionPayload, parseMoveToStatePayload } from '@ac/network';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import {
  yawToAcHeading, acHeadingToYaw, acHeadingFromQuaternion, yawFromAcQuaternion,
  acQuaternionFromYaw, yawToCompassDegrees,
} from '../packages/renderer/src/scene/AcHeading.js';
import { MovementSync } from '../packages/renderer/src/network/MovementSync.js';
import type { MovementState, PlayerPosition } from '../packages/renderer/src/network/MovementSync.js';
import { computeCompassTokenPositions, RADAR_DIAL_CENTER } from '../packages/renderer/src/ui/RadarCompassTokens.js';
import { blipScreenPosition, radarOffsetFromWorld } from '../packages/renderer/src/ui/RadarBlips.js';

/** ACE Position.GetCurrentDir for an upright heading θ: Transform(UnitY, Rz(θ)). */
function aceCurrentDir(theta: number): { east: number; north: number } {
  return { east: -Math.sin(theta), north: Math.cos(theta) };
}

/** Upright AC quaternion (w, x, y, z) for heading θ. */
function quatForHeading(theta: number): [number, number, number, number] {
  return [Math.cos(theta / 2), 0, 0, Math.sin(theta / 2)];
}

/** Run a real CameraController forward for 0.5 s at `yaw`; return the unit
 *  (east, north) direction the player actually moved (three x = east, z = north). */
function movedDirection(yaw: number): { east: number; north: number } {
  const cc = new CameraController(new THREE.PerspectiveCamera());
  cc.setPosition(0, 1.6, 0);
  cc.playerYaw = yaw;
  cc.autoRun = true;
  cc.update(0.5);
  const p = cc.position;
  const len = Math.hypot(p.x, p.z);
  expect(len).toBeGreaterThan(0.1);
  return { east: p.x / len, north: p.z / len };
}

const IDLE: MovementState = {
  forward: false, backward: false, turnLeft: false, turnRight: false,
  strafeLeft: false, strafeRight: false, running: true,
};

function sendAtYaw(yaw: number) {
  const sent: Uint8Array[] = [];
  const conn = { sendMessage: (b: Uint8Array) => { sent.push(b); } };
  let seq = 0;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sync = new MovementSync(conn as any, () => ++seq);
  const pos: PlayerPosition = {
    worldX: 0xa9 * 192 + 84.3, worldZ: 0xb4 * 192 + 5.0, groundY: 94, playerYaw: yaw,
    landblock: 0, localX: 0, localY: 0, localZ: 0, inDungeon: false, onGround: true,
  };
  sync.sendPositionNow(IDLE, pos);
  expect(sent.length).toBe(2);
  const HDR = 12;
  return {
    moveToState: parseMoveToStatePayload(sent[0].subarray(HDR)).position,
    autonomous: parseAutonomousPositionPayload(sent[1].subarray(HDR)),
  };
}

const HEADINGS = [0, Math.PI / 2, Math.PI, -Math.PI / 2, 0.4, -2.3, 2.9];

describe('CORE.18.a — yaw ↔ AC heading', () => {
  it('a camera turned to a server heading walks along ACE GetCurrentDir for that heading', () => {
    for (const theta of HEADINGS) {
      const yaw = yawFromAcQuaternion(...quatForHeading(theta));
      const moved = movedDirection(yaw);
      const want = aceCurrentDir(theta);
      expect(moved.east).toBeCloseTo(want.east, 5);
      expect(moved.north).toBeCloseTo(want.north, 5);
    }
  });

  it('the @teleloc frame (0.9969, 0, 0, −0.0785) faces NNE, where retail faces the lifestone', () => {
    const moved = movedDirection(yawFromAcQuaternion(0.9969, 0, 0, -0.0785));
    expect(moved.north).toBeGreaterThan(0.98);
    expect(moved.east).toBeGreaterThan(0.1);
    expect(moved.east).toBeLessThan(0.2);
  });

  it('yaw 0 faces south and yaw π north (the controller convention the mapping is built on)', () => {
    expect(yawToAcHeading(Math.PI)).toBeCloseTo(0, 12);
    expect(Math.abs(yawToAcHeading(0))).toBeCloseTo(Math.PI, 12);
    expect(movedDirection(0).north).toBeCloseTo(-1, 6);
    expect(movedDirection(Math.PI).north).toBeCloseTo(1, 6);
  });

  it('the mapping is its own inverse and heading extraction inverts the quaternion', () => {
    for (const theta of HEADINGS) {
      expect(yawToAcHeading(acHeadingToYaw(theta))).toBeCloseTo(theta, 12);
      expect(acHeadingFromQuaternion(...quatForHeading(theta))).toBeCloseTo(theta, 12);
    }
  });

  it('MovementSync reports the heading the player faces (both MoveToState and AutonomousPosition)', () => {
    for (const theta of HEADINGS) {
      const yaw = acHeadingToYaw(theta);
      const { moveToState, autonomous } = sendAtYaw(yaw);
      for (const p of [moveToState, autonomous]) {
        const sent = acHeadingFromQuaternion(p.qw, p.qx, p.qy, p.qz);
        const dir = aceCurrentDir(sent);
        const moved = movedDirection(yaw);
        expect(dir.east).toBeCloseTo(moved.east, 4);
        expect(dir.north).toBeCloseTo(moved.north, 4);
      }
    }
  });

  it('a server heading round-trips arrival → yaw → MovementSync unchanged (no E-W reflection)', () => {
    const q: [number, number, number, number] = [0.9969, 0, 0, -0.0785];
    const { autonomous } = sendAtYaw(yawFromAcQuaternion(...q));
    const back = acHeadingFromQuaternion(autonomous.qw, autonomous.qx, autonomous.qy, autonomous.qz);
    expect(back).toBeCloseTo(acHeadingFromQuaternion(...q), 4);
    const { qw, qz } = acQuaternionFromYaw(yawFromAcQuaternion(...q));
    expect(Math.abs(qw)).toBeCloseTo(0.9969, 3);
    expect(qz * Math.sign(qw)).toBeCloseTo(-0.0785, 3);
  });
});

describe('CORE.18.a — radar orientation', () => {
  it('compass heading: facing north 0, east 90, south 180, west 270', () => {
    expect(yawToCompassDegrees(Math.PI)).toBeCloseTo(0, 9);
    expect(yawToCompassDegrees(-Math.PI / 2)).toBeCloseTo(90, 9);   // forward (1, 0) = east
    expect(yawToCompassDegrees(0)).toBeCloseTo(180, 9);
    expect(yawToCompassDegrees(Math.PI / 2)).toBeCloseTo(270, 9);
    expect(yawToCompassDegrees(-Math.PI)).toBeCloseTo(0, 9);
  });

  it('facing north the N token sits at the top of the dial; facing east the E token does', () => {
    const north = computeCompassTokenPositions(yawToCompassDegrees(Math.PI));
    expect(north.n.top).toBeLessThan(RADAR_DIAL_CENTER.y - 30);
    expect(north.s.top).toBeGreaterThan(RADAR_DIAL_CENTER.y + 30);
    expect(north.e.left).toBeGreaterThan(RADAR_DIAL_CENTER.x + 30);
    const east = computeCompassTokenPositions(yawToCompassDegrees(-Math.PI / 2));
    expect(east.e.top).toBeLessThan(RADAR_DIAL_CENTER.y - 30);
    expect(east.n.left).toBeLessThan(RADAR_DIAL_CENTER.x - 30);
  });

  it('blips: ahead of the player is up the dial, to its right is right (gmRadarUI convert_to_player_space)', () => {
    const cx = 60, cy = 60, R = 50, range = 75;
    const blip = (east: number, north: number, yaw: number) => {
      const { dx, dz } = radarOffsetFromWorld(east, north, 0, 0);
      return blipScreenPosition(dx, dz, yawToCompassDegrees(yaw), range, R, cx, cy)!;
    };
    // Facing north: a northern object is above the marker, an eastern one right.
    expect(blip(0, 30, Math.PI).y).toBeLessThan(cy - 10);
    expect(blip(30, 0, Math.PI).x).toBeGreaterThan(cx + 10);
    // Facing east: the eastern object is ahead (up), the northern one on the left.
    expect(blip(30, 0, -Math.PI / 2).y).toBeLessThan(cy - 10);
    expect(blip(0, 30, -Math.PI / 2).x).toBeLessThan(cx - 10);
    // For every heading, the object straight ahead is straight up.
    for (const theta of HEADINGS) {
      const yaw = acHeadingToYaw(theta);
      const f = aceCurrentDir(theta);
      const p = blip(f.east * 30, f.north * 30, yaw);
      expect(Math.abs(p.x - cx)).toBeLessThanOrEqual(1);
      expect(p.y).toBeLessThan(cy - 15);
    }
  });
});
