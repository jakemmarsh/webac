/**
 * main.ts's frame loop for the player's body over a landblock's real collision, offline (BUG.jump-through-ceiling,
 * BUG.ledge-step-off-hangs-in-air): the shipped pieces in the live frame's order — stepPlayerMovement (the collided
 * step, airborne included), interiorGroundY (getBodyFloorHeight + findCellContaining, as main.ts passes them),
 * losesContact (the walk-off) and advanceAirborneFrame (the airborne vertical step with the ceiling check).
 * Landblock-local metres in and out, AC axes (y north). Build `nav` with dungeonNav (tests/_harness/dungeonNav.ts).
 */
import { advanceAirborneFrame, airborneReferenceY, losesContact } from '../../packages/renderer/src/world/fallPhysics.js';
import { floorSearchFromY, interiorGroundY } from '../../packages/renderer/src/world/outdoorGround.js';
import { stepPlayerMovement, type MovementServices } from '../../packages/renderer/src/player/OutdoorMovement.js';
import { landingGroundVelocity, type GroundVelocity } from '../../packages/renderer/src/player/LandingCoast.js';
import type { DungeonNav } from './dungeonNav.js';

const G = -9.8; // main.ts GRAVITY (ACE PhysicsGlobals.Gravity)

export interface LiveRun {
  x: number; y: number; z: number; cell: number;
  maxX: number; minX: number; maxY: number; minY: number;
  peak: number; frames: number; landed: boolean;
  /** The frame the body landed on (-1: never). */
  landedFrame: number;
  /** The body left the ground (a jump, or a walk-off). */
  fell: boolean;
}

export interface LiveFrameOptions {
  /** A jump from `at`: launch velocity, m/s (vx east, vy north, up). */
  jump?: { vx: number; vy: number; up: number };
  /** Walk / run at this ground velocity (m/s) every grounded frame. */
  walk?: { vx: number; vy: number };
  seconds?: number;
  /** false: no ceiling check (the client before BUG.jump-through-ceiling's fix). */
  ceilings?: boolean;
  /** The body's EdgeSlide (default true: every player, ACE and the AC1999 server alike). */
  edgeSlide?: boolean;
  /** A landing keeps the jump's velocity and coasts (player/LandingCoast.ts, as main.ts does since 0cff3b710). */
  coast?: boolean;
  /** Every frame after its step: time (ms from the start), landblock-local position, feet, the cell, on the ground. */
  onFrame?: (f: { t: number; x: number; y: number; z: number; cell: number; onGround: boolean }) => void;
}

/**
 * Standing at `at`, jumping (`jump`) or walking (`walk`) until the body has landed and stood a moment, or `seconds`
 * pass. The movement services keep one sliding normal across frames, as main.ts's movementServices.slide does.
 */
export function liveFramesOver(nav: DungeonNav, landblock: number, at: { x: number; y: number; z: number }, opts: LiveFrameOptions): LiveRun {
  const col = nav.col;
  const BX = ((landblock >>> 24) & 0xff) * 192, BY = ((landblock >>> 16) & 0xff) * 192;
  const dt = 1 / 60;
  const stepDown = nav.stepDown;
  const sv = {
    dungeonCollision: col, outdoorCollision: col,
    terrain: { getHeightAt: () => null, getTriangleNormalAt: () => null, isWalkable: () => true },
    water: { blockWaterTypeAt: () => null }, creatureObstacles: null, defaultPlayerRadius: col.playerRadius,
    edgeSlide: opts.edgeSlide ?? true, stepDownHeight: stepDown, slide: { slidingNormal: null },
    dungeonGroundAt: (x: number, z: number, fromY: number) => col.getFloorHeight(x, z, fromY, Infinity),
  } as unknown as MovementServices;
  let cell = col.findCellContaining(BX + at.x, BY + at.y, at.z + col.lowerSphereHeight);
  const ground = {
    floorHeight: (x: number, z: number, fromY: number, maxDrop?: number) => col.getBodyFloorHeight(x, z, fromY, stepDown, maxDrop),
    cellAt: (x: number, z: number, footY: number) => col.findCellContaining(x, z, footY + col.lowerSphereHeight, cell),
  };
  let x = BX + at.x, z = BY + at.y;
  let lastGround = at.z;
  let prevGrounded: number | null = at.z;
  let airborne = false, baseY = at.z, offY = 0, vy = 0, vx = 0, vz = 0, fell = false;
  let gv: GroundVelocity | null = null;
  if (opts.jump) { airborne = true; fell = true; baseY = at.z; vy = opts.jump.up; vx = opts.jump.vx; vz = opts.jump.vy; prevGrounded = null; }
  let maxX = -Infinity, minX = Infinity, maxY = -Infinity, minY = Infinity, peak = at.z, landedAt = -1, landed = false;
  const total = Math.round((opts.seconds ?? 6) / dt);
  let f = 0;
  for (; f < total; f++) {
    const px = x, pz = z;
    const walking = !airborne && !!opts.walk;
    const step = stepPlayerMovement(
      {
        x, z, floorY: airborneReferenceY(airborne, baseY, offY, lastGround), inDungeon: true, airborne, jumpVelocityX: vx, jumpVelocityZ: vz, slideVelocity: null,
        ...(opts.coast ? { groundVelocity: airborne ? null : gv } : {}),
      },
      walking ? opts.walk!.vx * dt : 0, walking ? opts.walk!.vy * dt : 0, dt, sv,
    );
    x = step.x; z = step.z;
    if (opts.coast && step.groundVelocity !== undefined) gv = step.groundVelocity;
    const groundY = interiorGroundY(ground, px, pz, x, z,
      floorSearchFromY(null, airborneReferenceY(airborne, baseY, offY, lastGround), col.lastStepUp ?? 0), col.transitionSphereRadius, lastGround);
    lastGround = groundY;
    if (!airborne && losesContact(prevGrounded, groundY, stepDown)) {
      airborne = true; fell = true; baseY = prevGrounded as number; offY = 0; vy = 0; vx = (x - px) / dt; vz = (z - pz) / dt; gv = null;
    }
    prevGrounded = airborne ? null : groundY;
    if (airborne) {
      const air = advanceAirborneFrame(baseY, offY, vy, [dt], groundY, G, {
        riseLimit: opts.ceilings === false ? null : (from, to) => col.riseLimit(x, z, from, to),
        floorAtHead: (headY) => col.getFloorHeight(x, z, headY, Infinity),
        height: col.playerHeight,
      });
      offY = air.offsetY; vy = air.velocityY;
      if (air.landed) {
        airborne = false; offY = 0; landed = true; landedAt = f; prevGrounded = groundY;
        gv = opts.coast ? landingGroundVelocity(vx, vz) : null;
        vx = 0; vz = 0;
      }
    }
    const feet = airborne ? baseY + offY : groundY;
    peak = Math.max(peak, feet);
    maxX = Math.max(maxX, x - BX); minX = Math.min(minX, x - BX);
    maxY = Math.max(maxY, z - BY); minY = Math.min(minY, z - BY);
    const c = col.findCellContaining(x, z, feet + col.lowerSphereHeight, cell);
    if (c) cell = c;
    opts.onFrame?.({ t: (f + 1) * dt * 1000, x: x - BX, y: z - BY, z: feet, cell: c >>> 0, onGround: !airborne });
    if (landed && !airborne && f - landedAt > (opts.coast ? 90 : 30)) break;
  }
  const feet = airborne ? baseY + offY : lastGround;
  return { x: x - BX, y: z - BY, z: feet, cell: col.findCellContaining(x, z, feet + col.lowerSphereHeight) >>> 0, maxX, minX, maxY, minY, peak, frames: f, landed, landedFrame: landedAt, fell };
}
