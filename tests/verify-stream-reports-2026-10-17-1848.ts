/**
 * Stream segment 2026-10-17 17:54–18:49Z (end of retail, local ACE, build c2165b02), Claude Arcanist (mage) and
 * Claude Bulwark (soldier) in the Tusker Habitat (landblock 0x5B47). Arcanist died at 18:48:02Z to a Tusker Liberator
 * with 0 stamina. What each report item turned out to be, from the transcripts and the page logs:
 *
 * 1. `follow` walked him through hits: his follow of Bulwark stood beside him (0 m) through 16 hits for 84 damage,
 *    96% → 44%, because Bulwark had monsters on him (the rescue rule: hits are the price of getting to a fellow), and
 *    the call answered only at its 30 s deadline (18:03:58–18:04:28Z). No wait was running then; the wait that came
 *    next woke at once. Now a follow beside its leader stops on the first hit; a rescue walk stops under half health.
 *    The follow's task-done also lacked the walk's own notes (13 hits for 62 read "a hit for 0 damage", 18:42:55Z):
 *    they are in the task-done now.
 * 2. The "invisible wall" 1.7 m off (cell 0x5B47011A): a CylSphere-only static, Setup 0x020009A3 (0.13 m × 2.19 m,
 *    its GfxObj has no physics polygons) at (69.99, −104.75, −11.99). ACE's projectile hits it (tools/ace-physics-harness
 *    pairs: 31 of 237 shots there MISS, OnCollideEnvironment); the dungeon collision build left CylSpheres out, so our
 *    line of fire passed all 31. With them in, 236 of 237 agree.
 * 3. The flee walk west with stay_with=Bulwark stood 18 s "waiting for Claude Bulwark, 16 m behind" (he was fighting)
 *    while a Liberator hit him 21 times, then stopped at 38%. A walk under attack never stands still for a fellow now.
 *    And nothing said what 0 stamina meant (ACE: no defense at all, a crawl for a run): the exhausted alarm does now.
 * 4. The same five ramp-top doorways sent walks and follows round by 70–91 doorways 71 times in the hour; a wide
 *    search for the goal found the way in 0.4–0.6 s whenever it ran. A long way round now waits for that search first.
 * 5. The 86-damage Flame Bolt's line read "Casting Flame Bolt V; You're Exhausted!": the summary took the first two
 *    lines as they came. The read itself was whole (86 was counted); the cast line and its outcome come first now.
 * 6. `use target="Health Potion"` was refused between a Health Draught and a Potion of Healing: two different items
 *    (refusal kept). Stacks of one item, by name or by weenie, are one choice.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as THREE from 'three';
import { ItemType } from '@ac/shared';
import { AgentApi, type AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { DungeonCollision } from '../packages/renderer/src/world/DungeonCollision.ts';
import { populateDungeonCollision } from '../packages/renderer/src/world/DungeonCollisionBuild.ts';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const BUL = 0x50000002;
const TUSKER = 0x8000d6c2;
const TUSKER2 = 0x8000cf40;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: (t: number) => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(t); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('walks, follows and waits under attack (items 1 and 3)', () => {
  let host: FakeHost;
  let api: AgentApi;
  let lines: string[];
  const monster = (guid: number, x: number, y: number, extra: Partial<AgentHostObject> = {}): AgentHostObject =>
    host.add({ guid, name: 'Tusker Liberator', itemType: 0x10, objectDescFlags: 0x10, level: 60, x, y, ...extra });
  const fellow = (x: number, y: number): AgentHostObject => {
    host.fellows = () => [{ guid: BUL, name: 'Claude Bulwark', health: { cur: 180, max: 181 }, stamina: { cur: 150, max: 269 }, mana: { cur: 87, max: 87 } }];
    return host.add({ guid: BUL, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x, y });
  };
  /** A Liberator's swing at you: the chat line and the health it takes. */
  const graze = (n: number): void => {
    host.me.health = { ...host.me.health, current: Math.max(1, host.me.health.current - n) };
    api.pushChat(`Tusker Liberator grazes your foot for ${n} points of bludgeoning damage!`, 0x15);
  };
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.me.level = 48;
    host.me.health = { current: 170, max: 170 };
    host.me.stamina = { current: 110, max: 221 };
    host.wall = () => false;
    api = new AgentApi(host);
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { lines.push(String(m)); });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('a follow beside its leader stops at the first hit, though the leader has monsters on them (18:03:58Z)', async () => {
    fellow(80, 22);
    monster(TUSKER2, 81, 23, { seeks: { guid: BUL, kind: 'stick' } });
    monster(TUSKER, 79, 21);
    run(api, host, 300, { physics: false });
    // stop_on_aggro is on for ac_follow unless asked off (the tool's default), as in the live calls.
    const p = api.follow('Claude Bulwark', { within: 4, stopOnAggro: true });
    let hitAt = -1;
    const r = (await settle<AgentResult>(api, host, p, 30_000, (t) => { if (t >= 2000 && t % 700 === 0) { if (hitAt < 0) hitAt = t; graze(6); } }))!;
    expect(r).toMatchObject({ ok: false, attacked: true });
    expect(r.message).toMatch(/^stopped following Claude Bulwark: you're beside them \([\d.]+ m\) and you're under attack \(Tusker Liberator grazes your foot for 6 points/);
    expect(r.message).toMatch(/Fight back \(ac_cast \/ ac_attack\), heal, or get away \(ac_walk_to flee=true\); ac_follow again when it's over/);
    // One hit, not 16: the health it ended at is one graze down.
    expect(host.me.health.current).toBe(164);
    // The answer is its own task-done, at once (no 30 s "still in progress").
    expect(api.eventsSince(0).filter((e) => e.type === 'task-done').map((e) => e.text)).toEqual([expect.stringMatching(/^following Claude Bulwark: stopped following Claude Bulwark: you're beside them/)]);
  });

  it('flee=true follows the same: beside the leader, a hit ends it (18:42:21Z: 13 hits for 62 before)', async () => {
    fellow(80, 22);
    monster(TUSKER2, 81, 23, { seeks: { guid: BUL, kind: 'stick' } });
    run(api, host, 300, { physics: false });
    const r = (await settle<AgentResult>(api, host, api.follow('Claude Bulwark', { within: 4, flee: true, stopOnAggro: true }), 30_000, (t) => { if (t >= 2000 && t % 700 === 0) graze(5); }))!;
    expect(r.message).toMatch(/^stopped following Claude Bulwark: you're beside them/);
    expect(host.me.health.current).toBe(165);
  });

  it('on the way to a mobbed fellow a follow still runs on through a hit, and stops once the hits take you under half', async () => {
    fellow(80, 60);
    monster(TUSKER2, 81, 61, { seeks: { guid: BUL, kind: 'stick' } });
    run(api, host, 300, { physics: false });
    let farHits = 0;
    const r = (await settle<AgentResult>(api, host, api.follow('Claude Bulwark', { within: 4, stopOnAggro: true }), 30_000, (t) => {
      if (t > 0 && t % 500 === 0 && Math.hypot(host.me.x - 80, host.me.y - 60) > 12) { farHits++; graze(30); }
    }))!;
    // 170 → 140 → 110 → 80 (47%): the first hits were walked through (rescue), the one under half stopped it.
    expect(farHits).toBe(3);
    expect(r).toMatchObject({ ok: false, attacked: true });
    expect(r.message).toMatch(/^stopped [\d.]+ m short: you're under attack/);
  });

  it('a flee walk with stay_with never stands still for a fellow while it is being hit (18:46:46Z)', async () => {
    host.me.health = { current: 150, max: 170 };
    // Bulwark 16 m east of you, fighting in the pile; the walk goes 25 m west.
    fellow(96, 20);
    monster(TUSKER2, 97, 21, { seeks: { guid: BUL, kind: 'stick' } });
    monster(TUSKER, 81, 20, { seeks: { guid: host.me.guid, kind: 'stick' } });
    run(api, host, 300, { physics: false });
    const startX = host.me.x;
    const r = (await settle<AgentResult>(api, host, api.walkTo('25m west', { within: 1, flee: true, stayWith: 'Claude Bulwark' }), 30_000, (t) => { if (t % 1000 === 0 && t < 6000) graze(4); }))!;
    expect(lines.filter((l) => /walk: waiting for Claude Bulwark/.test(l))).toEqual([]);
    expect(startX - host.me.x).toBeGreaterThan(20);
    expect(r.message).toMatch(/didn't stop to wait for Claude Bulwark: you were being hit, and a walk under attack never stands still for a fellow/);
  });

  it('the same walk with nothing hitting you still waits for the fellow left behind (stay_with unchanged)', async () => {
    fellow(96, 20);
    run(api, host, 300, { physics: false });
    void api.walkTo('25m west', { within: 1, stayWith: 'Claude Bulwark' });
    run(api, host, 6000);
    expect(lines.some((l) => /walk: waiting for Claude Bulwark, \d+ m behind/.test(l))).toBe(true);
  });

  it("a walk's task-done carries its own notes, as its answer does (hit on the way)", async () => {
    monster(TUSKER, 80, 15, { seeks: { guid: host.me.guid, kind: 'stick' } });
    run(api, host, 300, { physics: false });
    const r = (await settle<AgentResult>(api, host, api.walkTo('20m north', { within: 1, flee: true }), 30_000, (t) => { if (t === 1000) graze(20); }))!;
    expect(r.message).toMatch(/\n {2}hit on the way \(Tusker Liberator grazes your foot for 20 points/);
    const done = api.eventsSince(0).filter((e) => e.type === 'task-done').map((e) => e.text);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatch(/hit on the way \(Tusker Liberator grazes your foot for 20 points/);
    // Applied once, not twice.
    expect(r.message.match(/hit on the way/g)).toHaveLength(1);
    expect(r).not.toHaveProperty('afterApplied');
  });

  it('stamina reaching 0 with something on you is EXHAUSTED: it wakes any wait and says what it means (ACE IsExhausted)', async () => {
    monster(TUSKER, 81, 20);
    run(api, host, 200, { physics: false });
    graze(4);
    run(api, host, 200, { physics: false });
    const w = api.wait({ types: ['tell'] as never }, 20_000);
    const evs = (await settle(api, host, w, 5000, (t) => { if (t === 300) { host.me.stamina = { current: 0, max: 221 }; api.pushChat("You're Exhausted!"); } }))!;
    expect(evs.map((e) => e.type)).toEqual(['vitals-low']);
    expect(evs[0].text).toMatch(/^stamina 0\/221: EXHAUSTED\. The server gives you no defense now \(every attack at you lands\) and runs you at a crawl; .*\(1 on you\)\. A stamina potion or elixir, or a Revitalize, brings it back/);
    // The observe header says so too.
    expect(formatObservation(api.observe())).toMatch(/ST 0\/221 \(EXHAUSTED: no defense, every attack lands; a crawl for a run\)/);
    // Back above 0: no longer EXHAUSTED.
    host.me.stamina = { current: 3, max: 221 };
    run(api, host, 200, { physics: false });
    expect(formatObservation(api.observe())).not.toMatch(/EXHAUSTED/);
  });

  it('stamina 0 with nothing on you is said, but wakes only a wait that asks for vitals-low', async () => {
    run(api, host, 200, { physics: false });
    const w = api.wait({ types: ['tell'] as never }, 2000);
    host.me.stamina = { current: 0, max: 221 };
    const evs = (await settle(api, host, w, 3000))!;
    expect(evs).toEqual([]);
    expect(api.eventsSince(0).some((e) => e.type === 'vitals-low' && /^stamina 0\/221: EXHAUSTED/.test(e.text))).toBe(true);
  });
});

describe('the cast repeat summary with "You\'re Exhausted!" in the read (item 5, 18:47:22Z)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const t0 = Date.now();
    host.now = () => Date.now() - t0;
    api = new AgentApi(host);
    host.me.level = 48;
    host.me.health = { current: 75, max: 170 };
    host.me.stamina = { current: 2, max: 222 };
    host.me.mana = { current: 192, max: 335 };
    host.spells = () => [{ id: 27, name: 'Flame Bolt I', school: 'War', level: 1, projectile: true, range: 20 }];
    (host as unknown as { lineOfFire: () => { dist: number; blockedAt: number | null } }).lineOfFire = () => ({ dist: 3, blockedAt: null });
    host.add({ guid: TUSKER2, name: 'Tusker Liberator', itemType: 0x10, objectDescFlags: 0x10, level: 60, x: 80, y: 23 });
    // The server's lines in the order they came: the cast, Exhausted (stamina hit 0 on a swing at you), a graze, the words,
    // another graze, then the bolt's damage 3.8 s after the cast.
    host.cast = (id: number, t: number | null) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
      api.pushChat('Casting Flame Bolt I');
      setTimeout(() => { host.me.stamina.current = 0; api.pushChat("You're Exhausted!"); }, 90);
      setTimeout(() => api.pushChat('Tusker Liberator grazes your hand for 6 points of bludgeoning damage!', 0x15), 100);
      setTimeout(() => api.pushChat('You say, "Zojak Quaguz"', 0x11), 1400);
      setTimeout(() => api.pushChat('Critical hit! Tusker Liberator grazes your upper arm for 10 points of bludgeoning damage!', 0x15), 1100);
      setTimeout(() => { host.me.health.current = 41; api.pushChat('You burn Tusker Liberator for 86 points with Flame Bolt I.', 0x16); }, 3900);
      return true;
    };
  });
  afterEach(() => vi.useRealTimers());

  it('each cast\'s line is its cast and its outcome, and the summary says you are exhausted', async () => {
    let out: AgentResult | undefined;
    void api.cast('Flame Bolt I', 'Tusker Liberator', { repeat: true, untilHealth: 0.35 }).then((r) => { out = r; });
    for (let t = 0; t < 30_000 && !out; t += 200) await vi.advanceTimersByTimeAsync(200);
    const lines = out!.message.split('\n');
    expect(lines[1]).toBe('  1: Casting Flame Bolt I; You burn Tusker Liberator for 86 points with Flame Bolt I.');
    expect(out!.message).toMatch(/86 damage in 1 hit/);
    expect(out!.message).toMatch(/you: health 41\/170, stamina 0\/222, mana \d+\/335.*\(EXHAUSTED: at 0 stamina the server gives you no defense, so every attack at you lands/);
  });
});

describe('dungeon statics that are only a CylSphere (item 2)', () => {
  it('populateDungeonCollision registers a Setup with no physics BSP by its CylSphere, and a missile sweep hits it', () => {
    const dc = new DungeonCollision();
    // The cell's own walls are beside the point here; only its statics are.
    dc.addCell = () => {};
    const pole = { parts: [0x01001fea], placementFrames: new Map(), cylSpheres: [{ origin: { x: 0, y: 0, z: 0 }, radius: 0.13, height: 2.188 }], spheres: [] };
    populateDungeonCollision(dc, 0x5b47ffff, {
      findInteriorCells: () => [0x5b47011a],
      getCellCollisionData: () => ({ cellStruct: { vertexArray: { vertexType: 1, vertices: new Map() }, polygons: new Map(), portals: [], cellBSP: null, physicsPolygons: new Map(), physicsBSP: null, drawingBSP: null } as never, position: { origin: { x: 70, y: -100, z: -12 }, orientation: { w: 1, x: 0, y: 0, z: 0 } } }),
      loadEnvCell: () => ({ staticObjects: [{ id: 0x020009a3, frame: { origin: { x: 69.987, y: -104.75, z: -11.991 }, orientation: { w: 0.517, x: 0, y: 0, z: -0.856 } } }] }),
      loadSetupModel: (id) => (id === 0x020009a3 ? pole as never : null),
      // Its one part draws but has no physics polygons (GfxObj flags 0x0A).
      loadGfxObj: () => ({ physicsBSP: null, physicsPolygons: new Map() }) as never,
      loadLandblockInfo: () => null,
    });
    const BX = 0x5b * 192, BY = 0x47 * 192;
    // THREE world (x, height, z) = AC (x, z, y): a bolt along y through the pole at chest height, and one 1 m east of it.
    const through = dc.sweepSphere({ x: BX + 69.99, y: -10.8, z: BY - 103.5 }, { x: BX + 69.99, y: -10.8, z: BY - 106 }, 0.1);
    const past = dc.sweepSphere({ x: BX + 71, y: -10.8, z: BY - 103.5 }, { x: BX + 71, y: -10.8, z: BY - 106 }, 0.1);
    expect(through).not.toBeNull();
    expect(past).toBeNull();
  });

  const datPresent = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.cell);
  describe.skipIf(!datPresent)('Tusker Habitat 0x5B47, cell 0x5B47011A: our line of fire against ACE\'s projectile', () => {
    const BX = 0x5b * 192, BY = 0x47 * 192;
    const T = 0x80000001;
    let som: ServerObjectManager;
    let me = { x: 0, y: 0, z: 0 };
    let tus: { radius: number; height: number };
    const mesh = new THREE.Group();
    mesh.scale.setScalar(0.9); // Tusker Liberator (wcid 22519): Setup 0x02000964, scale 0.9
    /**
     * ACE's verdicts (tools/ace-physics-harness `pairs 5B47 02000964 0.9`, caster and target feet as ACE placed them):
     * the MISSes are OnCollideEnvironment on the pole's CylSphere ("entry collision", "flight 0.03s", "NOT VISIBLE").
     */
    const ACE: Array<[number, number, number, number, number, number, 'HIT' | 'MISS']> = [
      [69.8, -103.911, -11.995, 69.8, -106.0, -11.231, 'MISS'],
      [69.8, -103.911, -11.995, 70.119, -106.179, -10.932, 'MISS'],
      [69.8, -103.856, -11.995, 70.171, -105.871, -11.085, 'MISS'],
      [70.293, -103.856, -11.739, 69.974, -106.16, -11.03, 'MISS'],
      [70.293, -103.8, -11.739, 69.22, -105.73, -11.403, 'MISS'],
      [69.3, -104.8, -11.995, 71.283, -104.602, -11.072, 'MISS'],
      [69.3, -104.8, -11.995, 70.36, -103.46, -11.625, 'HIT'],
      [69.3, -104.8, -11.995, 70.417, -105.917, -10.911, 'HIT'],
      [69.3, -104.8, -11.995, 70.643, -106.143, -10.639, 'HIT'],
    ];
    beforeAll(async () => {
      const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
      const { SetupModel } = await import('../packages/dat-parser/src/file-types/SetupModel.js');
      const { LandblockInfo } = await import('../packages/dat-parser/src/file-types/LandblockInfo.js');
      const { EnvCellRenderer } = await import('../packages/renderer/src/world/EnvCellRenderer.js');
      const { SetupModelRenderer } = await import('../packages/renderer/src/models/SetupModelRenderer.js');
      const { ModelRenderer } = await import('../packages/renderer/src/models/ModelRenderer.js');
      const { MaterialFactory } = await import('../packages/renderer/src/models/MaterialFactory.js');
      const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
      const portal = openDat(DAT_PATHS.portal), cell = openDat(DAT_PATHS.cell);
      const mf = new MaterialFactory(portal, new TextureManager(portal));
      const mr = new ModelRenderer(portal, mf);
      const sr = new SetupModelRenderer(portal, mr);
      const env = new EnvCellRenderer(portal, cell, mf, sr, mr);
      const lbInfo = (lb: number) => { const d = cell.getFileData(((lb & 0xffff0000) | 0xfffe) >>> 0); return d ? new LandblockInfo(new DatReader(d)) : null; };
      const dc = new DungeonCollision();
      // As main.ts builds the entered dungeon (buildDungeonCollision).
      populateDungeonCollision(dc, 0x5b47ffff, {
        findInteriorCells: (lb) => { const info = lbInfo(lb)!; const out: number[] = []; for (let i = 0; i < info.numCells; i++) { const id = ((lb & 0xffff0000) | (0x100 + i)) >>> 0; if (cell.hasFile(id)) out.push(id); } return out; },
        getCellCollisionData: (id) => env.getCellCollisionData(id),
        loadEnvCell: (id) => env.loadEnvCell(id),
        loadSetupModel: (id) => sr.loadSetupModel(id),
        loadGfxObj: (id) => mr.loadGfxObj(id),
        loadLandblockInfo: lbInfo,
      });
      const setup = (id: number) => new SetupModel(new DatReader(portal.getFileData(id)!));
      const tusker = setup(0x02000964), human = setup(0x02000001);
      tus = tusker;
      som = new ServerObjectManager({ loadSetupModel: (id: number) => (id === 0x02000964 ? tusker : null) } as never, {} as never, new THREE.Scene());
      som.missileEnvironmentSweep = (from, to, r) => {
        const h = dc.sweepSphere({ x: from.x, y: from.z, z: from.y }, { x: to.x, y: to.z, z: to.y }, r);
        return h ? { t: h.t, normal: { x: h.normal.x, y: h.normal.z, z: h.normal.y } } : null;
      };
      som.missileObjectSweep = () => null;
      som.missileLocalPlayer = () => ({ x: BX + me.x, y: BY + me.y, z: me.z, radius: human.radius, height: human.height, physicsRadius: human.spheres[0].radius });
    }, 120_000);

    it('agrees with ACE on the shots past the pole, and the blocked ones name what blocks them', () => {
      const wrong: string[] = [];
      for (const [cx, cy, cz, tx, ty, tz, ace] of ACE) {
        me = { x: cx, y: cy, z: cz };
        (som as unknown as { objects: Map<number, ServerObject> }).objects.set(T, {
          guid: T, name: 'Tusker Liberator', itemType: ItemType.Creature, physicsState: 0, mesh, setupId: 0x02000964,
          worldX: BX + tx, worldZ: BY + ty, worldY: tz, collisionRadius: tus.radius * 0.9, collisionHeight: tus.height * 0.9,
        } as unknown as ServerObject);
        const r = som.lineOfFire(T)!;
        if ((r.blockedAt === null) !== (ace === 'HIT')) wrong.push(`c=(${cx}, ${cy}) t=(${tx}, ${ty}) ACE ${ace}, ours ${r.blockedAt === null ? 'clear' : `blocked at ${r.blockedAt.toFixed(2)}`}`);
      }
      expect(wrong).toEqual([]);
    });
  });
});

describe('a long way round a doorway waits for a wide search first (item 4)', () => {
  let host: FakeHost;
  let api: AgentApi;
  let lines: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { lines.push(String(m)); });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('the doorway no search gets into: a wide search finds the way past it, and the 30-doorway way round is never walked', async () => {
    // A 3 m thick wall across x = 80 (y 30–60) with a gap at y 52–54; the doorway route's one doorway sits in the wall at y 40
    // (no way into it, as the ramp-top doorways of 0x5B47 for the box search), and its way round is 30 doorways south.
    host.wall = (x, y) => Math.abs(x - 80) < 1.5 && y > 30 && y < 60 && !(y > 52 && y < 54);
    host.me.x = 70; host.me.y = 40;
    host.add({ guid: 0x8000004b, name: 'Tusker Pup', itemType: 0x10, cell: 0xa9b40105, x: 90, y: 40 });
    host.route = ((_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }, opts?: { closed?: Array<{ x: number; y: number; z: number }> }) => {
      const shut = opts?.closed?.some((c) => Math.hypot(c.x - 80, c.y - 40) <= 2.5);
      if (!shut) return [{ x: 80, y: 40, z: 94 }, to];
      return [...Array.from({ length: 30 }, (_, i) => ({ x: 70 - i, y: 20 - i, z: 94 })), to];
    }) as typeof host.route;
    let minY = Infinity;
    const r = await settle(api, host, api.walkTo('Tusker Pup', { within: 1.5 }), 120_000, () => { minY = Math.min(minY, host.me.y); });
    expect(r).toMatchObject({ ok: true });
    expect(lines.some((l) => /the way round it is 30 doorway\(s\) against 1, so a wide search for the goal first/.test(l))).toBe(true);
    expect(lines.filter((l) => /routing round it, 30 doorway/.test(l))).toEqual([]);
    // Round the wall's end (y 30) at most, never down the way round (y 20 to -9).
    expect(minY).toBeGreaterThan(25);
  });

  it('when the wide search finds nothing either, the long way round is taken after all', async () => {
    // The wall's only end is 95 m south, past any wide search's box: only the way round leads on.
    host.wall = (x, y) => Math.abs(x - 80) < 1.5 && y > -55 && y < 300;
    host.me.x = 70; host.me.y = 40;
    host.add({ guid: 0x8000004b, name: 'Tusker Pup', itemType: 0x10, cell: 0xa9b40105, x: 90, y: 40 });
    host.route = ((_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }, opts?: { closed?: Array<{ x: number; y: number; z: number }> }) => {
      const shut = opts?.closed?.some((c) => Math.hypot(c.x - 80, c.y - 40) <= 2.5);
      if (!shut) return [{ x: 80, y: 40, z: 94 }, to];
      return [...Array.from({ length: 29 }, (_, i) => ({ x: 70, y: 36 - i * 3.3, z: 94 })), { x: 85, y: -58, z: 94 }, to];
    }) as typeof host.route;
    void api.walkTo('Tusker Pup', { within: 1.5 });
    run(api, host, 90_000);
    expect(lines.some((l) => /so a wide search for the goal first/.test(l))).toBe(true);
    expect(lines.some((l) => /the wide search found no way either; routing round by 30 doorway\(s\)/.test(l))).toBe(true);
  });
});

describe('items named loosely (item 6)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  const potions = (): void => {
    host.inv = [
      { guid: 0x800014e2, name: 'Health Draught', where: 'pack', stack: 2, value: 170, wcid: 2457 },
      { guid: 0x8000fc6e, name: 'Potion of Healing', where: 'pack', stack: 1, value: 170, wcid: 377 },
      { guid: 0x800062a4, name: 'Potion of Healing', where: 'pack', stack: 3, value: 510, wcid: 377 },
    ];
  };

  it('"Health Potion" between a Health Draught and a Potion of Healing at full health: asked, the stronger first', async () => {
    potions();
    const r = await api.use('Health Potion');
    expect(r).toMatchObject({ ok: false });
    expect(r.message).toBe('"Health Potion" could be Potion of Healing #8000fc6e (170 pyreals each, unappraised), Health Draught #800014e2 (85 pyreals each, unappraised): name one (or its #id)');
    expect(host.sent).toEqual([]);
  });

  it('the same at 38% with Footmen on you: the strongest is used, and the answer says which and why (19:18:29Z)', async () => {
    potions();
    host.me.health = { current: 19, max: 50 };
    // An appraisal says what it restores (BoostValue, PropertyInt 90; BoostEnum 89 = 2, health): that outranks price.
    host.appraised.push(0x800014e2);
    host.appraisalDatas.set(0x800014e2, { int: { 89: 2, 90: 10 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    host.appraised.push(0x8000fc6e);
    host.appraisalDatas.set(0x8000fc6e, { int: { 89: 2, 90: 25 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    const r = (await settle(api, host, api.use('Health Potion'), 20_000))!;
    expect(host.sent).toContain('use 8000fc6e');
    expect(r.message).toMatch(/\("Health Potion" could be Potion of Healing #8000fc6e, Health Draught #800014e2: used Potion of Healing, the strongest you carry \(restores 25 health\), with your health at 38%; name one to choose\)/);
  });

  it('stacks of one item named loosely are one choice: used, not asked (by name, and by weenie)', async () => {
    host.inv = [
      { guid: 0x80001f1d, name: 'Potion of Healing', where: 'pack', stack: 1, wcid: 377 },
      { guid: 0x800062a4, name: 'Potion of Healing', where: 'pack', stack: 3, wcid: 377 },
    ];
    await settle(api, host, api.use('Health Potion'), 20_000);
    expect(host.sent).toContain('use 80001f1d');
    host.sent = [];
    // One weenie shown under two names (a stack's plural): still one item.
    host.inv = [
      { guid: 0x80001f1d, name: 'Potion of Healing', where: 'pack', stack: 1, wcid: 377 },
      { guid: 0x800062a4, name: 'Potions of Healing', where: 'pack', stack: 3, wcid: 377 },
    ];
    await settle(api, host, api.use('Health Potion'), 20_000);
    expect(host.sent.some((s) => /^use 800/.test(s))).toBe(true);
  });
});

describe('the Viamontian Lab death (item 3, 2026-10-17 19:18Z): no call comes back empty for a threshold you set', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.me.level = 48;
    host.me.health = { current: 107, max: 193 };
    host.wall = () => false;
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  /** Three Footmen round you, grazing 1–4 a hit (19:18:18Z). */
  const footmen = (): void => {
    host.add({ guid: 0x8000d8bc, name: 'Viamontian Footman', itemType: 0x10, objectDescFlags: 0x10, level: 60, x: 81, y: 20 });
    host.add({ guid: 0x8000dc05, name: 'Viamontian Footman', itemType: 0x10, objectDescFlags: 0x10, level: 60, x: 79, y: 21 });
    host.add({ guid: 0x8000dc01, name: 'Viamontian Footman', itemType: 0x10, objectDescFlags: 0x10, level: 60, x: 80, y: 19 });
    run(api, host, 200, { physics: false });
  };
  const graze = (n: number): void => {
    host.me.health = { ...host.me.health, current: Math.max(1, host.me.health.current - n) };
    api.pushChat(`Critical hit! Viamontian Footman grazes your hand for ${n} points of bludgeoning damage!`, 0x15);
  };

  it('(a) walk_to stop_on_aggro=false walks on through the hits (it stopped after 1 s, 3.1 m short)', async () => {
    footmen();
    const surface = api.surface() as unknown as { walkTo: (t: string, o: Record<string, unknown>) => Promise<AgentResult> };
    const r = (await settle<AgentResult>(api, host, surface.walkTo('6m east', { stopOnAggro: false }), 20_000, (t) => { if (t % 300 === 0) graze(t % 900 === 0 ? 4 : 2); }))!;
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/^arrived/);
    expect(host.me.x).toBeGreaterThan(84.5);
  });

  it('(a) the same walk with stop_on_aggro left on still stops for the hits (unchanged)', async () => {
    footmen();
    const surface = api.surface() as unknown as { walkTo: (t: string, o: Record<string, unknown>) => Promise<AgentResult> };
    const r = (await settle<AgentResult>(api, host, surface.walkTo('6m east', {}), 20_000, (t) => { if (t % 300 === 0) graze(4); }))!;
    expect(r).toMatchObject({ ok: false, attacked: true });
  });

  it('(b) a repeat cast already under until_health makes one cast, then ends on it, saying so (it was refused at 38%)', async () => {
    const t0 = Date.now();
    host.now = () => Date.now() - t0;
    host.me.health = { current: 73, max: 193 };
    host.spells = () => [{ id: 27, name: 'Flame Bolt I', school: 'War', level: 1, projectile: true, range: 20 }];
    host.add({ guid: 0x8000dc05, name: 'Viamontian Footman', itemType: 0x10, objectDescFlags: 0x10, level: 60, x: 80, y: 23 });
    host.cast = (id: number, t: number | null) => {
      host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
      setTimeout(() => api.pushChat('You burn Viamontian Footman for 70 points with Flame Bolt I.', 0x16), 1500);
      return true;
    };
    let r: AgentResult | undefined;
    void api.cast('Flame Bolt I', 'Viamontian Footman', { repeat: true, untilHealth: 0.5 }).then((x) => { r = x; });
    for (let t = 0; t < 30_000 && !r; t += 200) await vi.advanceTimersByTimeAsync(200);
    expect(host.sent.filter((x) => x.startsWith('cast 27'))).toHaveLength(1);
    expect(r!.ok).toBe(true);
    expect(r!.message).toMatch(/^cast Flame Bolt I at Viamontian Footman 1 time \(repeat\); stopped: your own until_health: your health was already under the 50% you set when this began \(73\/193\), so one cast was made and the repeat ended there/);
    expect(r!.message).toMatch(/\n {2}1: You burn Viamontian Footman for 70 points/);
  });

  it('a heal on yourself is never gated on health', async () => {
    host.me.health = { current: 5, max: 193 };
    host.spells = () => [{ id: 6, name: 'Heal Self I', school: 'Life', level: 1, self: true }];
    host.cast = (id: number, t: number | null) => { host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`); setTimeout(() => api.pushChat('You cast Heal Self I and restore 20 points of your health.', 0x16), 500); return true; };
    const t0 = Date.now();
    host.now = () => Date.now() - t0;
    let r: AgentResult | undefined;
    void api.cast('Heal Self I', null).then((x) => { r = x; });
    for (let t = 0; t < 10_000 && !r; t += 200) await vi.advanceTimersByTimeAsync(200);
    expect(host.sent.some((x) => x.startsWith('cast 6'))).toBe(true);
    expect(r!.ok).toBe(true);
  });
});
