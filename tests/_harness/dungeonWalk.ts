/**
 * The agent's whole walk (AgentApi.walkTo) through a dungeon landblock's real collision, offline: a
 * FakeHost whose body moves by the client's own movement probe (dungeonNav: stepPlayerMovement through
 * the cells' and statics' collision), whose jumps fly by the client's jump physics (jumpPlan.simulateFlight
 * with the same kit), and whose doorway route is the cell DAT's (cellPath.loadCellGraph +
 * findRouteViaOutside), as main.ts wires the live host. Creatures are not in it. Server-placed fixtures
 * (signs, doors, a lifestone: ac1999Fixtures.ts) are when given: they collide as main.ts's agentNav
 * fixtures do (CreatureCollision.addCreatureObstacles), are objects the walk sees, and a door's Use opens it
 * (Ethereal, no collision) unless it is locked ("The door is locked!", as ACE Door.ActOnUse answers).
 *
 * Use with vi.useFakeTimers() (the jump key's charge runs on the host clock); call `walk` inside a test.
 */
import { vi } from 'vitest';
import { AgentApi, compassToYaw, type AgentHost } from '../../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult } from '../../packages/renderer/src/agent/types.ts';
import { findRouteViaOutside, loadCellGraph } from '../../packages/renderer/src/agent/cellPath.ts';
import { simulateFlight } from '../../packages/renderer/src/agent/jumpPlan.ts';
import type { DatDatabase } from '../../packages/dat-parser/src/DatDatabase.js';
import { DatReader } from '../../packages/dat-parser/src/DatReader.js';
import { GfxObj } from '../../packages/dat-parser/src/file-types/GfxObj.js';
import { SetupModel } from '../../packages/dat-parser/src/file-types/SetupModel.js';
import { addCreatureObstacles } from '../../packages/renderer/src/world/CreatureCollision.ts';
import type { CollisionKey } from '../../packages/renderer/src/world/DungeonCollision.ts';
import { resolveObjectPhysics } from '../../packages/renderer/src/world/ObjectCollision.ts';
import { FakeHost } from './agentFake.ts';
import type { Ac1999Fixture } from './ac1999Fixtures.ts';
import type { DungeonNav } from './dungeonNav.js';

export interface DungeonWalkTarget { cell: number; x: number; y: number; z: number; name: string; itemType?: number }

export class DungeonHost extends FakeHost {
  /** Every trace line of the walk ([AC:Agent] …), for a failing test's message. */
  readonly traces: string[] = [];
  private flight: { until: number; to: { x: number; y: number; z: number } } | null = null;
  private chargeT: number | null = null;
  private readonly bx: number;
  private readonly by: number;
  private readonly graph: ReturnType<typeof loadCellGraph>;

  private api: AgentApi | null = null;
  /** Each fixture's collision keys (removed when a door opens), and which doors are locked. */
  private readonly fixtureKeys = new Map<number, CollisionKey[]>();
  private readonly locked = new Set<number>();

  constructor(private readonly nav: DungeonNav, dats: { portal: DatDatabase; cell: DatDatabase }, landblock: number, opts: { fixtures?: Ac1999Fixture[] } = {}) {
    super();
    this.bx = ((landblock >>> 24) & 0xff) * 192;
    this.by = ((landblock >>> 16) & 0xff) * 192;
    this.graph = loadCellGraph(dats.cell, dats.portal, landblock);
    const sources = {
      loadSetupModel: (id: number) => { const d = dats.portal.getFileData(id); return d ? new SetupModel(new DatReader(d)) : null; },
      loadGfxObj: (id: number) => { const d = dats.portal.getFileData(id); return d ? new GfxObj(new DatReader(d)) : null; },
    };
    const ODF_DOOR = 0x1000, ODF_LIFESTONE = 0x4000, ODF_PORTAL = 0x40000, HAS_PHYSICS_BSP = 0x10000, ETHEREAL = 0x4;
    for (const f of opts.fixtures ?? []) {
      if (f.itemType & 0x10) continue; // creatures: the live fixtures leave them out
      const model = resolveObjectPhysics(f.setupId, sources);
      // The server's PhysicsState, with HasPhysicsBSP where the Setup's parts carry a physics BSP (ACE PhysicsObj).
      const physicsState = (f.physicsState | (model?.hasPhysicsBSP ? HAS_PHYSICS_BSP : 0)) >>> 0;
      const flags = f.door ? ODF_DOOR : f.itemType === 0x10000000 ? ODF_LIFESTONE : f.itemType === 0x10000 ? ODF_PORTAL : 0;
      this.add({ guid: f.guid, name: f.name, cell: f.cell, x: f.x, y: f.y, z: f.z, itemType: f.itemType, objectDescFlags: flags, physicsState });
      if (f.locked) this.locked.add(f.guid);
      if (physicsState & ETHEREAL) continue;
      this.fixtureKeys.set(f.guid, addCreatureObstacles(nav.col, [{
        guid: f.guid, worldX: this.bx + f.x, worldY: f.z, worldZ: this.by + f.y, collisionRadius: 0,
        setupId: f.setupId, quat: f.quat, scale: 1, physicsState,
      }], () => model));
    }
  }

  /** Using a door opens it (it turns Ethereal and stops colliding) unless it is locked. */
  override use = (g: number): boolean => {
    this.sent.push(`use ${g.toString(16)}`);
    const o = this.objs.get(g);
    if (o && (o.objectDescFlags & 0x1000)) {
      if (this.locked.has(g)) this.api?.pushChat('The door is locked!');
      else {
        for (const k of this.fixtureKeys.get(g) ?? []) this.nav.col.removeKey(k);
        this.fixtureKeys.delete(g);
        o.physicsState = ((o.physicsState ?? 0) | 0x4) >>> 0;
      }
    }
    return true;
  };

  /** A key from the pack used on a locked door unlocks it (ACE Key.UseWithTarget; the tutorial's LockCode fits). */
  override useWithTarget = (src: number, target: number): boolean => {
    this.sent.push(`usewith ${src.toString(16)} ${target.toString(16)}`);
    const key = this.inv.find((i) => i.guid === src);
    if (key && /\bkey\b/i.test(key.name) && this.locked.has(target)) this.locked.delete(target);
    return true;
  };

  /** Take the fixtures out of the shared collision again (the DungeonNav outlives this host). */
  dispose(): void {
    for (const keys of this.fixtureKeys.values()) for (const k of keys) this.nav.col.removeKey(k);
    this.fixtureKeys.clear();
  }

  override get navProbe(): AgentHost['navProbe'] { return this.nav.probe; }
  override get navFloor(): AgentHost['navFloor'] { return (x, y, z) => this.nav.kit.floor(x, y, z); }
  override get navAirStep(): AgentHost['navAirStep'] { return (f, dx, dy) => this.nav.kit.airStep(f, dx, dy); }
  override get jumpLaunch(): AgentHost['jumpLaunch'] { return (p, w) => ({ ...this.nav.kit.launch(p, w), chargeSeconds: this.nav.kit.chargeSeconds }); }
  override route = (fc: number, f: unknown, tc: number, t: { x: number; y: number; z: number }, o?: Parameters<AgentHost['route']>[4]): ReturnType<AgentHost['route']> =>
    findRouteViaOutside(this.graph, fc, f as { x: number; y: number; z: number }, tc, t, o);

  /** Space: the charge runs while it is held; its release flies a standing long jump with the keys held then. */
  override key = (code: string, down: boolean): void => {
    if (code === 'Space') {
      if (down && !this.keys.has('Space') && !this.flight) this.chargeT = this.t;
      if (!down && this.keys.has('Space') && this.chargeT !== null) {
        const power = Math.min(1, Math.max(0.001, (this.t - this.chargeT) / (this.nav.kit.chargeSeconds * 1000)));
        this.chargeT = null;
        const walk = this.keys.has('ShiftLeft');
        const l = this.nav.kit.launch(power, walk);
        const forward = this.keys.has('KeyW') ? l.forward : 0;
        this.launches.push({ power, forward, walk, x: this.me.x, y: this.me.y, z: this.me.z });
        const land = simulateFlight(this.nav.kit, { x: this.bx + this.me.x, y: this.by + this.me.y, z: this.me.z },
          -Math.sin(this.me.yaw) * forward, -Math.cos(this.me.yaw) * forward, l.up);
        if (land) {
          this.flight = { until: this.t + land.t * 1000, to: { x: land.x - this.bx, y: land.y - this.by, z: land.z } };
          this.landings.push({ ...this.flight.to, vz: land.vz });
        }
      }
    }
    if (down) this.keys.add(code); else this.keys.delete(code);
  };

  /** W held: the body moves along its facing at run (walk with Shift) speed through the real collision. */
  override physics(dtMs: number): void {
    if (this.flight) {
      if (this.t >= this.flight.until) { Object.assign(this.me, this.flight.to); this.flight = null; this.updateCell(); }
      return;
    }
    if (this.chargeT !== null) return;
    // Forward (W, run; walk with Shift), back (S) and the sidesteps (Z left, C right) a stall's recovery uses.
    const fx = -Math.sin(this.me.yaw), fy = -Math.cos(this.me.yaw);
    let vx = 0, vy = 0;
    if (this.keys.has('KeyW')) { const s = this.keys.has('ShiftLeft') ? 3.12 : 4; vx += fx * s; vy += fy * s; }
    if (this.keys.has('KeyS')) { vx -= fx * 2; vy -= fy * 2; }
    if (this.keys.has('KeyC')) { vx += fy * 2; vy -= fx * 2; }
    if (this.keys.has('KeyZ')) { vx -= fy * 2; vy += fx * 2; }
    if (!vx && !vy) return;
    const from = { x: this.bx + this.me.x, y: this.by + this.me.y, z: this.me.z };
    const got = this.nav.probe(from, { x: from.x + (vx * dtMs) / 1000, y: from.y + (vy * dtMs) / 1000 });
    if (!got) return;
    this.me.x = got.x - this.bx; this.me.y = got.y - this.by; this.me.z = got.z;
    this.updateCell();
  }

  private updateCell(): void {
    const c = this.nav.col.findCellContaining(this.bx + this.me.x, this.by + this.me.y, this.me.z + 0.5, this.me.cell);
    if (c) this.me.cell = c >>> 0;
  }

  /** Stand at (cell, x, y, z), walk to `target` (an object placed there), and run the clock until the walk ends. */
  async walk(cell: number, at: { x: number; y: number; z: number }, target: DungeonWalkTarget, opts: { within?: number; maxMs?: number } = {}): Promise<AgentResult> {
    this.me = { ...this.me, cell: cell >>> 0, ...at, yaw: compassToYaw(0) };
    const guid = 0x7f000001;
    this.add({ guid, cell: target.cell >>> 0, x: target.x, y: target.y, z: target.z, name: target.name, itemType: target.itemType ?? 0 });
    const api = new AgentApi(this);
    this.api = api;
    const log = console.log;
    console.log = (...a: unknown[]) => { this.traces.push(a.join(' ')); };
    try {
      let r: AgentResult | null = null;
      void api.walkTo(guid, { within: opts.within ?? 2, timeoutMs: 180_000 }).then((x) => { r = x; });
      const maxMs = opts.maxMs ?? 300_000;
      for (let t = 0; t < maxMs && !r; t += 100) {
        this.t += 100;
        vi.advanceTimersByTime(100);
        this.physics(100);
        api.tick();
        await Promise.resolve();
      }
      return r ?? { ok: false, message: 'the walk had not ended' };
    } finally {
      console.log = log;
    }
  }
}
