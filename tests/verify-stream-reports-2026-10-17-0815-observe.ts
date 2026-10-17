/**
 * Stream segment 07:14–08:16Z, 2026-10-17, end-of-retail local ACE, build e9b3ff28: Claude Arcanist (mage) and Claude
 * Bulwark (soldier) farming Dread Mu-miyahs in Mountain Keep (dungeon 0x01D2). Reports
 * stream/reports/{mage-2026-10-17T08-15-29-604Z,soldier-2026-10-17T08-15-18-119Z}-seg1.md, transcripts
 * stream/sessions/{mage,soldier}-2026-10-17-seg1.jsonl.
 *
 * 1. "The spawn query put portal 1364 in cell A8C30000". It was Arcanist's own SQL through world-query (07:38:19Z,
 *    `HEX(li.obj_Cell_Id) cell`): the DB row really is 0xA8C30000 at origin (105.357, 154.166), one of 40,069
 *    landblock_instance rows stored with the landblock only. ACE's Position constructor turns such an id into the
 *    outdoor cell under the origin (SetPosition → SetLandCell: cellX × 8 + cellY + 1): 0xA8C30027.
 * 2. fellow-aggro "5 m NE, 5 s ago" then "25 m N, now" for "one Dread": both were Bulwark's place (5 m NE of Arcanist
 *    when the event came at 08:01:37, 25 m N at the read, 08:01:42: he had run 20 m N at 08:01:35.9 to intercept
 *    #80005777), next to the Dread's "25 m from them". Each place now says whose it is and when.
 * 3. observe "on me" for a Dread 6 m away that couldn't reach him: #80003fdc, 4.4–6.0 m across and 6 m up on a ledge,
 *    "COMING AT YOU (running at you)" for 33 s (07:20:27–07:21:00Z), then its bolt refused for a wall. The server's
 *    MoveToObject at him was real; the aggro event's no-closer rule never reached observe, since the monster's aim
 *    never lapsed. And #80001a58, 2 m across and 12 m up, counted as on him (horizontal 3 m), so it could never be stuck.
 * 4. "No line of fire" refusals: 40 of 83 Flame Bolt calls (28 a wall, 6 at the spawn point, 4 the floor, 2 the
 *    ceiling); every bolt that went out landed or was resisted (none hit a wall), and the 3 m open-spot search found a
 *    spot once (08:07:21, "1.5m west"). What Arcanist did by hand after 6 of them was walk to Bulwark, and the bolt
 *    landed from there: the refusal now says when a fellow's place has the line.
 * Driven through the real modules (world-query's table pass, the spawns parser, AgentApi on the fake host).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { ItemType } from '@ac/shared';
import { ServerObjectManager, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { AgentApi, type AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { aceCellOf, parseShopVendors } from '../tools/stream/shops.ts';
import { parseGenProfiles, parseSpawnPlaces } from '../tools/stream/spawns.ts';
import { WORLD_QUERY_USAGE, hexCellColumns } from '../tools/stream/world-query.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

describe('1. a cell the DB stores as its landblock alone is the outdoor cell ACE puts it in', () => {
  it('aceCellOf: 0xA8C30000 at (105.357, 154.166) is 0xA8C30027; real cells and "no place" are left alone', () => {
    expect(aceCellOf(0xa8c30000, 105.357, 154.166)).toBe(0xa8c30027);
    expect(aceCellOf(0xa8c30000, 0, 0)).toBe(0xa8c30001);
    expect(aceCellOf(0xa8c30000, 191.9, 191.9)).toBe(0xa8c30040);
    expect(aceCellOf(0xa8c30027, 5, 5)).toBe(0xa8c30027); // already a cell
    expect(aceCellOf(0x01d20114, 5, 5)).toBe(0x01d20114); // a dungeon room
    expect(aceCellOf(0, 3, 4)).toBe(0); // weenie_properties_position rows with no place at all
  });

  it("Arcanist's query (HEX(obj_Cell_Id) cell, origin_X, origin_Y): read as hex and shown as 0xA8C30027, with map coordinates", () => {
    const sql = 'SELECT HEX(obj_Cell_Id) cell, origin_X, origin_Y FROM landblock_instance WHERE weenie_Class_Id=1364 LIMIT 5';
    const table = [
      '+----------+----------+----------+',
      '| cell     | origin_X | origin_Y |',
      '+----------+----------+----------+',
      '| A8C30000 |  105.357 |  154.166 |',
      '+----------+----------+----------+',
      '',
    ].join('\n');
    const out = hexCellColumns(table, sql);
    expect(out).toContain('| 0xA8C30027 | 105.357  | 154.166  |');
    expect(out).not.toContain('A8C30000 |');
    const note = out.split('\n').at(-1)!;
    expect(note).toMatch(/^\(cell ids in hex: 0xA8C30027 is outdoors at 5\d\.\dN, 3\d\.\dE: walk_to takes those coordinates; a cell ending 0000 in the DB \(0xA8C30000\) is outdoors, stored with its landblock only; shown as the cell ACE puts it in, under its origin_X \/ origin_Y \(0xA8C30027\)\)$/);
    // Every row as wide as its rule.
    expect(new Set(out.split('\n').slice(0, -1).map((l) => l.length)).size).toBe(1);
  });

  it('a decimal obj_Cell_Id with no origin columns stays XXYY0000, with what that means', () => {
    const table = [
      '+-----------+---------------+-------------+',
      '| object_Id | value         | obj_Cell_Id |',
      '+-----------+---------------+-------------+',
      '|      1364 | Mountain Keep |  2831351808 |',
      '+-----------+---------------+-------------+',
      '',
    ].join('\n');
    const out = hexCellColumns(table);
    expect(out).toContain('0xA8C30000');
    expect(out.split('\n').at(-1)).toMatch(/a cell ending 0000 \(0xA8C30000\) is an outdoor spot stored with its landblock only: the real cell is landblock \+ \(floor\(origin_X \/ 24\) × 8 \+ floor\(origin_Y \/ 24\) \+ 1\); select origin_X, origin_Y too/);
    expect(WORLD_QUERY_USAGE).toMatch(/XXYY0000 is an outdoor spot stored with its landblock only/);
  });

  it('a HEX() column of digits only is hex, not a decimal (0x01850148 is "1850148")', () => {
    const table = '+---------+\n| cell    |\n+---------+\n| 1850148 |\n+---------+\n';
    expect(hexCellColumns(table, 'SELECT HEX(obj_Cell_Id) AS cell FROM landblock_instance LIMIT 1')).toContain('0x01850148');
    // As a decimal (no HEX in the query) it is the cell that number is.
    expect(hexCellColumns(table)).toContain(`0x${(1850148).toString(16).toUpperCase().padStart(8, '0')}`);
  });

  it('spawns / sells parse a landblock-only placement into its cell (the same rows, the same rule)', () => {
    const p = parseSpawnPlaces('p\t1364\t2831351808\t105.357\t154.166\n');
    expect(p.placed.get(1364)).toEqual([{ cell: 0xa8c30027, x: 105.357, y: 154.166, viaGenerator: false }]);
    const v = parseShopVendors('v\t500\tShopkeeper\t1.2\tNULL\np\t500\t2831351808\t105.357\t154.166\n');
    expect(v.get(500)!.places[0].cell).toBe(0xa8c30027);
    const g = parseGenProfiles('77\t1\t1364\t-1\t1\t2831351808\t105.357\t154.166\n');
    expect(g[0].cell).toBe(0xa8c30027);
  });
});

/** Mountain Keep stand-ins: interior cells of the fake host's landblock (floors are a storey, 6 m, apart there). */
const ROOM = 0xa9b40150;
const ARC = 0x50000001; // the fake host's own player plays Arcanist here
const BULWARK = 0x500000a4;

describe('the fake Keep', () => {
  let host: FakeHost;
  let api: AgentApi;
  const dread = (guid: number, x: number, y: number, z: number, extra: Partial<AgentHostObject> = {}): AgentHostObject =>
    host.add({ guid, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: ROOM, x, y, z, level: 60, ...extra });
  const fellows = (): void => {
    host.fellows = () => [{ guid: BULWARK, name: 'Claude Bulwark', health: { cur: 188, max: 188 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
  };
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.me.name = 'Claude Arcanist'; host.me.guid = ARC; host.me.level = 44;
    host.me.cell = ROOM; host.me.x = 80; host.me.y = 20; host.me.z = 0;
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  describe('2. fellow-aggro says whose distance each is, and as of when', () => {
    it('raised: the Dread by guid, from them and from you; Bulwark from you', () => {
      fellows();
      host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 83.5, y: 23.5, z: 0 });
      run(api, host, 300, { physics: false });
      dread(0x8000475f, 83.5, 48.5, 0, { level: undefined, seeks: { guid: BULWARK, kind: 'move' } });
      run(api, host, 300, { physics: false });
      const ev = api.eventsSince().find((e) => e.type === 'fellow-aggro')!;
      expect(ev.text).toBe('Dread Mu-miyah #8000475f (level not known yet) is coming at your fellow Claude Bulwark, 25 m from them and 29 m N of you (running at them); Claude Bulwark is 5 m NE of you, 100% health');
    });

    it('read 5 s later, after Bulwark ran 20 m N (08:01:37 → 08:01:42Z): then and now, each named', async () => {
      fellows();
      const bul = host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 83.5, y: 23.5, z: 0 });
      run(api, host, 300, { physics: false });
      const d = dread(0x8000475f, 83.5, 48.5, 0, { level: undefined, seeks: { guid: BULWARK, kind: 'move' } });
      run(api, host, 300, { physics: false });
      const seq = api.eventsSince().find((e) => e.type === 'fellow-aggro')!.seq;
      // He runs at it; it comes at him.
      for (let i = 0; i < 50; i++) { bul.y += 0.4; d.y -= 0.1; host.t += 100; }
      const p = api.waitFor({ types: ['fellow-aggro'], sinceSeq: seq - 1 }, 10);
      vi.advanceTimersByTime(20);
      const text = (await p)[0].text;
      // Bulwark at (83.5, 43.5), the Dread at (83.5, 43.5): they met.
      expect(text).toBe('Dread Mu-miyah #8000475f (level not known yet) was coming at your fellow Claude Bulwark, 25 m from them and 29 m N of you (running at them), 5 s ago; Claude Bulwark was 5 m NE of you then and is 24 m N of you now, 100% health; Dread Mu-miyah #8000475f is 0 m from Claude Bulwark and 24 m N of you now');
    });

    it('the fellows line names each monster by guid and says "from them"', () => {
      fellows();
      host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 80, y: 44, z: 0 });
      run(api, host, 300, { physics: false });
      dread(0x80005811, 80, 57, 0, { seeks: { guid: BULWARK, kind: 'move' } });
      run(api, host, 300, { physics: false });
      expect(formatObservation(api.observe())).toMatch(/fellows: Claude Bulwark 100% HP, 24 m N, MONSTERS AT THEM: Dread Mu-miyah L60 #80005811 running at them, 13 m from them/);
    });

    it('an aggro, an attackers-up and a fellow-low read late say when, and how things stand now', async () => {
      fellows();
      host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 80, y: 30, z: 0 });
      const d = dread(0x80001a58, 83, 17, 0);
      api.push('aggro', 'Dread Mu-miyah #80001a58 (level 60) is coming at you, 4 m SE (running at you)', 0x80001a58);
      api.push('attackers-up', '1 creature attacking you now (+Dread Mu-miyah #80001a58): Dread Mu-miyah', 0x80001a58);
      api.push('fellow-low', "Claude Bulwark's health 100/188 (53%), below 60%; they are 10 m N of you", BULWARK);
      host.t += 6000;
      d.x = 80; d.y = 22;
      host.objs.get(BULWARK)!.y = 40;
      const p = api.waitFor({ types: ['aggro', 'attackers-up', 'fellow-low'], sinceSeq: 0 }, 10);
      vi.advanceTimersByTime(20);
      const evs = await p;
      expect(evs.map((e) => e.text)).toEqual([
        'Dread Mu-miyah #80001a58 (level 60) is coming at you, 4 m SE (running at you) [6 s ago; now 2 m N of you]',
        '1 creature attacking you 6 s ago (+Dread Mu-miyah #80001a58): Dread Mu-miyah [now none attacking you]',
        "Claude Bulwark's health 100/188 (53%), below 60% (6 s ago); they were 10 m N of you then, 20 m N of you now",
      ]);
    });
  });

  describe('3. observe: aimed at you is not reaching you', () => {
    it('a Dread 5 m across and 6 m up, running at you for 33 s: aimed at you but not reaching you, and why', () => {
      host.lineOfFire = () => ({ dist: 5.7, blockedAt: 0.8, blocker: 'a wall', beforeSpawn: true, spawnAhead: 1 });
      dread(0x80003fdc, 85, 20.5, 6, { seeks: { guid: ARC, kind: 'move' } });
      run(api, host, 1000, { physics: false });
      // Within the first 20 s it is on another floor already: aimed, not reaching.
      let line = formatObservation(api.observe()).split('\n').find((l) => l.includes('#80003fdc'))!;
      expect(line).toMatch(/AIMED AT YOU BUT NOT REACHING YOU \(running at you, 6 m up: another floor, no melee from there, no line of fire: a wall in the way\)/);
      // The server keeps it aimed at you all along (no lapse, so no second aggro event); it comes no nearer.
      run(api, host, 32_000, { physics: false });
      line = formatObservation(api.observe()).split('\n').find((l) => l.includes('#80003fdc'))!;
      expect(line).toMatch(/AIMED AT YOU BUT NOT REACHING YOU \(running at you, no closer in 3\d s, 6 m up: another floor/);
      expect(line).not.toMatch(/COMING AT YOU/);
      // Its aggro event said where it is, floors and all.
      expect(api.eventsSince().filter((e) => e.type === 'aggro').map((e) => e.text)[0]).toBe('Dread Mu-miyah #80003fdc (level 60) is coming at you, 5 m E (running at you), 6 m up: another floor');
    });

    it('on your floor and coming on: COMING AT YOU as before; stuck there 20 s+: no closer, the wall named', () => {
      host.lineOfFire = () => ({ dist: 9, blockedAt: 3, blocker: 'a wall' });
      const d = dread(0x80005811, 80, 35, 0, { seeks: { guid: ARC, kind: 'move' } });
      run(api, host, 500, { physics: false });
      expect(formatObservation(api.observe())).toMatch(/#80005811 .*COMING AT YOU \(running at you\)/);
      d.y = 29; // it comes on 6 m
      run(api, host, 500, { physics: false });
      expect(formatObservation(api.observe())).toMatch(/#80005811 .*COMING AT YOU \(running at you\)/);
      run(api, host, 21_000, { physics: false }); // then gets nowhere behind a wall
      expect(formatObservation(api.observe())).toMatch(/#80005811 .*AIMED AT YOU BUT NOT REACHING YOU \(running at you, no closer in 2\d s, no line of fire: a wall in the way\)/);
    });

    it('a Dread 2 m across and 12 m up is not on you, so it can be stuck (08:01:49Z, #80001a58)', () => {
      dread(0x80001a58, 81, 21.5, 12, { seeks: { guid: ARC, kind: 'move' } });
      run(api, host, 21_500, { physics: false });
      const c = api.comingAt(ARC).find((x) => x.guid === 0x80001a58)!;
      expect(c.on).toBe(false);
      expect(c.otherFloor).toBe(true);
      expect(formatObservation(api.observe())).toMatch(/#80001a58 .*AIMED AT YOU BUT NOT REACHING YOU \(running at you, no closer in 2\d s, 12 m up: another floor/);
    });

    it('one hitting you is ATTACKING YOU, however long it has been aimed at you (the server\'s hits decide)', () => {
      dread(0x8000447a, 81, 21, 0, { seeks: { guid: ARC, kind: 'move' } });
      run(api, host, 21_000, { physics: false });
      api.pushChat('Dread Mu-miyah grazes your upper arm for 3 points of bludgeoning damage!', 0x15);
      api.pushChat('Dread Mu-miyah grazes your chest for 5 points of bludgeoning damage!', 0x15);
      const line = formatObservation(api.observe()).split('\n').find((l) => l.trim().startsWith('#8000447a'))!;
      expect(line).toMatch(/ATTACKING YOU \(2× in 10 s\)/);
      expect(line).not.toMatch(/NOT REACHING/);
    });

    it('a caster turned to face you from another floor is not "not reaching you" (a spell needs no path)', () => {
      dread(0x80009999, 85, 20, 6, { name: 'Lich', seeks: { guid: ARC, kind: 'turn' } } as Partial<AgentHostObject>);
      run(api, host, 21_000, { physics: false });
      const line = formatObservation(api.observe()).split('\n').find((l) => l.includes('#80009999'))!;
      expect(line).toMatch(/COMING AT YOU \(turned to face you/);
      expect(line).not.toMatch(/NOT REACHING/);
    });
  });

  describe('4. a refused bolt with no open spot within 3 m names a fellow whose place has the line', () => {
    const MU = 0x80003480;
    beforeEach(() => {
      host.spells = () => [{ id: 84, name: 'Flame Bolt V', school: 'War', level: 5, projectile: true, range: 60 }];
      host.me.mana = { current: 300, max: 330 };
      host.cast = () => { throw new Error('a refused cast must not go out'); };
      dread(MU, 84, 25, 0);
      fellows();
      host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, cell: ROOM, x: 86, y: 28, z: 0 });
      host.lineOfFire = () => ({ dist: 6.4, blockedAt: 1.9, blocker: 'a wall' });
      host.lineOfFireOpenSpot = () => null;
    });

    async function settle(p: Promise<AgentResult>): Promise<AgentResult> {
      let out: AgentResult | undefined;
      void p.then((r) => { out = r; });
      for (let t = 0; t < 10_000 && out === undefined; t += 100) { run(api, host, 100, { physics: false }); await vi.advanceTimersByTimeAsync(100); }
      if (!out) throw new Error('cast never answered');
      return out;
    }

    it('open from Bulwark: walk_to him (what Arcanist did by hand after 6 of 40 refusals)', async () => {
      host.lineOfFireFrom = (g, from) => (g === MU && from === BULWARK ? { dist: 3.6, blockedAt: null } : null);
      const r = await settle(api.cast('Flame Bolt V', MU));
      expect(r.ok).toBe(false);
      expect(r.message).toBe('Flame Bolt V not cast: no line of fire to Dread Mu-miyah (6.4 m away): a wall 1.9 m along the line would take the bolt. No spot within 3 m of you has an open line, but where Claude Bulwark stands (10 m NE of you) has: walk_to target="Claude Bulwark" within=2, if it stays put. Then cast.');
    });

    it('blocked from Bulwark too (or the host can\'t say): the old advice', async () => {
      host.lineOfFireFrom = () => ({ dist: 3.6, blockedAt: 1, blocker: 'a wall' });
      expect((await settle(api.cast('Flame Bolt V', MU))).message).toMatch(/No spot within 3 m of you has an open line: go round the corner, into its room, or let it come to you\. Then cast\.$/);
      host.lineOfFireFrom = undefined;
      expect((await settle(api.cast('Flame Bolt V', MU))).message).toMatch(/No spot within 3 m of you has an open line: go round the corner/);
    });
  });
});

describe('4. ServerObjectManager.lineOfFireFrom: the same bolt path, from where a fellow stands', () => {
  const T = 0x80003480, F = 0x500000a4;
  const som = new ServerObjectManager({ loadSetupModel: () => null } as never, {} as never, new THREE.Scene());
  som.missileLocalPlayer = () => ({ x: 100, y: 100, z: 0, radius: 0.68, height: 1.835, physicsRadius: 0.48 });
  som.missileObjectSweep = () => null;
  // A floor at z 0, and a wall across y = 103 for x < 104: the Dread 6 m north is behind it from you, not from x 106.
  som.missileEnvironmentSweep = (from, to, r) => {
    for (let i = 1; i <= 200; i++) {
      const t = i / 200, x = from.x + (to.x - from.x) * t, y = from.y + (to.y - from.y) * t, z = from.z + (to.z - from.z) * t;
      if (z - r < 0) return { t: (i - 1) / 200, normal: { x: 0, y: 0, z: 1 } };
      if (x < 104 && Math.abs(y - 103) < r && z < 3) return { t: (i - 1) / 200, normal: { x: 0, y: -1, z: 0 } };
    }
    return null;
  };
  const objects = (som as unknown as { objects: Map<number, ServerObject> }).objects;
  objects.set(T, { guid: T, name: 'Dread Mu-miyah', itemType: ItemType.Creature, physicsState: 0, mesh: new THREE.Group(), setupId: 0, worldX: 105, worldZ: 106, worldY: 0, collisionRadius: 0.5, collisionHeight: 1.5 } as unknown as ServerObject);
  objects.set(F, { guid: F, name: 'Claude Bulwark', itemType: ItemType.Creature, physicsState: 0, mesh: new THREE.Group(), setupId: 0, worldX: 106, worldZ: 100, worldY: 0, collisionRadius: 0.5, collisionHeight: 1.8 } as unknown as ServerObject);

  it('blocked from you, open from Bulwark (his place, your body)', () => {
    expect(som.lineOfFire(T)?.blockedAt).not.toBeNull();
    const from = som.lineOfFireFrom(T, F)!;
    expect(from.blockedAt).toBeNull();
    expect(from.dist).toBeCloseTo(Math.hypot(1, 6), 1);
  });

  it('unknown fellow or target: null', () => {
    expect(som.lineOfFireFrom(T, 0x50000999)).toBeNull();
    expect(som.lineOfFireFrom(0x80009999, F)).toBeNull();
  });
});
