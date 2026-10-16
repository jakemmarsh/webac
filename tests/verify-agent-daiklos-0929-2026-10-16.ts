/**
 * The stream players' 09:29Z reports (2026-10-16, end of retail, local ACE, Daiklos Dungeon 0x0185, segment 08:27–09:29Z,
 * build d08a8e31; transcripts stream/sessions/{mage,soldier}-2026-10-16-seg1.jsonl, page logs mage.log / soldier.log,
 * reports stream/reports/*2026-10-16T09-29*.md):
 *
 * 1. `walk_to target="Claude Arcanist"` (09:19:02, Bulwark in 0x018501E5) answered "in your fellowship but not in view"
 *    while the observe a second before had her 43 m SE, 6 m down: walk_to / follow now go to where she was last seen.
 * 2. The Pumpkin Buffer set off fellow-aggro (08:51:14): its buffs on Bulwark after the 08:27 reload all read "…cast X on
 *    you, refreshing Y" (ACE's stacking suffix), which noteSeen didn't read, so it never counted as harmless. Read now,
 *    and what a kind did is kept per character in browser storage.
 * 3. Arcanist's /f line "… it casts drains/bolts and shrugs off fire …" woke a wait as cast-at-you (09:05:14): no event
 *    is read from anyone's words now (speech, tells, emotes, chat channels), and the readers that judged a refusal or a
 *    hit from any chat line skip them too.
 * 4. Cell ids: world-query prints cell columns in hex (Bulwark turned the DB's decimal 25493832 into "0x01850248", a cell
 *    Daiklos hasn't), lore lists the rooms a monster is placed in, walk_to a cell the landblock hasn't says which it has.
 * 5. The Mu-miyah floor (z −24) is reachable on foot (cell DAT, landblock 0x0185: one door-connected graph of 273 cells,
 *    no portal, lever or door in ACE's landblock_instance for 0x0185 besides the exit portal): DAT-gated walks below.
 * 6. stay_with stopping for a fellow who stands still says stay_with told them nothing and how to bring them along.
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, toGlobal } from '../packages/renderer/src/agent/AgentApi.ts';
import { pullLanded } from '../packages/renderer/src/agent/beyondVtank.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { cellIdRange, cellStandPoint, loadCellGraph, type CellGraph } from '../packages/renderer/src/agent/cellPath.ts';
import type { AgentEvent } from '../packages/renderer/src/agent/types.ts';
import { HOSTED_GUIDE } from '../tools/ac-agent/hostedGuide.ts';
import { TOOL_BY_NAME } from '../tools/ac-agent/tools.ts';
import { placedRooms } from '../tools/stream/lore.ts';
import { hexCellColumns } from '../tools/stream/world-query.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const ARCANIST = 0x500000a3;
const PUMPKIN = 0x800016fc;
const vitals = { cur: 40, max: 50 };
const DAIKLOS = 0x01850000;
const C = (c: number): number => (DAIKLOS | c) >>> 0;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('Daiklos 09:29Z reports (fake host)', () => {
  let host: FakeHost;
  let api: AgentApi;
  let traces: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.t = 100_000;
    api = new AgentApi(host);
    traces = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.join(' ')); });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  describe('1. a fellow out of your sight in a dungeon: walk_to / follow go to where they were last seen', () => {
    // Bulwark in a Daiklos room; Arcanist last placed 25 m north 12 s ago, then out of sight (the client let her go).
    const setup = (): void => {
      host.me = { ...host.me, cell: C(0x1e5), x: 40, y: -100, z: -6 };
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, cell: C(0x1d2), x: 40, y: -75, z: -6, lost: true, heardAt: host.t - 12_000 });
    };

    it('the observe fellows line says where she was last seen', () => {
      setup();
      expect(api.snapshot().fellows).toEqual([{ name: 'Claude Arcanist', healthPct: 80, lastSeen: '25 m N of you, 12 s ago' }]);
      expect(formatObservation(api.snapshot())).toContain('fellows: Claude Arcanist 80% HP, out of sight, last seen 25 m N of you, 12 s ago (walk_to Claude Arcanist goes there; they may have moved on)');
    });

    it('walk_to her name walks to her last-seen spot and says so (was "in your fellowship but not in view")', async () => {
      setup();
      const r = await settle(api, host, api.walkTo('Claude Arcanist'), 60_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(r!.message).toMatch(/^Claude Arcanist is out of your sight \(in a dungeon you see only the rooms in sight of yours\); going to where they were last seen: 25 m N of you, 12 s ago\n/);
      expect(r!.message).toMatch(/arrived \(\d\.\d m away\)/);
      expect(r!.message).toMatch(/Claude Arcanist isn't in sight from here: they moved on\. Ask in \/f where they are$/);
      expect(Math.hypot(host.me.x - 40, host.me.y - -75)).toBeLessThan(2.5);
    });

    it('…and when she is in sight from there, says where', async () => {
      setup();
      const r = await settle(api, host, api.walkTo('Claude Arcanist'), 60_000, () => {
        // She is placed again (in view) once you are near her last spot.
        if (host.me.y > -80) { const a = host.objs.get(ARCANIST)!; a.lost = false; a.heardAt = host.t; a.y = -70; }
      });
      expect(r!.ok).toBe(true);
      expect(r!.message).toMatch(/Claude Arcanist is in sight now: \d+ m N$/);
    });

    it('follow walks to the spot, then follows her from there', async () => {
      setup();
      const r = await settle(api, host, api.follow('Claude Arcanist', { durationMs: 6000 }), 60_000, () => {
        if (host.me.y > -80) { const a = host.objs.get(ARCANIST)!; a.lost = false; a.heardAt = host.t; a.y = -70; }
      });
      expect(r, traces.join('\n')).not.toBeNull();
      expect(r!.message).toMatch(/^Claude Arcanist is out of your sight .*going to where they were last seen: 25 m N of you/);
      expect(r!.message).toMatch(/in sight now/);
      expect(r!.message).toMatch(/followed Claude Arcanist for \d+ s/);
    });

    it('in view: the ordinary walk; somewhere else (another landblock): still "not in view"', async () => {
      setup();
      const a = host.objs.get(ARCANIST)!;
      a.lost = false; a.heardAt = host.t;
      expect(api.fellowLastSeen('Claude Arcanist')).toBeNull();
      const r = await settle(api, host, api.walkTo('Claude Arcanist'), 60_000);
      expect(r!.message).not.toMatch(/last seen/);
      a.lost = true; a.heardAt = host.t - 12_000; a.cell = 0x01f60289; // Holtburg Dungeon: another space
      expect(api.fellowLastSeen('Claude Arcanist')).toBeNull();
      const r2 = await settle(api, host, api.walkTo('Claude Arcanist'), 5000);
      expect(r2!.message).toMatch(/in your fellowship but not in view/);
    });
  });

  describe('2. the Pumpkin Buffer: its stacked buffs count, on you or your gear, and are remembered across a reload', () => {
    const table = (): void => {
      (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({
        spells: new Map([
          [4290, { name: 'Incantation of Armor Other', desc: '', category: 0, school: 3, bitfield: 0x4 | 0x1, power: 400 }],
          [4291, { name: 'Incantation of Focus Other', desc: '', category: 0, school: 3, bitfield: 0x4 | 0x1, power: 400 }],
          [4292, { name: 'Incantation of Blood Drinker', desc: '', category: 0, school: 4, bitfield: 0x4 | 0x1, power: 400 }],
        ]),
      });
    };
    const store = new Map<string, string>();
    const stubStorage = (): void => { vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } }); };

    it('"…on you, refreshing …" and "…on your Mace" are read: harmless, no fellow-aggro for it turning to a fellow', () => {
      table();
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 90, y: 40 });
      host.add({ guid: PUMPKIN, name: 'Pumpkin Buffer', itemType: 0x10, objectDescFlags: 0x10, x: 95, y: 60, level: 42, seeks: { guid: ARCANIST, kind: 'turn' } });
      expect(api.harmlessKind('Pumpkin Buffer')).toBe(false);
      // Bulwark's only lines from it after the 08:27 reload (soldier.chat.log 08:46:32).
      api.pushChat('Pumpkin Buffer cast Incantation of Armor Other on you, refreshing Incantation of Armor Other', 0x07);
      expect(api.harmlessKind('Pumpkin Buffer')).toBe(true);
      api.pushChat('Pumpkin Buffer cast Incantation of Blood Drinker on your Mace, surpassing Blood Drinker VI', 0x07);
      api.pushChat('Pumpkin Buffer cast Incantation of Focus Other on you, but it is surpassed by Focus Other VII', 0x07);
      expect(api.seenText('Pumpkin Buffer')).toMatch(/Incantation of Armor Other/);
      expect(api.seenText('Pumpkin Buffer')).toMatch(/Incantation of Blood Drinker/);
      expect(api.harmlessKind('Pumpkin Buffer')).toBe(true);
      run(api, host, 3000, { physics: false });
      expect(api.comingAt(ARCANIST)).toEqual([]);
      expect(api.eventsSince(0).filter((e) => e.type === 'fellow-aggro')).toEqual([]);
    });

    it('a new page for the same character remembers it (browser storage); another character does not', () => {
      stubStorage();
      store.clear();
      table();
      api.pushChat('Pumpkin Buffer cast Incantation of Armor Other on you, refreshing Incantation of Armor Other', 0x07);
      expect(api.harmlessKind('Pumpkin Buffer')).toBe(true);
      const reloaded = new AgentApi(host);
      expect(reloaded.harmlessKind('Pumpkin Buffer')).toBe(true);
      host.me = { ...host.me, name: 'Claude Other' };
      expect(new AgentApi(host).harmlessKind('Pumpkin Buffer')).toBe(false);
    });

    it('a harmful line from it still makes it a threat (and that is remembered too)', () => {
      stubStorage();
      store.clear();
      table();
      api.pushChat('Pumpkin Buffer cast Incantation of Armor Other on you', 0x07);
      api.pushChat('Pumpkin Buffer slashes your hand for 6 points of slashing damage!', 0x15);
      expect(api.harmlessKind('Pumpkin Buffer')).toBe(false);
      expect(new AgentApi(host).harmlessKind('Pumpkin Buffer')).toBe(false);
    });
  });

  describe('3. no event from anyone\'s words', () => {
    const fLine = '[Fellowship] Claude Arcanist says, "Shadow Wisp L50 SE, 10k XP but it casts drains/bolts and shrugs off fire. I\'ll use Force Bolt. Pull it if you\'re up for it, else we keep looking."';
    const castAtYou = (): AgentEvent[] => api.eventsSince(0).filter((e) => e.type === 'cast-at-you');

    it('Arcanist\'s /f line (09:05:14) is chat only, whatever its type says', () => {
      host.add({ guid: 0x80001234, name: 'Shadow Wisp', itemType: 0x10, objectDescFlags: 0x10, x: 90, y: 30 });
      api.pushChat(fLine, 0x13);
      api.pushChat(fLine);
      api.pushChat('Claude Arcanist says, "the Lich casts Drain Health Other II on you and runs"', 0x02);
      api.pushChat('Claude Arcanist tells you, "You resist the spell cast by Lich"', 0x03);
      expect(castAtYou()).toEqual([]);
      expect(api.eventsSince(0).filter((e) => e.type === 'chat')).toHaveLength(4);
      expect(api.seenText('Shadow Wisp')).toBeNull();
    });

    it('the server\'s own spell lines still raise it', () => {
      host.add({ guid: 0x80001235, name: 'Lich', itemType: 0x10, objectDescFlags: 0x10, x: 90, y: 30 });
      api.pushChat('Lich casts Drain Health Other II and drains 12 points of your health', 0x07);
      api.pushChat('You resist the spell cast by Lich', 0x07);
      expect(castAtYou()).toHaveLength(2);
    });

    it('spokenLine / spokenEvent by type and by shape; a pull is not "landed" by a fellow naming the target', () => {
      expect(AgentApi.spokenLine(fLine, 0x13)).toBe(true);
      expect(AgentApi.spokenLine(fLine)).toBe(true);
      expect(AgentApi.spokenLine('Lich says, "Zojak Equin"', 0x11)).toBe(false); // a creature's spell words
      expect(AgentApi.spokenLine('You resist the spell cast by Lich', 0x07)).toBe(false);
      const ev = (text: string, chatType?: number): AgentEvent => ({ seq: 1, t: 0, type: 'chat', text, ...(chatType !== undefined ? { chatType } : {}) });
      expect(AgentApi.spokenEvent(ev(`(channel) ${fLine}`, 0x13))).toBe(true);
      expect(AgentApi.spokenEvent(ev('(system) The Door is locked!', 0x05))).toBe(false);
      const target = { guid: 0x80000001, name: 'Drudge Skulker' };
      expect(pullLanded(target, [ev('(channel) [Fellowship] Claude Arcanist says, "you pull the Drudge Skulker, I\'ll bolt"', 0x13)], new Map())).toBeNull();
      expect(pullLanded(target, [ev('(combat) You hit the Drudge Skulker for 6 points of slashing damage!', 0x16)], new Map())).toMatch(/You hit/);
    });
  });

  describe('4. cell ids: hex in world-query, rooms in lore, walk_to names the cells a landblock has', () => {
    it('hexCellColumns: Bulwark\'s 09:12:30 query, obj_Cell_Id in hex with a walk_to footnote', () => {
      const table = [
        '+-------------+----------+----------+----------+-------------------+',
        '| obj_Cell_Id | origin_X | origin_Y | origin_Z | value             |',
        '+-------------+----------+----------+----------+-------------------+',
        '|    25493832 |  46.5848 |  -83.437 | -23.9935 | Horrible Mu-miyah |',
        '|    25493838 |  46.8046 | -96.6455 | -23.9935 | Horrible Mu-miyah |',
        '|    25493780 |  3.51838 | -93.7319 | -23.9935 | Horrible Mu-miyah |',
        '+-------------+----------+----------+----------+-------------------+',
        '',
      ].join('\n');
      const out = hexCellColumns(table);
      expect(out).toContain('| 0x01850148  | 46.5848  |');
      expect(out).toContain('0x0185014E');
      expect(out).toContain('0x01850114');
      expect(out).not.toContain('25493832');
      expect(out.split('\n').at(-1)).toBe('(cell ids in hex: `walk_to target=0x01850148` walks to that room when you\'re in that dungeon or building, landblock 0x0185)');
      // Every row is as wide as its rule.
      const lines = out.split('\n').slice(0, -1);
      expect(new Set(lines.map((l) => l.length)).size).toBe(1);
      // No cell column, or no ids in it: as mysql printed it.
      const plain = '+---+\n| n |\n+---+\n| 3 |\n+---+\n';
      expect(hexCellColumns(plain)).toBe(plain);
    });

    it('placedRooms: the dungeon rooms by landblock, with the walk_to form', () => {
      const line = placedRooms([25493832, 25493838, 25493780, 0xa9b40019, 0x013d0211])!;
      expect(line).toBe('  placed in rooms (landblock: cells): 0x013D: 0x013D0211; 0x0185: 0x01850114, 0x01850148, 0x0185014E. From inside that dungeon, `walk_to target=0x013D0211` walks to the room');
      expect(placedRooms([0xa9b40019])).toBeNull();
    });

    it('walk_to a cell the landblock hasn\'t: names the ids it has and how a decimal DB id converts', async () => {
      host.me = { ...host.me, cell: C(0x171), x: 37, y: -110, z: -18 };
      host.cellPoint = (c) => (c === C(0x148) ? { x: 46, y: -84, z: -24 } : null);
      host.cellRange = () => ({ first: C(0x100), last: C(0x210) });
      const r = await settle(api, host, api.walkTo('0x01850248'), 2000);
      expect(r).toEqual({ ok: false, message: 'walking to cell 0x01850248: this landblock has no such cell: its cells run 0x01850100 to 0x01850210. A world-DB obj_Cell_Id is a decimal number: convert it whole (25493832 is 0x01850148), or select it with HEX(obj_Cell_Id).' });
      host.cellSealed = () => true;
      expect((await settle(api, host, api.walkTo('0x01850248'), 2000))!.message).toMatch(/^walking to cell 0x01850248: this dungeon has no such cell/);
      // One in range with no floor keeps the old answer.
      expect((await settle(api, host, api.walkTo('0x01850101'), 2000))!.message).toMatch(/no floor in that cell to stand on/);
    });

    it('the tool text says a cell id is a walk target', () => {
      expect(TOOL_BY_NAME.get('ac_walk_to')!.description).toMatch(/by its cell id \(target=0x01850148/);
      expect(TOOL_BY_NAME.get('ac_walk_to')!.description).toMatch(/fellow out of your sight in a dungeon is walked to where they were last seen/);
      expect(TOOL_BY_NAME.get('ac_follow')!.description).toMatch(/first walked to where they were last seen/);
      expect(HOSTED_GUIDE).toMatch(/a cell by its id, target=0x01850148: a room of the dungeon you're in, or a building's room or an outdoor cell of any landblock/);
      // Any landblock's cells since the 11:01Z reports (walk_to 0xA9B20114 from the street).
      expect(TOOL_BY_NAME.get('ac_walk_to')!.description).toMatch(/a room or outdoor cell of any landblock on the landscape/);
    });
  });

  describe('6. stay_with: a fellow standing still', () => {
    it('the stop says stay_with told them nothing, and offers /f, follow, or walking on', async () => {
      host.wall = () => false;
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Bulwark', health: vitals, stamina: vitals, mana: vitals }];
      // 30 m behind you (south), standing.
      host.add({ guid: ARCANIST, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: -10, heardAt: host.t });
      const r = await settle(api, host, api.walkTo('300m north', { within: 2, stayWith: 'Claude Bulwark', timeoutMs: 600_000 }), 120_000,
        () => { host.objs.get(ARCANIST)!.heardAt = host.t; });
      expect(r!.ok).toBe(false);
      expect(r!.message).toMatch(/hasn't moved for \d+ s \(fighting, busy, stuck or waiting for you\?\)\. stay_with doesn't tell them you set off: say where you're going \(ac_say text="\/f heading 300 m N, come with me"\), follow them \(ac_follow target="Claude Bulwark"\), or walk on without waiting \(no stay_with\)/);
    });
  });
});

const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

describe.skipIf(!haveDat)('5. the real Daiklos Dungeon (0x0185): the Mu-miyah floor at z −24 is a walk', () => {
  let g: CellGraph;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    g = loadCellGraph(openDat(DAT_PATHS.cell), openDat(DAT_PATHS.portal), DAIKLOS);
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(DAIKLOS, { statics: true });
  }, 120_000);

  it('the cells: 0x0100–0x0210, the Mu-miyahs\' rooms on the −24 floor, no 0x0248', () => {
    expect(cellIdRange(g)).toEqual({ first: C(0x100), last: C(0x210) });
    for (const c of [0x114, 0x148, 0x14e]) expect(cellStandPoint(g, C(c))!.z).toBeCloseTo(-24, 0);
    expect(cellStandPoint(g, C(0x248))).toBeNull();
    // The entry (0x020F) and the top floor are at 0; the rooms they fought in at −6, −12 and −18.
    expect(cellStandPoint(g, C(0x20f))!.z).toBeCloseTo(0, 0);
    expect(cellStandPoint(g, C(0x171))!.z).toBeCloseTo(-18, 0);
  });

  const walk = async (from: number, to: number) => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      const h = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, DAIKLOS, { rooms: true });
      h.me.health = { current: 146, max: 146 };
      try {
        const r = await h.walkTarget(C(from), cellStandPoint(g, C(from))!, C(to), { maxMs: 400_000, timeoutMs: 400_000 });
        return { r, cell: h.me.cell >>> 0, z: h.me.z, at: toGlobal(h.me.cell, h.me.x, h.me.y), traces: h.traces };
      } finally { h.dispose(); }
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  };

  it('from the room under the entry (0x01EB, −6, where the rats were) to a Mu-miyah\'s room 0x0148: arrives at −24', async () => {
    const w = await walk(0x1eb, 0x148);
    expect(w.r, w.traces.join('\n')).toMatchObject({ ok: true });
    expect(w.r.message).toMatch(/^arrived/);
    expect(w.cell).toBe(C(0x148));
    expect(w.z).toBeCloseTo(-24, 0);
  }, 600_000);

  it('from the skeleton room where they parked (0x0171, −18) to 0x0114 and from the exit portal\'s room (0x0208, 0) to 0x014E', async () => {
    const a = await walk(0x171, 0x114);
    expect(a.r, a.traces.join('\n')).toMatchObject({ ok: true });
    expect(a.cell).toBe(C(0x114));
    const b = await walk(0x208, 0x14e);
    expect(b.r, b.traces.join('\n')).toMatchObject({ ok: true });
    expect(b.cell).toBe(C(0x14e));
    expect(b.z).toBeCloseTo(-24, 0);
  }, 900_000);
});
