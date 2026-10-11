/**
 * UtilityBelt's networking between your own clients, in a browser
 * (docs/vtank-parity-gaps.md §10.4, packages/renderer/src/agent/ubNet.ts):
 * tabs of one browser are the clients, over a BroadcastChannel. Here an
 * in-memory hub stands in for the channel, delivering asynchronously as a
 * BroadcastChannel does. Covered: /ub bc and bct (delays, tags, acks, no
 * bouncing), /ub netclients, Networking.Tags and VTank.VitalSharing through
 * /ub opt, vital and cast sharing, closed tabs dropped; and the commands and
 * the .usd / .af exports through the VirindiTank window.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { UbNet, activeUbNet, browserNetChannel, parseTags, setActiveUbNet, ubNetCommand, type NetChannel, type NetMessage, type NetSelf, type NetVitals } from '../packages/renderer/src/agent/ubNet.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { openDat } from './_harness/dat.js';
import { PropertyDataId, PropertyInt } from '@ac/shared';
import { ALL_MODULES_OFF, emptyRoutineDoc, emptyVtankData, importVTankFiles, parseAf, parseUsd, type RoutineDoc, type RoutineProfile } from '../packages/shared/src/routines/index.ts';

/** A BroadcastChannel stand-in: every other member gets each post, on a later turn. */
class Hub {
  private members: Array<{ fn: (m: NetMessage) => void; open: boolean }> = [];
  channel(): NetChannel {
    const me = { fn: (_m: NetMessage) => {}, open: true };
    this.members.push(me);
    return {
      post: (m) => { const copy = structuredClone(m); for (const o of this.members) if (o !== me && o.open) queueMicrotask(() => o.fn(copy)); },
      listen: (fn) => { me.fn = fn; },
      close: () => { me.open = false; },
    };
  }
}

const vitals = (h: number, s = 100, m = 100): NetVitals => ({ health: { cur: h, max: 100 }, stamina: { cur: s, max: 100 }, mana: { cur: m, max: 100 } });

interface Tab { net: UbNet; ran: string[]; reports: string[]; self: NetSelf }
function tab(hub: Hub, name: string, store = new Map<string, string>(), now = () => Date.now()): Tab {
  const t: Tab = { net: null as unknown as UbNet, ran: [], reports: [], self: { name, world: 'Coldeve', vitals: vitals(100), coords: '42.1N, 33.6E' } };
  t.net = new UbNet({
    channel: hub.channel(), self: () => t.self, run: (c) => t.ran.push(c), report: (l) => t.reports.push(l),
    store: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => { store.set(k, v); } },
    schedule: (fn, ms) => { setTimeout(fn, ms); }, now, id: name.toLowerCase(),
  });
  return t;
}
const settle = async (ms = 0) => { await vi.advanceTimersByTimeAsync(ms); };

describe('UtilityBelt networking between tabs', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); setActiveUbNet(null); });

  it('tabs find each other: hello, the others answer, /ub netclients lists them (by tag too)', async () => {
    const hub = new Hub();
    const a = tab(hub, 'Alpha'), b = tab(hub, 'Bravo'), c = tab(hub, 'Charlie');
    a.net.start(); b.net.start(); c.net.start();
    await settle();
    expect(a.net.clients().map((x) => x.name)).toEqual(['Bravo', 'Charlie']);
    expect(c.net.clients().map((x) => x.name)).toEqual(['Alpha', 'Bravo']);
    expect(ubNetCommand('/ub opt set Networking.Tags healers,"main team"', b.net)).toEqual(['Networking.Tags = [healers, main team]']);
    await settle();
    expect(ubNetCommand('/ub netclients healers', a.net)).toEqual(['Bravo (Coldeve) tags: healers, main team H 100/100 S 100/100 M 100/100 at 42.1N, 33.6E']);
    expect(ubNetCommand('/ub netclients nobody', a.net)).toEqual(['No net clients to show']);
    expect(ubNetCommand('/ub netclients', a.net)!.map((l) => l.split(' ')[0])).toEqual(['Bravo', 'Charlie']);
  });

  it('/ub bc runs here at once and on each other client, each `delay` after the last; they ack', async () => {
    const hub = new Hub();
    const a = tab(hub, 'Alpha'), b = tab(hub, 'Bravo'), c = tab(hub, 'Charlie');
    for (const t of [a, b, c]) t.net.start();
    await settle();
    const lines = ubNetCommand('/ub bc 5000 /say hello', a.net)!;
    expect(lines).toEqual([
      'Broadcasting command to all clients: "/say hello" with delay inbetween of 5000ms',
      'Sending Bravo: "/say hello" with delay inbetween of 5000ms',
      'Sending Charlie: "/say hello" with delay inbetween of 5000ms',
    ]);
    await settle(0);
    expect(a.ran).toEqual(['/say hello']);
    await settle(5000);
    expect(b.ran).toEqual(['/say hello']);
    expect(c.ran).toEqual([]);
    await settle(5000);
    expect(c.ran).toEqual(['/say hello']);
    expect(a.reports).toEqual(['Bravo ack\'d command broadcast request. (/say hello /// 5000ms)', 'Charlie ack\'d command broadcast request. (/say hello /// 10000ms)']);
    expect(ubNetCommand('/ub bc', a.net)).toEqual(['Usage: /ub bc [millisecondDelay] <command>']);
  });

  it('/ub bct goes to tagged clients only, and runs here only when this client has the tag', async () => {
    const hub = new Hub();
    const a = tab(hub, 'Alpha'), b = tab(hub, 'Bravo'), c = tab(hub, 'Charlie');
    for (const t of [a, b, c]) t.net.start();
    b.net.setTags(['one']);
    c.net.setTags(['two', 'some tag']);
    await settle();
    ubNetCommand('/ub bct one,"some tag" /vt start', a.net);
    await settle(10);
    expect(a.ran).toEqual([]);
    expect(b.ran).toEqual(['/vt start']);
    expect(c.ran).toEqual(['/vt start']);
    ubNetCommand('/ub bct two /vt stop', c.net);
    await settle(10);
    expect(c.ran).toEqual(['/vt start', '/vt stop']);
    expect(b.ran).toEqual(['/vt start']);
    // As UB's pattern: the first word is the tag list, so a tag list is always needed before the command.
    expect(ubNetCommand('/ub bct one', a.net)).toEqual(['Usage: /ub bct <teamslist> [millisecondDelay] <command>']);
    expect(parseTags('a,"b c",d')).toEqual(['a', 'b c', 'd']);
  });

  it('a broadcast arriving from another client is not broadcast again (it would bounce between tabs)', async () => {
    const hub = new Hub();
    const a = tab(hub, 'Alpha'), b = tab(hub, 'Bravo');
    a.net.start(); b.net.start();
    await settle();
    ubNetCommand('/ub bc /ub bc /say loop', a.net);
    await settle(10);
    expect(b.ran).toEqual([]);
    expect(b.reports[0]).toMatch(/^Not running a broadcast command from another client/);
  });

  it('tags are per character; VTank.VitalSharing is on by default and turns off', async () => {
    const hub = new Hub();
    const store = new Map<string, string>();
    const a = tab(hub, 'Alpha', store);
    a.net.start();
    a.net.setTags(['x']);
    a.self = { ...a.self, name: 'Other' };
    expect(a.net.tags).toEqual([]);
    a.self = { ...a.self, name: 'Alpha' };
    expect(ubNetCommand('/ub opt get Networking.Tags', a.net)).toEqual(['Networking.Tags = [x]']);
    expect(ubNetCommand('/ub opt get VTank.VitalSharing', a.net)).toEqual(['VTank.VitalSharing = true']);
    expect(ubNetCommand('/ub opt toggle vtank.vitalsharing', a.net)).toEqual(['VTank.VitalSharing = false']);
    expect(store.get('acjs.ub.vtank.vitalSharing')).toBe('false');
    expect(ubNetCommand('/ub opt set VTank.VitalSharing maybe', a.net)).toEqual(['Usage: /ub opt set VTank.VitalSharing true|false']);
    // Other /ub opt keys and commands are someone else's.
    expect(ubNetCommand('/ub opt get Plugin.Debug', a.net)).toBeNull();
    expect(ubNetCommand('/ub use Gateway', a.net)).toBeNull();
    expect(ubNetCommand('/vt start', a.net)).toBeNull();
  });

  it('vital sharing: changed vitals go out on the beat; off, none are sent', async () => {
    const hub = new Hub();
    let t = 0;
    const a = tab(hub, 'Alpha', new Map(), () => t), b = tab(hub, 'Bravo', new Map(), () => t);
    a.net.start(); b.net.start();
    await settle();
    a.self.vitals = vitals(40, 90, 10);
    t += 300; a.net.tick();
    await settle();
    expect(b.net.sharedVitals()).toEqual([{ name: 'Alpha', vitals: vitals(40, 90, 10) }]);
    a.net.setVitalSharing(false);
    a.self.vitals = vitals(20);
    t += 3000; a.net.tick();
    await settle();
    expect(b.net.clients()[0].vitals).toBeUndefined();
  });

  it('cast sharing: a debuff one client landed reaches the others once', async () => {
    const hub = new Hub();
    const a = tab(hub, 'Alpha'), b = tab(hub, 'Bravo');
    a.net.start(); b.net.start();
    await settle();
    a.net.shareCast(0x80005001, 1234, 60_000);
    await settle();
    const got = b.net.takeCasts();
    expect(got).toHaveLength(1);
    expect(got[0]).toMatchObject({ from: 'alpha', target: 0x80005001, spellId: 1234, durationMs: 60_000 });
    expect(b.net.takeCasts()).toEqual([]);
    expect(a.net.takeCasts()).toEqual([]);
  });

  it('a closed tab says goodbye; one that went silent is dropped after 10 s', async () => {
    const hub = new Hub();
    let t = 0;
    const a = tab(hub, 'Alpha', new Map(), () => t), b = tab(hub, 'Bravo', new Map(), () => t), c = tab(hub, 'Charlie', new Map(), () => t);
    for (const x of [a, b, c]) x.net.start();
    await settle();
    b.net.close();
    await settle();
    expect(a.net.clients().map((x) => x.name)).toEqual(['Charlie']);
    t += 11_000;
    a.net.tick();
    expect(a.net.clients()).toEqual([]);
  });

  it('the browser channel is a BroadcastChannel (null where there is none); one active client per tab', () => {
    const ch = browserNetChannel('acjs-test');
    if (typeof BroadcastChannel === 'undefined') expect(ch).toBeNull();
    else { expect(ch).not.toBeNull(); ch!.close(); }
    const hub = new Hub();
    const a = tab(hub, 'Alpha');
    setActiveUbNet(a.net);
    expect(activeUbNet()).toBe(a.net);
  });
});

// ── the VirindiTank window: /ub networking lines, and the .usd / .af files ──

describe('the VirindiTank window: /ub networking and the .usd / .af exports', () => {
  const fx = (n: string): string => readFileSync(resolve(__dirname, 'fixtures/vtank', n), 'latin1');
  const profile = (): RoutineProfile => ({
    name: 'Hunter', modules: { ...ALL_MODULES_OFF, combat: true }, initialState: 'Default', states: [{ name: 'Default', rules: [{ label: 'Rule 1', when: [{ kind: 'died' }], do: [{ kind: 'set-state', state: 'Default' }] }] }],
    loot: [], buffSets: [], routes: [{ name: 'loop', mode: 'circular', points: ['42.1N, 33.6E', '42.2N, 33.7E'] }], navRoute: 'loop',
    settings: { AttackDistance: 20 }, vtank: { ...emptyVtankData(), consumables: ['Handy Healing Kit'], items: [{ name: 'Wand' }] },
  });
  async function open(net: UbNet | null) {
    const { VTankWindow } = await import('../packages/renderer/src/ui/automation/VTankWindow.js');
    const downloads: Array<{ name: string; text: string }> = [];
    let doc: RoutineDoc = { ...emptyRoutineDoc('s', 'a'), profiles: [profile()] };
    const kit = { download: (name: string, text: string) => { downloads.push({ name, text }); }, net: () => net, names: () => ({ objectId: (n: string) => (n === 'Wand' ? 0x80000777 | 0 : undefined) }) };
    const source = {
      load: async () => ({ ok: true, doc: structuredClone(doc) }),
      save: async (d: RoutineDoc) => { doc = structuredClone(d); return { ok: true, doc: structuredClone(d) }; },
      status: () => ({ running: false, paused: false, profile: null, state: null, acting: null, last: [] }),
      character: () => 'Alpha', coords: () => null, now: () => 1_700_000_000_000, history: () => [], report: () => {}, setting: () => undefined, setSetting: () => {}, update: () => ({ ok: true, message: '' }),
    };
    const win = new VTankWindow(kit as never, source as never, { open: () => {}, close: () => {} });
    await win.load(() => {});
    return { win, downloads, doc: () => doc };
  }

  it('/ub bc and netclients go to this tab\'s network client', async () => {
    vi.useFakeTimers();
    try {
      const hub = new Hub();
      const a = tab(hub, 'Alpha'), b = tab(hub, 'Bravo');
      a.net.start(); b.net.start();
      await settle();
      const t = await open(a.net);
      expect(await t.win.command('/ub netclients')).toEqual(['Bravo (Coldeve) H 100/100 S 100/100 M 100/100 at 42.1N, 33.6E']);
      expect((await t.win.command('/ub bc /say hi'))[0]).toBe('Broadcasting command to all clients: "/say hi" with delay inbetween of 0ms');
      await settle(10);
      expect(b.ran).toEqual(['/say hi']);
    } finally { vi.useRealTimers(); }
  });

  it('/vt settings save <name>.usd hands over the settings file; /vt meta | nav save <name>.af the metaf text', async () => {
    const t = await open(null);
    const s = await t.win.command('/vt settings save Hunter2.usd');
    expect(s[0]).toBe('settings saved as "Hunter2"');
    expect(s[1]).toMatch(/^Hunter2\.usd saved to your downloads/);
    const usd = t.downloads.find((d) => d.name === 'Hunter2.usd')!.text;
    const tables = parseUsd(usd);
    // The Items tab's wand by the id of the carried item; the kit is a .usd's Consumables kind 0.
    expect(tables.find((x) => x.name === 'BuffedItems')!.rows).toEqual([[{ t: 'i', v: 0x80000777 | 0 }, { t: 'i', v: -1 }]]);
    expect(tables.find((x) => x.name === 'AssistItems')!.rows).toEqual([[{ t: 's', v: 'Handy Healing Kit' }, { t: 'i', v: 0 }]]);
    const back = importVTankFiles([{ name: 'Hunter2.usd', text: usd }], null, 'x').value;
    expect(back.settings?.AttackDistance).toBe(20);
    expect(t.doc().profiles.map((p) => p.name)).toEqual(['Hunter', 'Hunter2']);
    expect(await t.win.command('/vt settings save Plain')).toEqual(['settings saved as "Plain"']);
    const m = await t.win.command('/vt meta save Hunt.af');
    expect(m[0]).toBe('meta saved as "Hunt"');
    expect(parseAf(t.downloads.find((d) => d.name === 'Hunt.af')!.text).kind).toBe('meta');
    const n = await t.win.command('/vt nav save loop2.af');
    expect(n[0]).toBe('nav saved as "loop2"');
    expect(parseAf(t.downloads.find((d) => d.name === 'loop2.af')!.text)).toMatchObject({ kind: 'nav', nav: { mode: 'circular' } });
    expect(t.downloads.map((d) => d.name)).toEqual(['Hunter2.usd', 'Hunt.af', 'loop2.af']);
    // And a real fixture imports through the same path the window's Import uses.
    expect(importVTankFiles([{ name: 'hunt.af', text: fx('hunt.af') }], null, 'hunt').value.states).toHaveLength(3);
  });
});

// ── the macro over the real spell table: what the other clients share (needs DAT files) ──

const PORTAL = resolve(__dirname, '../dat/client_portal.dat');
type Table = { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number }> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };
describe.skipIf(!existsSync(PORTAL))('the macro with UtilityBelt sharing (needs DAT files)', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(PORTAL).getFileData(0x0e00000e)!)) as unknown as Table;
  });
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    const known = ['Heal Self I', 'Heal Other I', 'Imperil Other I', 'Flame Bolt I'].map(id);
    host.spells = () => known.map((k) => { const s = table.spells.get(k)!; return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}) }; });
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [
      { id: 33, name: 'Life Magic', training: 'trained', base: 100, buffed: 100 },
      { id: 34, name: 'War Magic', training: 'trained', base: 100, buffed: 100 },
    ];
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); setActiveUbNet(null); });
  const step = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  const vt = (over: Partial<RoutineProfile> = {}): RoutineProfile => ({
    name: 'VT', modules: { ...ALL_MODULES_OFF, buffs: true, vitals: true, combat: true, looting: true, navigation: true, inventory: true },
    initialState: 'Default', states: [{ name: 'Default', rules: [] }], loot: [], buffSets: [], routes: [], macro: true, ruleFiring: 'once',
    settings: { EnableBuffing: false, AttackDistance: 30, AutoCraftItems: false }, vtank: emptyVtankData(), ...over,
  });
  const answer = () => {
    const send = host.cast;
    host.cast = (sid, t) => {
      const r = send(sid, t);
      const s = table.spells.get(sid);
      if (s) api.pushChat(t === null ? `You cast ${s.name} on yourself` : `You cast ${s.name} on ${host.objs.get(t)?.name ?? '?'}`, 7);
      return r;
    };
  };

  it('cast sharing: a debuff another tab landed is not cast again here; this tab\'s own debuff goes out to the others', async () => {
    const hub = new Hub();
    const other = tab(hub, 'Bravo'), mine = tab(hub, 'Claude Test');
    other.net.start(); mine.net.start();
    setActiveUbNet(mine.net);
    await vi.advanceTimersByTimeAsync(0);
    host.add({ guid: 0x80005001, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
    const data = emptyVtankData();
    data.monsters[0].on = ['I', 'A'];
    answer();
    other.net.shareCast(0x80005001, id('Imperil Other I'), 300_000);
    await vi.advanceTimersByTimeAsync(0);
    api.routine.start(vt({ vtank: data }));
    await step(2500);
    const casts = host.sent.filter((x) => x.startsWith('cast '));
    expect(casts).not.toContain(`cast ${id('Imperil Other I')} 80005001`);
    expect(casts).toContain(`cast ${id('Flame Bolt I')} 80005001`);
    expect(other.net.takeCasts()).toEqual([]);
    // A monster nobody has debuffed: this tab imperils it and tells the others.
    api.routine.stop();
    host.objs.delete(0x80005001);
    host.add({ guid: 0x80005002, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 35 });
    host.sent.length = 0;
    api.routine.start(vt({ vtank: data }));
    await step(2500);
    expect(host.sent.filter((x) => x.startsWith('cast '))[0]).toBe(`cast ${id('Imperil Other I')} 80005002`);
    const got = other.net.takeCasts();
    expect(got.map((c) => [c.target, c.spellId, c.durationMs])).toEqual([[0x80005002, id('Imperil Other I'), (table.spells.get(id('Imperil Other I'))!.duration ?? 0) * 1000]]);
  });

  it('vital sharing: the Helper heals another of your characters near you, though not in your fellowship', async () => {
    const hub = new Hub();
    const other = tab(hub, 'Bravo'), mine = tab(hub, 'Claude Test');
    other.self.vitals = { health: { cur: 10, max: 100 }, stamina: { cur: 100, max: 100 }, mana: { cur: 100, max: 100 } };
    other.net.start(); mine.net.start();
    setActiveUbNet(mine.net);
    await vi.advanceTimersByTimeAsync(0);
    host.add({ guid: 0x50000bbb, name: 'Bravo', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 30 });
    host.me.combatMode = 'magic';
    answer();
    api.routine.start(vt());
    await step(1500);
    expect(host.sent).toContain(`cast ${id('Heal Other I')} 50000bbb`);
    // Vital sharing off on this tab: nobody to help.
    api.routine.stop();
    host.sent.length = 0;
    mine.net.setVitalSharing(false);
    api.routine.start(vt());
    await step(1500);
    expect(host.sent.filter((x) => x.endsWith('50000bbb'))).toEqual([]);
  });

  it('a .usd\'s GemFoodItems are the gems the macro uses as buffs (in place of VTank\'s default two)', async () => {
    const gem = (guid: number, name: string, spellId: number) => {
      host.inv = [...host.inv, { guid, name, where: 'main pack' } as never];
      host.appraisalDatas.set(guid, { int: { [PropertyInt.ItemUseable]: 8 }, float: {}, string: {}, bool: {}, did: { [PropertyDataId.Spell]: spellId }, spells: [] });
      host.appraised.push(guid);
    };
    gem(0x70000001, "Asheron's Benediction", 3810);
    const data = emptyVtankData();
    data.gemFood = [{ name: 'Tourmaline', spell: 169 }];
    api.routine.start(vt({ vtank: data, settings: { EnableBuffing: true, AttackDistance: 30, AutoCraftItems: false } }));
    await step(3000);
    expect(host.sent).not.toContain('use 70000001');
    api.routine.stop();
    // Unset (no .usd): VTank's default profile's, which hold Asheron's Benediction.
    api.routine.start(vt({ settings: { EnableBuffing: true, AttackDistance: 30, AutoCraftItems: false } }));
    await step(3000);
    expect(host.sent).toContain('use 70000001');
  });

  it('a .usd kept by id (Claude\'s import): the macro names its Items-tab wand from what you carry', async () => {
    const usd = readFileSync(resolve(__dirname, 'fixtures/vtank/hunter.usd'), 'latin1');
    const p = importVTankFiles([{ name: 'hunter.usd', text: usd }], vt({ vtank: emptyVtankData() }), 'VT').value;
    expect(p.vtank!.items).toEqual([]);
    // Two casters carried: with nothing listed the macro would wield the first one it finds.
    host.inv = [{ guid: 0x80000001, name: 'Plain Wand', where: 'pack', itemType: 0x8000 } as never, { guid: 0x8000abcd, name: 'Wand of the Hunter', where: 'pack', itemType: 0x8000 } as never];
    host.me.combatMode = 'peace';
    host.me.health.current = 10;
    api.routine.start({ ...p, settings: { ...p.settings, EnableBuffing: false, AutoCraftItems: false } });
    await step(1500);
    // Hurt, it goes to magic mode to heal: the wand it wields is the Items tab's, named from its object id.
    expect(host.sent).toEqual(['wield 8000abcd']);
  });
});
