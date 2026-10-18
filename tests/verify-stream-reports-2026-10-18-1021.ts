/**
 * Stream reports, 2026-10-18 09:21–10:22Z (build a2366cf6): Claude Bulwark and Claude Arcanist back in Holtburg after
 * the doll dungeon. Each block is one report item, its cause proven first from the transcripts and page logs:
 *
 * 1. `walk_to target="42.6N 33.6E"` "took me 250 m south into the gaming hall": it parsed right (the walk set off for a
 *    goal 411 m N, 10:05:51Z); Bulwark started in the pawn shop (A9B2, 0xA9B20114), whose doorway route out runs through
 *    the gaming hall next door, and he stopped it 36 s in. The readers did differ at the edges ("42.6N33.6E" and
 *    "42.6N;33.6E" fell through to a name search): now one reader, and the walk's task line says how far is left.
 * 2. The upstairs Scrivener of Life Magic (0xA9B30107): the body ended in the nook under the stairs beside the Apprentice
 *    Scrivener of Creature Magic, every search on foot was walled in by his disk, and the jump search (portals only)
 *    planned a 0.6 m hop through his body that landed back on its take-off: the same loop until "went round in circles",
 *    three walks running. Reproduced on the real cells once the harness's flights meet NPC bodies as the live body's do.
 *    The buy's "stopped 116.1 m away" was the straight distance 45 s into a 300 m walk from the pawn shop.
 * 3. `items="Trade Note (1,000), …"` split inside the parentheses.
 * 4. `buy items="Stamina Elixir" amount=6` bought one: amount= was read only beside item=.
 * 5. "gone from your pack: Ring (and 2 more in 2 other stacks: #8000ee4d x1, #800105be x1)": the drained ring's line
 *    listed his two WORN rings as other stacks of it.
 * 6. The Pumpkin Buffer stopped a walk (10:00:12Z): the 08:20Z launch served the game on a new Vite port (3139, was
 *    3133), the saved agent memory (creatures seen only buffing you) was restored for the old origin only, and the next
 *    save wrote the empty page over the file. ACE's weenie 32205 is Attackable (PropertyBool 19 True), ItemUseable No,
 *    a spell book of Incantation buffs: a monster to the server, harmless only by what it was seen doing.
 * 7. Small Mana Charge (weenie 4613: ItemCurMana 175, Value 650) for 1,105 at the Pawn Shopkeep (650 × 1.7): retail.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { isMapCoordsText, isPartialMapCoordsText, parseMapCoordsText } from '../packages/shared/src/mapCoordsText.ts';
import { navUnits } from '../packages/shared/src/routines/vtankExport.ts';
import { AgentApi, parseMapCoords } from '../packages/renderer/src/agent/AgentApi.ts';
import { flightCrossesDisk } from '../packages/renderer/src/agent/navPlanner.ts';
import type { AgentHost } from '../packages/renderer/src/agent/AgentApi.ts';
import { TOOL_BY_NAME, TOOL_CALLER, sellList, splitNameList, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { parseCliArgs } from '../tools/ac-agent/cli.ts';
import { parseSpawnsQuery } from '../tools/stream/spawns.ts';
import { parseCoords } from '../tools/stream/own-time.ts';
import { mergePageStorage, gameOriginOf, readPageStorage, restorePageStorageScript, writePageStorage, pageStorageFile } from '../tools/ac-agent/pageStorage.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import type { DungeonNav } from './_harness/dungeonNav.js';
import type { Ac1999Fixture } from './_harness/ac1999Fixtures.js';

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { host.t += 100; await vi.advanceTimersByTimeAsync(100); host.physics(100); api.tick(); }
  return out;
}

/** The real tool table over a caller that records each page call. */
function recorder(answer: (method: string, args: unknown[]) => { ok: boolean; message: string } = (m) => ({ ok: true, message: `${m} done` })) {
  const calls: Array<[string, unknown[]]> = [];
  const caller: ToolCaller = { notice: null, call: async <T,>(method: string, args?: unknown[]) => { calls.push([method, args ?? []]); return answer(method, args ?? []) as T; } };
  const tool = async (name: string, cli: string[]): Promise<{ text: string; isError?: boolean }> => {
    const t = TOOL_BY_NAME.get(name)!;
    return TOOL_CALLER.run(caller, () => t.run(parseCliArgs(t, cli)));
  };
  return { calls, tool };
}

let host: FakeHost;
let api: AgentApi;
beforeEach(() => {
  vi.useFakeTimers();
  host = new FakeHost();
  api = new AgentApi(host);
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe('1. map coordinates with or without a comma, any spacing; half a pair refused', () => {
  const FORMS = ['42.6N 33.6E', '42.6N, 33.6E', '42.6N,33.6E', '42.6N33.6E', '42.6 N 33.6 E', '42.6n; 33.6e', '42.6N / 33.6E', '  42.6 North, 33.6 East  '];

  it('every form reads as the same place, in the walk, the routine export, and the stream tools', () => {
    for (const f of FORMS) {
      expect(parseMapCoordsText(f), f).toEqual({ ns: 42.6, ew: 33.6 });
      expect(isMapCoordsText(f), f).toBe(true);
      expect(parseMapCoords(f), f).toEqual(parseMapCoords('42.6N, 33.6E'));
      expect(navUnits(f), f).toEqual({ ns: 42.6, ew: 33.6 });
      expect(parseCoords(f), f).toEqual({ ns: 42.6, ew: 33.6 });
    }
    expect(parseMapCoordsText('10.2S 8.1W')).toEqual({ ns: -10.2, ew: -8.1 });
    expect(parseMapCoordsText('.5S, 3E')).toEqual({ ns: -0.5, ew: 3 });
    expect(parseSpawnsQuery('"Pristine Doll" near 10.2S8.1E')).toEqual({ name: 'Pristine Doll', near: { ns: -10.2, ew: 8.1 } });
    // Names are not coordinates.
    for (const name of ['Sedor Wystan the Blacksmith', 'Trade Note (1,000)', 'Claude Arcanist', '10m north', '0xA9B30107']) {
      expect(isMapCoordsText(name), name).toBe(false);
      expect(isPartialMapCoordsText(name), name).toBe(false);
    }
    for (const half of ['42.6N', '42.6N 33.6', '33.6E', '42.6N 33.6Q']) expect(isPartialMapCoordsText(half), half).toBe(true);
  });

  it('walk_to hands every form to the page as the text (never a name search), and half a pair is refused there', async () => {
    const { calls, tool } = recorder();
    for (const f of ['42.6N 33.6E', '42.6N33.6E', '42.6N, 33.9E']) await tool('ac_walk_to', [`target=${f}`]);
    expect(calls.map(([m, a]) => [m, a[0]])).toEqual([['walkTo', '42.6N 33.6E'], ['walkTo', '42.6N33.6E'], ['walkTo', '42.6N, 33.9E']]);
    const r = await api.walkTo('42.6N 33.6');
    expect(r).toEqual({ ok: false, message: '"42.6N 33.6" is not whole map coordinates: give both halves, north/south then east/west ("42.6N, 33.6E", or "42.6N 33.6E")' });
    expect(host.keys.size).toBe(0);
  });

  it('the comma-less form walks to the same goal, and the task line says how far is left and which way', async () => {
    // Holtburg, 0xA9B40019 (80, 20): 42.6N 33.6E is ~112 m N.
    for (const f of ['42.6N 33.6E', '42.6N33.6E', '42.6N, 33.6E']) {
      host = new FakeHost(); api = new AgentApi(host);
      void api.walkTo(f);
      run(api, host, 1000);
      const task = api.self()?.task ?? '';
      expect(task, f).toMatch(new RegExp(`^walking to ${f.replace(/[.,]/g, '\\$&')} \\(1\\d\\d m N to go\\)$`));
      api.stopMoving();
    }
  });
});

describe('3. items= splits between names only: never in parentheses or quotes, nor a thousands comma', () => {
  it('the list readers', () => {
    expect(sellList('Trade Note (1,000), Trade Note (1,000), Trade Note (1,000)')).toEqual(['Trade Note (1,000)', 'Trade Note (1,000)', 'Trade Note (1,000)']);
    expect(splitNameList('"Trade Note (1,000)", Mana Stone; \'Stamina Elixir\'')).toEqual(['Trade Note (1,000)', 'Mana Stone', 'Stamina Elixir']);
    expect(splitNameList('Trade Note 1,000, Asheron\'s Ring')).toEqual(['Trade Note 1,000', "Asheron's Ring"]);
    expect(splitNameList('Bracelet, High Mana Charge, High Mana Charge')).toEqual(['Bracelet', 'High Mana Charge', 'High Mana Charge']);
    expect(sellList('["Trade Note (1,000)", "Mana Stone"]')).toEqual(['Trade Note (1,000)', 'Mana Stone']);
  });

  it('buy and sell send each whole name (three notes listed are three of one)', async () => {
    const { calls, tool } = recorder();
    const r = await tool('ac_buy', ['vendor=Sedor Wystan the Blacksmith', 'items=Trade Note (1,000), Trade Note (1,000), Trade Note (1,000), Mana Stone']);
    expect(r.isError).toBeUndefined();
    // The window opened once first, then a buy per name; a sell list is one page call (2026-10-18 12:24Z).
    expect(calls).toEqual([['vendorReady', ['Sedor Wystan the Blacksmith']], ['buy', ['Trade Note (1,000)', 3, 'Sedor Wystan the Blacksmith']], ['buy', ['Mana Stone', 1, 'Sedor Wystan the Blacksmith']]]);
    calls.length = 0;
    await tool('ac_sell', ['items="Covenant Pauldrons (Bronze)", Ring']);
    expect(calls).toEqual([['sellList', [['Covenant Pauldrons (Bronze)', 'Ring'], null, null]]]);
  });
});

describe('4. amount= (count=, quantity=) beside items= counts the one name; with several it is refused', () => {
  it('buy items="Stamina Elixir" amount=6 buys six (was one)', async () => {
    const { calls, tool } = recorder();
    await tool('ac_buy', ['vendor=Pawn Shopkeep', 'items=Stamina Elixir', 'amount=6']);
    await tool('ac_buy', ['items=Stamina Elixir', 'count=4']);
    await tool('ac_buy', ['item=Stamina Elixir', 'quantity=2']);
    expect(calls).toEqual([['buy', ['Stamina Elixir', 6, 'Pawn Shopkeep']], ['buy', ['Stamina Elixir', 4]], ['buy', ['Stamina Elixir', 2]]]);
  });

  it('several names (or one listed twice) with amount=: refused, nothing bought', async () => {
    const { calls, tool } = recorder();
    const a = await tool('ac_buy', ['items=Stamina Elixir, Mana Potion', 'amount=6']);
    expect(a.isError).toBe(true);
    expect(a.text).toBe('ac_buy: amount= counts one item, and items= names 2 (Stamina Elixir, Mana Potion): list a name as many times as you want of it, or call buy once per item with item= and amount=');
    const b = await tool('ac_buy', ['items=Stamina Elixir, Stamina Elixir', 'amount=6']);
    expect(b.text).toMatch(/^ac_buy: amount= counts one item, and items= names one 2 times/);
    const c = await tool('ac_buy', ['items=Stamina Elixir', 'amount=0']);
    expect(c.text).toBe('ac_buy: amount= must be a whole number, 1 or more (got 0)');
    expect(calls).toEqual([]);
  });

  it('sell takes it the same way, and give takes count= / quantity= for amount=', async () => {
    const { calls, tool } = recorder();
    await tool('ac_sell', ['items=Pyreal Mote', 'amount=3']);
    const refused = await tool('ac_sell', ['items=Ring, Bracelet', 'count=2']);
    expect(refused.isError).toBe(true);
    await tool('ac_give', ['item=Stamina Elixir', 'target=Claude Bulwark', 'count=3']);
    await tool('ac_give', ['item=Stamina Elixir', 'target=Claude Bulwark', 'quantity=2']);
    expect(calls).toEqual([['sell', ['Pyreal Mote', 3]], ['give', ['Stamina Elixir', 'Claude Bulwark', 3]], ['give', ['Stamina Elixir', 'Claude Bulwark', 2]]]);
  });
});

describe('5. a mana stone draining a ring: only what left you is gone, named as destroyed; worn namesakes are not stacks', () => {
  const STONE = 0x80010001, JUNK = 0x8000aaaa, WORN_L = 0x8000ee4d, WORN_R = 0x800105be, TASSETS = 0x80010419;

  beforeEach(() => {
    host.inv = [
      { guid: STONE, name: 'Mana Stone', where: 'pack', itemType: 0x80000 },
      { guid: JUNK, name: 'Ring', where: 'pack', itemType: 0x8 },
      { guid: WORN_L, name: 'Ring', where: 'equipped', slot: 'LeftRing', itemType: 0x8 },
      { guid: WORN_R, name: 'Ring', where: 'equipped', slot: 'RightRing', itemType: 0x8 },
      { guid: TASSETS, name: 'Yoroi Tassets', where: 'equipped', itemType: 0x2 },
    ];
    for (const i of host.inv) host.add({ guid: i.guid, name: i.name, cell: null as unknown as number, x: 0, y: 0 });
    host.useWithTarget = (s, t) => {
      host.sent.push(`usewith ${s.toString(16)} ${t.toString(16)}`);
      setTimeout(() => {
        // ACE ManaStone.HandleActionUseOnTarget: the drain line, then the item destroyed (and gone from the pack).
        api.pushChat('The Mana Stone drains 412 points of mana from the Ring.\nThe Ring is destroyed.', 0x00);
        host.inv = host.inv.filter((i) => i.guid !== JUNK);
      }, 400);
      return true;
    };
  });

  it('no item-slot rows: the ring drained is gone (destroyed), by its id; the worn rings are never listed', async () => {
    const r = (await settle(api, host, api.useOnReported(STONE, JUNK), 12_000))!;
    expect(r.message).toContain('gone from your pack: Ring #8000aaaa (destroyed)');
    expect(r.message).not.toContain('#8000ee4d');
    expect(r.message).not.toContain('#800105be');
    expect(r.message).not.toMatch(/other stacks?/);
  });

  it('with the client\'s slot rows (rings stack to 1): the same', async () => {
    (host as unknown as { itemSlots: AgentHost['itemSlots'] }).itemSlots = () => host.inv.map((i, n) => ({ guid: i.guid, name: i.name, packSlot: n, stack: 1, maxStack: 1, wcid: 1, isPack: false, equipped: i.where === 'equipped' }));
    const r = (await settle(api, host, api.useOnReported(STONE, JUNK), 12_000))!;
    expect(r.message).toContain('gone from your pack: Ring #8000aaaa (destroyed)');
    expect(r.message).not.toMatch(/other stacks?|#8000ee4d|#800105be/);
  });

  it('a stackable one still names the other stacks in the pack, never a worn one', async () => {
    host.inv = [
      { guid: 0x8000cd92, name: 'Stamina Elixir', where: 'pack', stack: 1 },
      { guid: 0x8000e175, name: 'Stamina Elixir', where: 'pack', stack: 12 },
    ];
    (host as unknown as { itemSlots: AgentHost['itemSlots'] }).itemSlots = () => host.inv.map((i, n) => ({ guid: i.guid, name: i.name, packSlot: n, stack: i.stack ?? 1, maxStack: 100, wcid: 1, isPack: false, equipped: false }));
    host.add({ guid: 0x8000cd92, name: 'Stamina Elixir', cell: null as unknown as number, x: 0, y: 0 });
    host.use = (g) => { host.sent.push(`use ${g.toString(16)}`); setTimeout(() => { api.pushChat('The Stamina Elixir restores 65 points of your Stamina.', 0x05); host.inv = host.inv.filter((i) => i.guid !== 0x8000cd92); }, 500); return true; };
    const r = (await settle(api, host, api.use(0x8000cd92), 8000))!;
    expect(r.message).toContain('gone from your pack: Stamina Elixir #8000cd92 (and 12 more in another stack: #8000e175 x12)');
  });
});

describe('6. the agent memory follows the game page to a new Vite port, and a save never wipes what the file held', () => {
  class FakeStorage {
    m = new Map<string, string>();
    get length(): number { return this.m.size; }
    key(i: number): string | null { return [...this.m.keys()][i] ?? null; }
    getItem(k: string): string | null { return this.m.get(k) ?? null; }
    setItem(k: string, v: string): void { this.m.set(k, String(v)); }
  }
  const inPage = (js: string, origin: string, storage: FakeStorage): unknown => new Function('location', 'localStorage', `return ${js}`)({ origin }, storage);
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
  const SEEN = JSON.stringify([['pumpkin buffer', { spells: [['Incantation of Strength Other', 0]], maxHit: 0, words: false }]]);

  it('saved on 3133, restored into the 3139 launch (the daemon names its game origin); a stranger origin still gets nothing', () => {
    const saved = { origin: 'http://localhost:3133', items: [['acAgent.seenKinds.Claude Bulwark', SEEN], ['acAgent.places.Claude Bulwark', '[]']] as Array<[string, string]> };
    const url = 'http://localhost:3139/?ace&agent&bridge=ws://localhost:9131&account=claudebulwark&password=claudebulwark';
    expect(gameOriginOf(url)).toBe('http://localhost:3139');
    const page = new FakeStorage();
    inPage(restorePageStorageScript(saved, gameOriginOf(url)), 'http://localhost:3139', page);
    expect(page.getItem('acAgent.seenKinds.Claude Bulwark')).toBe(SEEN);
    const other = new FakeStorage();
    inPage(restorePageStorageScript(saved, gameOriginOf(url)), 'https://playwebac.com', other);
    expect(other.length).toBe(0);
  });

  it('a page that started without the memory saves over the file without wiping it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acjs-pagestorage-1021-')); dirs.push(dir);
    const file = pageStorageFile(dir, 'soldier');
    writePageStorage(file, { origin: 'http://localhost:3133', items: [['acAgent.seenKinds.Claude Bulwark', SEEN], ['acAgent.places.Claude Bulwark', '[["Pawn shop",1]]']] });
    // The 3139 page's first save: its places only (it learned nothing yet of the Pumpkin Buffer).
    writePageStorage(file, mergePageStorage(readPageStorage(file), { origin: 'http://localhost:3139', items: [['acAgent.places.Claude Bulwark', '[["Pawn shop",1],["Scriveners",2]]'], ['acjs.options', '{}']] }));
    const now = readPageStorage(file)!;
    expect(now.origin).toBe('http://localhost:3139');
    expect(Object.fromEntries(now.items)).toEqual({ 'acAgent.seenKinds.Claude Bulwark': SEEN, 'acAgent.places.Claude Bulwark': '[["Pawn shop",1],["Scriveners",2]]' });
  });
});

describe('2. the use\'s give-up distance is the straight one to the object, said with where the walk set off', () => {
  let saved: number;
  beforeEach(() => { saved = AgentApi.USE_APPROACH_MS; AgentApi.USE_APPROACH_MS = 5000; });
  afterEach(() => { AgentApi.USE_APPROACH_MS = saved; });

  it('a vendor 120 m off and a floor up: "stopped N m away, 3 m above you … (straight-line; it was 120 m off …)"', async () => {
    const V = 0x7a9b3015;
    // In the hall (an interior cell): the use walks the doorway route there first (approach), as in Holtburg.
    host.add({ guid: V, name: 'Scrivener of Life Magic', itemType: 0x10, cell: ((HOLTBURG & 0xffff0000) | 0x0107) >>> 0, x: 80, y: 140, z: 97 });
    host.routeTo = [{ x: 80, y: 130, z: 94 }];
    const r = (await settle(api, host, api.use(V), 20_000))!;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^couldn't reach Scrivener of Life Magic: walking to Scrivener of Life Magic took longer than 5 s and stopped (\d+\.\d) m away, 3 m above you; ac_walk_to it first \(it can take longer\), then use it \(straight-line; it was 120 m off when the walk set off\)/);
    const d = Number(/stopped (\d+\.\d) m away/.exec(r.message)![1]);
    expect(d).toBeCloseTo(Math.hypot(host.me.x - 80, host.me.y - 140), 0);
  });
});

describe('2b. a flight from inside a disk (pressed on an NPC) may leave it, never go deeper', () => {
  it('flightCrossesDisk', () => {
    const npc = { x: 0, y: 0, z: 0, r: 0.96, span: 1.5 };
    // Outside: a flight over its middle crosses it.
    expect(flightCrossesDisk({ x: -2, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, [npc])).toBe(true);
    // Inside at 0.95 m: away is fine, across its middle is not.
    expect(flightCrossesDisk({ x: 0.5, y: 0.81, z: 0 }, { x: 1.4, y: 1.6, z: 0 }, [npc])).toBe(false);
    expect(flightCrossesDisk({ x: 0.5, y: 0.81, z: 0 }, { x: 0.5, y: 0.2, z: 0 }, [npc])).toBe(true);
  });
});

/**
 * The Holtburg scriveners' hall on the real cells (cell DAT, landblock 0xA9B3) and its people (ACE-World-16PY-Patches
 * 6 LandBlockExtendedData/A9B3.sql; Setups from each weenie: 0x02000001 / 0x0200004E humans, 0x0200196F the Void
 * scrivener, every one 0.48 m spheres). The doors work as ACE's (a Use waits for the body within 2 m on the door's storey).
 */
const LB = 0xa9b30000;
const door = (guid: number, x: number, y: number, z: number, qw: number, qz: number): Ac1999Fixture => ({
  guid, wcid: 412, name: 'Door', cell: LB, x, y, z, quat: { w: qw, x: 0, y: 0, z: qz }, setupId: 0x0200027c, itemType: 128, physicsState: 8, locked: false, door: true,
});
const npc = (guid: number, wcid: number, name: string, cell: number, x: number, y: number, z: number, qw: number, qz: number, setupId: number): Ac1999Fixture => ({
  guid, wcid, name, cell: (LB | cell) >>> 0, x, y, z, quat: { w: qw, x: 0, y: 0, z: qz }, setupId, itemType: 0x10, physicsState: 0x200418, locked: false, door: false,
});
const H = 0x02000001, E = 0x0200004e;
const HALL: Ac1999Fixture[] = [
  door(0x7a9b3004, 180.2, 77.59, 116.01, 1, 0),
  door(0x7a9b3005, 184.695, 82.545, 115.995, 0.707107, 0.707107),
  door(0x7a9b3006, 183.245, 83.895, 118.995, 1, 0),
  door(0x7a9b3007, 182.21, 80.19, 119, 0.707107, 0.707107),
  npc(0x7a9b3008, 20215, 'Apprentice Scrivener of Item and War Magic', 0x101, 183.749, 79.9449, 116.005, -0.930324, -0.36674, H),
  npc(0x7a9b3009, 20217, 'Apprentice Scrivener of Life Magic', 0x102, 184.705, 85.6623, 116.005, -0.640611, -0.767865, H),
  npc(0x7a9b300a, 20205, 'Apprentice Scrivener of Creature Magic', 0x103, 178.117, 85.9785, 116.005, 0.34272, -0.939438, E),
  npc(0x7a9b300b, 20206, 'Apprentice Scrivener of Creature Magic', 0x108, 184.705, 85.1611, 119.005, 0.844368, 0.535764, H),
  npc(0x7a9b300c, 20218, 'Apprentice Scrivener of Life Magic', 0x107, 176.794, 82.1942, 119.005, -0.514346, 0.857583, E),
  npc(0x7a9b300d, 20216, 'Apprentice Scrivener of Item and War Magic', 0x000, 184.004, 79.7872, 119.005, -0.861887, -0.507101, E),
  npc(0x7a9b3013, 43354, 'Scrivener of Void Magic', 0x103, 177.444, 79.747, 116.005, 0.812668, -0.582727, 0x0200196f),
  npc(0x7a9b3014, 20221, 'Journeyman Scrivener of Life Magic', 0x107, 177.083, 80.4695, 119.005, 0.910962, -0.412491, E),
  npc(0x7a9b3015, 20222, 'Scrivener of Life Magic', 0x107, 178.599, 79.0302, 119.005, 0.988955, -0.148218, H),
  npc(0x7a9b3016, 20209, 'Journeyman Scrivener of Creature Magic', 0x108, 184.464, 86.8825, 119.005, -0.561384, -0.827555, E),
  npc(0x7a9b3017, 20210, 'Scrivener of Creature Magic', 0x108, 182.096, 88.1446, 119.005, -0.287065, -0.957911, E),
  npc(0x7a9b3018, 20226, 'Scrivener of War Magic', 0x100, 182.336, 87.0061, 116.005, -0.001401, -0.999999, E),
  npc(0x7a9b3019, 20225, 'Journeyman Scrivener of War Magic', 0x103, 175.884, 81.6084, 116.005, 0.681133, -0.732159, H),
];

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('2. up the Holtburg scriveners\' stairs to the Scrivener of Life Magic (0xA9B30107, real cells)', () => {
  let nav: DungeonNav;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.js');
    nav = await dungeonNav(LB, { statics: true });
  }, 120_000);

  const starts = [
    // Where Arcanist's three walks stood and gave up (10:05:40, 10:06:13, 10:06:53Z): the nook under the stairs, the
    // Apprentice Scrivener of Creature Magic 1.0 m SW.
    { what: 'the nook beside the Apprentice Scrivener of Creature Magic', cell: 0xa9b30103, at: { x: 178.6, y: 86.8, z: 116 } },
    // Inside the front door (0x0105), where the walk in from the street comes.
    { what: 'the front hall', cell: 0xa9b30105, at: { x: 180.2, y: 78.6, z: 116 } },
  ];
  for (const s of starts) {
    it(`from ${s.what}: up the stairs to him, no hop through anyone's body`, async () => {
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      const dh = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { fixtures: HALL, creatures: true, serverMoveTo: true });
      dh.objectReach = (g) => ((dh.object(g)?.itemType ?? 0) & 0x10 ? 0.48 : 0);
      try {
        const r = await dh.walkTarget(s.cell, s.at, 0x7a9b3015, { maxMs: 150_000, timeoutMs: 120_000 });
        expect(r, dh.traces.join('\n')).toMatchObject({ ok: true });
        expect(r.message).toMatch(/^arrived \(\d\.\d m from Scrivener of Life Magic\)/);
        expect(dh.me.z, dh.traces.join('\n')).toBeGreaterThan(118.5);
        expect(dh.me.cell).toBe(0xa9b30107);
        // Never a jump that came down on its own take-off (the loop that went "round in circles").
        expect(dh.traces.filter((l) => /landed off the plan .* back on its take-off/.test(l))).toEqual([]);
        for (const l of dh.traces) {
          const m = /walk jump from \(([\d.]+), ([\d.]+), z [\d.]+\).*landing \(([\d.]+), ([\d.]+), z/.exec(l);
          if (!m) continue;
          // The planned landing clears the Apprentice of Creature Magic's body (0.48 + 0.48 m).
          const lx = Number(m[3]) - 169 * 192, ly = Number(m[4]) - 179 * 192;
          expect(Math.hypot(lx - 178.117, ly - 85.9785), l).toBeGreaterThan(0.96);
        }
      } finally {
        dh.dispose();
      }
    }, 300_000);
  }
});
