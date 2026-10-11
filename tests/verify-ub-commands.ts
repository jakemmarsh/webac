/**
 * UtilityBelt parity (docs/vtank-parity-gaps.md §11, §7): the /ub dispatcher and its commands
 * (agent/ub/ubCommands.ts) over a fake game, UB's settings store, AutoVendor / equipment / AutoXp /
 * tinkering plans, aliases and game events, the quest tracker, and the importer taking every /ub
 * command the client runs as a step.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ExprValue, LootRule, VarScope } from '../packages/shared/src/routines/index.ts';
import { importVTank, metToProfile, UB_COMMAND_VERBS, UB_SUFFIX_VERBS, ubVerbOf } from '../packages/shared/src/routines/index.ts';
import { UbRuntime, editDistance, PLAYER_OPTIONS, type UbHost, type UbSelf } from '../packages/renderer/src/agent/ub/ubCommands.ts';
import { UbStore, UB_SETTING_DEFAULTS, ubStorageKey, type UbStorage } from '../packages/renderer/src/agent/ub/ubSettings.ts';
import { buyList, safeToSell, sellList, testModeLines, vendorRound } from '../packages/renderer/src/agent/ub/autoVendor.ts';
import { equipPlan, profileFromWorn, toTakeOff } from '../packages/renderer/src/agent/ub/equipProfiles.ts';
import { exportXpPolicy, flattenXpPlan, importXpPolicy, planXp, xpTargetLabel } from '../packages/renderer/src/agent/ub/autoXp.ts';
import { applyAliases, deathDrops, fireGameEvent } from '../packages/renderer/src/agent/ub/aliases.ts';
import { friendlyTime, parseMyQuestsLine as parseMyQuestLine, QuestTracker, questReady } from '../packages/renderer/src/agent/questTracker.ts';
import { bestGraniteIron, materialMod, planTinkers, skillChance, tinkerChance, tinkerRule, type TinkerRow } from '../packages/renderer/src/agent/ub/tinker.ts';
import { bagMaterial, compactRows, parseTinkerSql } from '../tools/build-tinker-tables.ts';
import type { AgentDialog, AgentItem, AgentObject, AgentObjectKind, AgentResult, AgentVendor } from '../packages/renderer/src/agent/types.ts';
import type { ItemProps } from '../packages/renderer/src/agent/RoutineEngine.ts';
import eolTinker from '../packages/renderer/src/agent/ub/tinker/eol.ts';
import ac1999Tinker from '../packages/renderer/src/agent/ub/tinker/ac1999.ts';
import dmTinker from '../packages/renderer/src/agent/ub/tinker/dm.ts';
import { ammoFamily, parseWeenieSql, specialAmmo } from '../tools/build-ammo-tables.ts';
import eolAmmo from '../packages/renderer/src/agent/macro/specialAmmo/eol.ts';
import dmAmmo from '../packages/renderer/src/agent/macro/specialAmmo/dm.ts';
import ac1999Ammo from '../packages/renderer/src/agent/macro/specialAmmo/ac1999.ts';

const OK = (message = 'ok'): AgentResult => ({ ok: true, message });

class MemStorage implements UbStorage {
  m = new Map<string, string>();
  getItem(k: string) { return this.m.get(k) ?? null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
}

const obj = (guid: number, name: string, kind: AgentObjectKind, dist: number): AgentObject => ({ guid, name, kind, dist, bearing: 0, relBearing: 0, dz: 0 });

/** A fake game: records what /ub asked for. */
class FakeUb implements UbHost {
  t = 1000;
  sec = 1_700_000_000;
  log: string[] = [];
  printed: string[] = [];
  chats: string[] = [];
  self: UbSelf = { guid: 0x50000001, name: 'Tester', heading: 0, coords: '42.1N, 33.6E', cell: '0xA9B40019', pos: { x: 0, y: 0, z: 0 }, vitae: 95, pyreals: 1000, unassignedXp: 0, combatMode: 'peace' };
  sel: number | null = null;
  inv: AgentItem[] = [];
  world: AgentObject[] = [];
  data = new Map<number, ItemProps>();
  container: ReturnType<UbHost['openContainer']> = null;
  vend: AgentVendor | null = null;
  scr = 'world';
  dlg: AgentDialog[] = [];
  vars_: Record<string, string> = {};
  lacks: Record<string, string> = {};
  tinker: TinkerRow[] = [];
  sets: Record<string, LootRule[]> = {};
  opts = new Map<number, boolean>();
  next: string | null | undefined = undefined;
  ints = new Map<number, number>();
  skillRows: ReturnType<UbHost['skills']> = [];
  costs: Record<string, number[]> = {};
  events: Array<{ seq: number; type: string; text: string }> = [];
  seq = 0;
  navHeld: number[] = [];
  now() { return this.t; }
  nowSec() { return this.sec; }
  async sleep(ms: number) { this.t += ms; }
  print(text: string) { this.printed.push(text); }
  chat(line: string) { this.chats.push(line); }
  me() { return this.self; }
  screen() { return this.scr; }
  selected() { return this.sel; }
  inventory() { return this.inv; }
  nearby(r: number) { return this.world.filter((o) => o.dist <= r).sort((a, b) => a.dist - b.dist); }
  position(g: number) { return g === 7 ? { cell: '0xA9B40019', x: 1, y: 2, z: 3, coords: '42.1N, 33.6E' } : null; }
  openContainer() { return this.container; }
  itemData(g: number) { return this.data.get(g) ?? null; }
  async appraise(g: number) { this.log.push(`appraise ${g}`); return OK(); }
  async use(g: number) { this.log.push(`use ${g}`); return OK(); }
  useNow(g: number) { this.log.push(`usenow ${g}`); return true; }
  useOn(a: number, b: number) { this.log.push(`useon ${a} ${b}`); return OK(); }
  select(g: number) { this.sel = g; this.log.push(`select ${g}`); return OK(); }
  async give(i: number, t: number, n: number | null) { this.log.push(`give ${i} ${t} ${n}`); this.inv = this.inv.filter((x) => x.guid !== i); return OK(); }
  turn(h: number) { this.log.push(`turn ${h}`); return OK(); }
  jump(o: Parameters<UbHost['jump']>[0]) { this.log.push(`jump ${JSON.stringify(o)}`); return OK(); }
  combatMode(m: string) { this.log.push(`mode ${m}`); return OK(); }
  async equip(g: number) { this.log.push(`equip ${g}`); const i = this.inv.find((x) => x.guid === g); if (i) i.where = 'equipped'; return OK(); }
  unequip(g: number) { this.log.push(`unequip ${g}`); const i = this.inv.find((x) => x.guid === g); if (i) i.where = 'pack'; return OK(); }
  splitStack(g: number, n: number) { this.log.push(`split ${g} ${n}`); return true; }
  logout() { this.log.push('logout'); return OK(); }
  exitGame() { this.log.push('exit'); }
  evaluate(expr: string): ExprValue { if (expr === 'bad[') throw new Error('parse error'); return expr === '1+1' ? 2 : `r(${expr})`; }
  vars(scope: VarScope): Array<[string, ExprValue]> { return scope === 'var' ? [['a', 1], ['b', 'x']] : []; }
  setVar(n: string, v: string) { this.vars_[n] = v; }
  async propertyDump() { return ['Property Dump']; }
  follow(name: string) { this.log.push(`follow ${name}`); return OK(); }
  holdNav(ms: number) { this.navHeld.push(ms); }
  vendor() { return this.vend; }
  buy(g: number, n: number) { this.log.push(`buy ${g} ${n}`); const v = this.vend!.items.find((x) => x.guid === g)!; this.self.pyreals -= v.price * n; this.inv.push({ guid: 9000 + this.inv.length, name: v.name, where: 'pack', stack: n }); return OK(); }
  async sell(g: number, n: number | null) { this.log.push(`sell ${g} ${n}`); const i = this.inv.find((x) => x.guid === g); this.inv = this.inv.filter((x) => x.guid !== g); if (i) this.self.pyreals += i.value ?? 0; return OK(); }
  freeSlots() { return 50; }
  lootSet(n: string) { const k = Object.keys(this.sets).find((x) => x.toLowerCase() === n.toLowerCase()); return k ? this.sets[k]! : null; }
  lootSetNames() { return Object.keys(this.sets); }
  dialogs() { return this.dlg; }
  answerDialog(b: string) { this.log.push(`dialog ${b}`); this.dlg = []; return true; }
  playerOption(c: number) { return this.opts.get(c); }
  setPlayerOption(c: number, on: boolean) { this.opts.set(c, on); return true; }
  characters() { return ['Zed', 'Alpha', 'Tester', 'Mule One']; }
  setNextLogin(n: string | null) { this.next = n; }
  async fellowship(a: string, arg?: string) { this.log.push(`fellow ${a}${arg ? ` ${arg}` : ''}`); return OK('Fellowship: x'); }
  async swear(g: number) { this.log.push(`swear ${g}`); return OK(); }
  breakAllegiance(n?: string) { this.log.push(`break ${n}`); return OK(); }
  skills() { return this.skillRows; }
  raiseCosts(stat: string, steps: number) { const c = this.costs[stat]; return c ? c.slice(0, steps) : null; }
  raise(stat: string) { this.log.push(`raise ${stat}`); return { ok: true, message: 'raised', cost: 1 }; }
  charInt(id: number) { return this.ints.get(id); }
  eraLacks(f: string) { return this.lacks[f] ?? null; }
  async tinkerTable() { return this.tinker; }
  currentSeq() { return this.seq; }
  eventsSince(s: number) { return this.events.filter((e) => e.seq > s); }
  push(type: string, text: string) { this.events.push({ seq: ++this.seq, type, text }); }
}

const setup = () => {
  const h = new FakeUb();
  const storage = new MemStorage();
  const store = new UbStore(() => ({ server: 'Test', character: h.self.name }), () => storage);
  const quests = new QuestTracker({ send: (c) => { h.chats.push(c); return true; }, now: () => h.t });
  return { h, store, storage, quests, ub: new UbRuntime(h, store, quests) };
};
/** Let a started job's promise chain finish (fake sleep advances the clock at once). */
const settle = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };

describe('the /ub dispatcher (UtilityBelt.cs Core_CommandLineText)', () => {
  it('runs a verb exactly, a suffix-flag verb by its prefix, and suggests near verbs for an unknown one', async () => {
    const { ub, h } = setup();
    expect(await ub.command('/vt start')).toBeNull();
    expect((await ub.command('/ub'))![0]).toMatch(/UtilityBelt/);
    h.world = [obj(7, 'Holtburg Portal', 'portal', 5), obj(8, 'Mug', 'item', 3)];
    await ub.command('/ub selectlp mug');
    expect(h.sel).toBe(8);
    expect(await ub.command('/ub vitea')).toEqual(['Command not found! Type "/ub help" for a list of commands.', 'Did you mean one of these? vitae']);
    expect(editDistance('ca', 'ac')).toBe(1);
    expect((await ub.command('/ub help jump'))![0]).toBe('Usage: /ub jump[swzxc] [heading] [holdtime]');
  });

  it('the verbs it answers are the ones the importer takes (ubVerbs.ts)', () => {
    const { ub } = setup();
    const runtime = new Set(ub.verbs);
    const window = ['autocram', 'autostack', 'clearbugged', 'count'];
    expect([...UB_COMMAND_VERBS].sort()).toEqual([...new Set([...runtime, ...window])].sort());
    for (const v of UB_SUFFIX_VERBS) expect(runtime.has(v)).toBe(true);
  });
});

describe('acting on objects', () => {
  it('use[li][p] finds inventory, then the open container, then the nearest on the landscape; "on" uses one on another', async () => {
    const { ub, h } = setup();
    h.inv = [{ guid: 1, name: 'Healing Kit', where: 'pack' }, { guid: 2, name: 'Gold Pea', where: 'pack' }, { guid: 3, name: 'Splitting Tool', where: 'pack' }];
    h.world = [obj(10, 'Plant', 'item', 9), obj(11, 'Plant', 'item', 4), obj(12, 'Tusker', 'monster', 2)];
    expect(await ub.command('/ub use Healing Kit')).toEqual(['using Healing Kit']);
    expect(h.log.at(-1)).toBe('use 1');
    await ub.command('/ub uselp plant');
    expect(h.log.at(-1)).toBe('use 11');
    expect(await ub.command('/ub usepi splitting on gold pea')).toEqual(['using Splitting Tool on Gold Pea']);
    expect(h.log.at(-1)).toBe('useon 3 2');
    expect(await ub.command('/ub useli x')).toEqual(['l and i cannot be used in the same command']);
    expect(await ub.command('/ub use Nothing')).toEqual(['Could not find object: Nothing']);
    // UB's special names: a decimal id, a hex id, "selected".
    h.sel = 12;
    await ub.command('/ub use selected');
    expect(h.log.at(-1)).toBe('use 12');
    await ub.command('/ub use 0xb');
    expect(h.log.at(-1)).toBe('use 11');
  });

  it('give gives what matches (exact, partial p, regex r) up to a count, in range; ig gives what a loot profile keeps', async () => {
    const { ub, h } = setup();
    h.world = [obj(0x50000002, 'Zero Cool', 'player', 5), obj(0x50000003, 'Far Away', 'player', 40)];
    h.inv = [{ guid: 1, name: 'Hero Token', where: 'pack', stack: 3 }, { guid: 2, name: 'Hero Token', where: 'pack' }, { guid: 3, name: 'Prismatic Taper', where: 'pack', stack: 50 }, { guid: 4, name: 'Sword', where: 'equipped' }];
    expect(await ub.command('/ub give Hero Token to Far Away')).toEqual(['Far Away is 40.00 meters away, IGRange is set to 15. bailing.']);
    expect(await ub.command('/ub give Sword to Zero Cool')).toEqual(['ItemGiver finished: Sword to Zero Cool. took 0s to give 0 item(s). 0']);
    const out = await ub.command('/ub give 1 Hero Token to Zero Cool');
    expect(h.log.filter((l) => l.startsWith('give'))).toEqual([`give 1 ${0x50000002} null`]);
    expect(out![0]).toMatch(/^ItemGiver finished: Hero Token to Zero Cool\. took \d+s to give 1 item\(s\)/);
    await ub.command('/ub givep prismatic to zero cool');
    expect(h.log.filter((l) => l.startsWith('give')).at(-1)).toBe(`give 3 ${0x50000002} null`);
    // ig: Keep rules give all; Keep # gives up to its count.
    h.inv = [{ guid: 5, name: 'Mana Scarab', where: 'pack' }, { guid: 6, name: 'Mana Scarab', where: 'pack' }, { guid: 7, name: 'Mana Scarab', where: 'pack' }, { guid: 8, name: 'Rare Gem', where: 'pack' }, { guid: 9, name: 'Junk', where: 'pack' }];
    h.sets.mule = [{ label: 'Scarabs', action: 'keep-up-to', count: 2, match: { name: 'Scarab' } }, { action: 'keep', match: { name: '^Rare' } }];
    await ub.command('/ub ig mule.utl to Zero Cool');
    expect(h.log.filter((l) => l.startsWith('give')).slice(-3)).toEqual([`give 5 ${0x50000002} null`, `give 6 ${0x50000002} null`, `give 8 ${0x50000002} null`]);
    expect(await ub.command('/ub ig nope to Zero Cool')).toEqual(['ItemGiver Profile does not exist: nope']);
    expect(h.navHeld.at(-1)).toBe(0); // navigation let go when done
  });

  it('follow follows a player through VTank navigation; portal uses one until portal space; face and pos', async () => {
    const { ub, h } = setup();
    h.world = [obj(20, 'Zero Cool', 'player', 30), obj(21, 'Gateway', 'portal', 12), obj(22, 'Town Crier', 'npc', 3)];
    expect(await ub.command('/ub followp zero')).toEqual(['Following Zero Cool[0x00000014]']);
    expect(h.log).toContain('follow Zero Cool');
    expect(await ub.command('/ub follow Nobody')).toEqual(['Could not find player Nobody']);
    h.scr = 'portal-space';
    expect(await ub.command('/ub portal Gateway')).toEqual(['portal used successfully']);
    expect(h.printed).toContain('Attempting to use portal: Gateway');
    // closestportal only counts portals (not the nearer NPC).
    await ub.command('/ub closestportal');
    expect(h.log.at(-1)).toBe('use 21');
    h.scr = 'world';
    expect(await ub.command('/ub face 180')).toEqual([]);
    expect(h.log.at(-1)).toBe('turn 180');
    expect(await ub.command('/ub face north')).toEqual(['Invalid jump heading: north']);
    h.sel = 7;
    expect(await ub.command('/ub pos')).toEqual(['Id: 7 ( 0x00000007 )', 'Coords: 42.1N, 33.6E', 'Phys lb: 0xA9B40019', 'Phys pos: x:1.00 y:2.00 z:3.00']);
  });

  it('a portal that never takes says so after its attempts', async () => {
    const { ub, h, store } = setup();
    store.setText('Plugin.PortalAttempts', '2');
    h.world = [obj(21, 'Gateway', 'portal', 12)];
    expect(await ub.command('/ub portal Gateway')).toEqual(['Unable to use portal Gateway', 'failed to use portal']);
    expect(h.log.filter((l) => l === 'use 21')).toHaveLength(2);
  });
});

describe('movement, combat state and scripting', () => {
  it('jump[swzxc] holds the keys UB names, within 0–1000 ms and 0–359°', async () => {
    const { ub, h } = setup();
    expect(await ub.command('/ub jumpsw 180 500')).toEqual([]);
    expect(h.log.slice(-2)).toEqual(['turn 180', 'jump {"holdMs":500,"forward":true,"backward":false,"strafeLeft":false,"strafeRight":false,"walk":true}']);
    await settle();
    await ub.command('/ub jumpzc');
    expect(h.log.at(-1)).toContain('"strafeLeft":true,"strafeRight":true');
    await settle();
    expect(await ub.command('/ub jump 2000')).toEqual(['holdtime should be a number between 0 and 1000']);
    expect(await ub.command('/ub jump 400 100')).toEqual(['direction should be a number between 0 and 359']);
  });

  it('combatstate and its four modes; delay runs a command later; mexec[m]; listvars', async () => {
    const { ub, h } = setup();
    await ub.command('/ub combatstate magic');
    await ub.command('/ub peace');
    expect(h.log.filter((l) => l.startsWith('mode'))).toEqual(['mode magic', 'mode peace']);
    expect(await ub.command('/ub combatstate flying')).toEqual(['Usage: /ub combatstate (peace|melee|missile|magic)']);
    await ub.command('/ub delay 3000 /say hello');
    ub.tick();
    expect(h.chats).toEqual([]);
    h.t += 3000;
    ub.tick();
    expect(h.chats).toEqual(['/say hello']);
    const r = await ub.command('/ub mexec 1+1');
    expect(r![0]).toBe('Evaluating expression: "1+1"');
    expect(r![1]).toMatch(/^Result: \[number\] 2 \(/);
    expect(await ub.command('/ub mexecm 1+1')).toEqual([]);
    expect(await ub.command('/ub mexec bad[')).toEqual(['Error: parse error']);
    expect(await ub.command('/ub listvars')).toEqual(['Defined variables:', 'a (number) = 1', 'b (string) = x']);
  });

  it('vitae thinks it; close corpse closes an open corpse; quit is the game\'s Exit Game; propertydump', async () => {
    const { ub, h } = setup();
    await ub.command('/ub vitae');
    expect(h.chats).toEqual(['/tell Tester, My vitae is 95%']);
    expect(await ub.command('/ub close corpse')).toEqual(['No container is currently open.']);
    h.container = { guid: 44, name: 'Corpse of Drudge', corpse: true, items: [] };
    await ub.command('/ub close chest');
    expect(h.log).not.toContain('usenow 44');
    await ub.command('/ub close corpse');
    expect(h.log).toContain('usenow 44');
    expect(await ub.command('/ub quit')).toEqual(['Quitting Client']);
    expect(h.log).toContain('exit');
    expect(await ub.command('/ub propertydump')).toEqual(['Property Dump']);
  });
});

describe('/ub opt and the settings store', () => {
  it('lists, gets, sets, toggles and edits lists by UB\'s names; kept per character in storage', async () => {
    const { ub, storage, h } = setup();
    expect((await ub.command('/ub opt list'))!.length).toBe(1 + Object.keys(UB_SETTING_DEFAULTS).length);
    expect(await ub.command('/ub opt get autovendor.testmode')).toEqual(['AutoVendor.TestMode = false']);
    expect(await ub.command('/ub opt toggle AutoVendor.TestMode')).toEqual(['AutoVendor.TestMode = true']);
    expect(await ub.command('/ub opt set InventoryManager.IGRange 30')).toEqual(['InventoryManager.IGRange = 30']);
    expect(await ub.command('/ub opt set AutoVendor.Think maybe')).toEqual(['AutoVendor.Think takes true or false']);
    expect(await ub.command('/ub opt set AutoVendor.NeverSell add Pyreal Mote,Rare Gem')).toEqual(['AutoVendor.NeverSell = [Pyreal Mote, Rare Gem]']);
    expect(await ub.command('/ub opt set AutoVendor.NeverSell remove Rare Gem')).toEqual(['AutoVendor.NeverSell = [Pyreal Mote]']);
    expect(await ub.command('/ub opt get Plugin.Nope')).toEqual(['Invalid option: Plugin.Nope']);
    const saved = JSON.parse(storage.getItem(ubStorageKey('Test', 'Tester'))!);
    expect(saved.settings['InventoryManager.IGRange']).toBe(30);
    // Another character starts from the defaults.
    h.self = { ...h.self, name: 'Other' };
    expect(await ub.command('/ub opt get InventoryManager.IGRange')).toEqual(['InventoryManager.IGRange = 15']);
  });
});

describe('AutoVendor (UB AutoVendor.cs)', () => {
  const rules: LootRule[] = [
    { label: 'Scarabs', action: 'keep-up-to', count: 10, match: { name: 'Mana Scarab' } },
    { label: 'Notes', action: 'keep', match: { name: 'Trade Note' } },
    { label: 'Peas', action: 'sell', match: { name: 'Pea$' } },
    { label: 'Junk', action: 'sell', match: { name: 'Junk' } },
  ];
  const vendor = (): AgentVendor => ({ name: 'Aun Shaman', guid: 500, currency: 'Pyreals', items: [{ guid: 501, name: 'Mana Scarab', price: 30 }, { guid: 502, name: 'Trade Note (250)', price: 290 }, { guid: 503, name: 'Taper', price: 2 }] });

  it('plans Keep # to the count, Keep to the purse, cheapest first and notes last; never sells what UB never sells', () => {
    const inv: AgentItem[] = [{ guid: 1, name: 'Mana Scarab', where: 'pack', stack: 4 }];
    const buys = buyList(rules, vendor().items, inv);
    expect(buys.map((b) => [b.item.name, b.amount])).toEqual([['Mana Scarab', 6], ['Trade Note (250)', Infinity]]);
    expect(vendorRound({ buys, sells: [], pyreals: 1000, freeSlots: 10 })).toEqual({ buy: [{ item: vendor().items[0], amount: 6 }, { item: vendor().items[1], amount: 2 }] });
    // Can't afford all the scarabs: buy what it can, then stop (the sell round raises the money).
    expect(vendorRound({ buys, sells: [], pyreals: 100, freeSlots: 10 })).toEqual({ buy: [{ item: vendor().items[0], amount: 3 }] });
    const items: AgentItem[] = [
      { guid: 10, name: 'Gold Pea', where: 'pack', value: 100 },
      { guid: 11, name: 'Silver Pea', where: 'side pack', value: 50 },
      { guid: 12, name: 'Iron Pea', where: 'equipped', value: 50 },
      { guid: 13, name: 'Copper Pea', where: 'pack', value: 0 },
      { guid: 14, name: 'Junk', where: 'pack', value: 10, objectDescFlags: 0x01000000 },
      { guid: 15, name: 'Junk', where: 'pack', value: 10 },
      { guid: 16, name: 'Junk', where: 'pack', value: 10 },
    ];
    const props = (g: number) => (g === 15 ? { int: { 171: 3 } } : g === 16 ? { string: { 7: 'Mine' } } : null);
    expect(sellList(rules, items, props, { neverSell: ['Gold Pea'], onlyMainPack: false }).map((s) => s.item.guid)).toEqual([11]);
    expect(sellList(rules, items, props, { neverSell: [], onlyMainPack: true }).map((s) => s.item.guid)).toEqual([10]);
    expect(safeToSell({ guid: 1, name: 'Backpack', where: 'pack', value: 50, itemType: 0x200 }, null, { neverSell: [], onlyMainPack: false })).toBe(false);
  });

  it('runs buy and sell rounds at the open vendor until neither has anything, holding navigation', async () => {
    const { ub, h } = setup();
    h.vend = vendor();
    h.sets['Aun Shaman'] = rules;
    h.inv = [{ guid: 1, name: 'Mana Scarab', where: 'pack', stack: 4 }, { guid: 10, name: 'Gold Pea', where: 'pack', value: 100 }];
    h.self.pyreals = 200;
    const lines = await ub.runVendor({ cancelled: false }, 500, rules);
    expect(h.log.filter((l) => /^(buy|sell)/.test(l))[0]).toBe('buy 501 6');
    expect(h.log).toContain('sell 10 null');
    expect(lines).toEqual(['AutoVendor finished: Aun Shaman']);
    expect(h.navHeld).toContain(30_000);
    expect(h.navHeld.at(-1)).toBe(0);
  });

  it('starts by itself when a vendor with a profile opens (UB ApproachVendor); TestMode only says what it would do', async () => {
    const { ub, h, store } = setup();
    store.setValue('AutoVendor.TestMode', true);
    h.sets['Aun Shaman'] = rules;
    ub.tick();
    h.vend = vendor();
    h.inv = [{ guid: 10, name: 'Gold Pea', where: 'pack', value: 100 }];
    ub.tick();
    await settle();
    expect(h.printed.slice(0, 3)).toEqual(['AutoVendor TEST MODE', 'Buy Items:', '  Mana Scarab * 10 - Scarabs']);
    expect(h.printed).toContain('  Gold Pea - Peas');
    expect(h.log.some((l) => /^(buy|sell)/.test(l))).toBe(false);
    expect(testModeLines([], [])).toEqual(['AutoVendor TEST MODE', 'Buy Items:', '  (Nothing)', 'Sell Items:', '  (Nothing)']);
  });

  it('/ub vendor addbuy / buyall and addsell (whole stacks, then a split of the smallest bigger one) / sellall', async () => {
    const { ub, h } = setup();
    expect(await ub.command('/ub vendor addbuy Mana Scarab')).toEqual(['addbuy: No vendor open']);
    h.vend = vendor();
    expect(await ub.command('/ub vendor addbuy 10 Mana Scarab')).toEqual(['Added item to buy list: Mana Scarab * 10']);
    expect(await ub.command('/ub vendor addbuyp 2 tap')).toEqual(['Added item to buy list: Taper * 2']);
    await ub.command('/ub vendor buyall');
    expect(h.log.filter((l) => l.startsWith('buy'))).toEqual(['buy 501 10', 'buy 503 2']);
    h.inv = [{ guid: 30, name: 'Gold Pea', where: 'pack', value: 10, stack: 3 }, { guid: 31, name: 'Gold Pea', where: 'pack', value: 10, stack: 10 }];
    expect(await ub.command('/ub vendor addsell 5 Gold Pea')).toEqual(['Added item to sell list: Gold Pea * 5']);
    await ub.command('/ub vendor sellall');
    expect(h.log.filter((l) => l.startsWith('sell'))).toEqual(['sell 30 null', 'sell 31 2']);
  });

  it('/ub vendor open uses the vendor until its window opens', async () => {
    const { ub, h } = setup();
    h.world = [obj(500, 'Aun Shaman', 'vendor', 4)];
    const use = h.use.bind(h);
    h.use = async (g) => { const r = await use(g); h.vend = vendor(); return r; };
    expect(await ub.command('/ub vendor openp aun')).toEqual([]);
    await settle();
    expect(h.log).toEqual(['use 500']);
  });
});

describe('equipment profiles (UB EquipmentManager)', () => {
  it('create keeps what you wear; test lists by lore; load takes off the rest, then wears it', async () => {
    const { ub, h, store } = setup();
    h.inv = [
      { guid: 1, name: 'Robe of Set A', where: 'equipped', type: 'Clothing', value: 500 },
      { guid: 2, name: 'Mask', where: 'equipped', type: 'Armor', value: 300 },
      { guid: 3, name: 'Breastplate', where: 'pack', fits: 'ChestArmor', type: 'Armor', value: 900 },
      { guid: 4, name: 'Gauntlets', where: 'pack', fits: 'HandArmor', type: 'Armor', value: 200 },
    ];
    expect(await ub.command('/ub equip create Robes')).toEqual(['Profile created: Robes.utl (2 items)']);
    expect(store.data.equip.Robes).toEqual(profileFromWorn(h.inv));
    h.sets.Armor = [{ action: 'keep', match: { name: '^(Breastplate|Gauntlets|Mask)$' } }];
    h.data.set(3, { int: { 109: 200 } });
    h.data.set(4, { int: { 109: 50 } });
    expect(await ub.command('/ub equip test Armor')).toEqual(['Will attempt to equip the following items in order:', ' * Mask <2>', ' * Gauntlets <4>', ' * Breastplate <3>']);
    const out = await ub.command('/ub equip load Armor.utl');
    expect(h.log.filter((l) => /^(equip|unequip)/.test(l))).toEqual(['unequip 1', 'equip 4', 'equip 3']);
    expect(out![0]).toMatch(/^Equipment Manager: Finished equipping items in/);
    expect((await ub.command('/ub equip list'))).toEqual(['Equip Profiles:', ' * Robes.utl (this character)', ' * Armor.utl (loot profiles)']);
    expect(await ub.command('/ub equip load Nope')).toEqual(['No equip profile exists: Nope.utl']);
    expect(toTakeOff(h.inv, equipPlan(h.sets.Armor!, h.inv, () => null)).map((i) => i.guid)).toEqual([]);
  });

  it('calcdamage: a missile weapon with its Blood Thirst and the mahogany it can still take', async () => {
    const { ub, h } = setup();
    h.inv = [{ guid: 5, name: 'Yumi', where: 'pack', itemType: 0x100 }, { guid: 6, name: 'Sword', where: 'pack', itemType: 0x1, type: 'MeleeWeapon' }];
    h.sel = 5;
    expect(await ub.command('/ub calcdamage')).toEqual(['Yumi does not have id data, please examine it first.']);
    h.data.set(5, { int: { 44: 20, 204: 10, 171: 3 }, float: { 63: 2.1 }, spells: ['Major Blood Thirst'] });
    const r = (await ub.command('/ub calcdamage'))!;
    // (20 + 4 + 10) × (2.1 + 6 × 0.04 − 1) = 34 × 1.34
    expect(r[0]).toBe('6 mahogany salvage adds 0.24 to DamageModifier');
    expect(r.at(-1)).toBe(`Calculated (after tinks): ${Math.round(34 * 1.34 * 100) / 100}`);
    h.sel = 6;
    h.data.set(6, { int: {} });
    expect(await ub.command('/ub calcdamage')).toEqual(['Calc Damage: MeleeWeapon is not currently supported']);
  });
});

describe('AutoXp (UB AutoXp.cs)', () => {
  it('plans the cheapest weighted step each time, stops StopBeforeMax short, and spends through Raise', async () => {
    const costs: Record<string, number[]> = { 'War Magic': [100, 200, 400, 800, 1600], Strength: [50, 60, 70, 80, 90] };
    const plan = planXp({ xp: 1000, policy: { WarMagic: 10, Strength: 1, Alchemy: 0 }, costs: (t, n) => costs[t]?.slice(0, n) ?? null, stopBeforeMax: 1 });
    // War Magic 100/10=10, 200/10=20, 400/10=40 beat Strength 50; War Magic's last step is never bought (StopBeforeMax ≥ 1).
    expect([...plan]).toEqual([['WarMagic', [100, 200, 400]], ['Strength', [50, 60, 70]]]);
    expect(flattenXpPlan(plan).map((s) => s.cost)).toEqual([50, 60, 70, 100, 200, 400]);
    expect(xpTargetLabel('TwoHandedCombat')).toBe('Two Handed Combat');
    expect(exportXpPolicy({ A: 1, B: 0.5 })).toBe('A=1;B=0.5');
    const imp = importXpPolicy({ Strength: 1 }, 'Strength=3;Nope=1;Self=x;Junk');
    expect(imp.policy).toEqual({ Strength: 3 });
    expect(imp.errors).toEqual(['Unable to parse XpTarget Nope', 'Unable to parse x for Self']);

    const { ub, h, store } = setup();
    store.data.xpPolicy = { WarMagic: 10, Strength: 1 };
    store.setText('AutoXp.StopBeforeMax', '1');
    h.costs = costs;
    h.self.unassignedXp = 1000;
    expect(await ub.command('/ub xp test')).toEqual(['Experience plan for 1000 exp:', 'WarMagic: 3 levels for 700 xp', 'Strength: 3 levels for 180 xp']);
    expect(await ub.command('/ub xp')).toEqual(['Current experience policy weights:', 'WarMagic: 10', 'Strength: 1']);
    expect(await ub.command('/ub xp level')).toEqual(['Spending on a plan consisting of 6 steps with 1000 available exp.']);
    await settle();
    expect(h.log.filter((l) => l.startsWith('raise'))).toEqual(['raise Strength', 'raise Strength', 'raise Strength', 'raise War Magic', 'raise War Magic', 'raise War Magic']);
    expect(h.printed).toContain('Finished leveling 6 targets.');
    await ub.command('/ub xp import WarMagic=2');
    expect(await ub.command('/ub xp export')).toEqual(['WarMagic=2;Strength=1']);
  });
});

describe('aliases and game events (UB Aliases.cs, GameEvents.cs)', () => {
  it('a matching alias runs its action with capture groups set; an eating alias keeps the line', async () => {
    const vars: Record<string, string> = {};
    const chat: string[] = [];
    const run = { chat: (l: string) => chat.push(l), evaluate: (e: string) => `<${e}>`, setVar: (n: string, v: string) => { vars[n] = v; } };
    expect(applyAliases('/tloc Bob', [{ alias: '^/tloc (?<name>.*)$', action: { type: 'ChatExpression', text: 'x' }, eat: true }], run)).toBe(true);
    expect(vars.capturegroup_name).toBe('Bob');
    expect(chat).toEqual(['<x>']);
    expect(applyAliases('hello', [{ alias: '^/ubpd$', action: { type: 'ChatCommand', text: '/ub propertydump' }, eat: true }], run)).toBe(false);

    const { ub, h } = setup();
    expect(await ub.command('/ub alias add ChatCommand ^/ubpd$ => /ub propertydump')).toEqual(['Added alias 1: ^/ubpd$ -> ChatCommand: /ub propertydump']);
    expect(await ub.command('/ub alias add noeat Expression ^hi$ => setvar[x,1]')).toEqual(['Added alias 2: ^hi$ -> Expression: setvar[x,1]']);
    expect(await ub.command('/ub alias add ChatCommand ([ => x')).toEqual([expect.stringMatching(/^Invalid Alias Regex\./)]);
    expect(ub.onChatSend('/ubpd')).toBe(true);
    expect(h.chats).toEqual(['/ub propertydump']);
    expect(ub.onChatSend('hi')).toBe(false);
    expect(await ub.command('/ub alias remove 1')).toEqual(['Removed alias 1']);
    expect(await ub.command('/ub alias list')).toEqual(['1. ^hi$ -> Expression: setvar[x,1] (not eaten)']);
  });

  it('game events fire on login, logout and a death\'s drop line, with gevt_ variables', async () => {
    const { ub, h } = setup();
    expect(await ub.command('/ub events add LoginComplete ChatCommand /framerate')).toEqual(['Added game event 1: LoginComplete -> ChatCommand: /framerate']);
    await ub.command('/ub events add CharacterDeath ChatExpression \\/f I died');
    expect(await ub.command('/ub events info characterdeath')).toEqual(['Event: CharacterDeath', 'Event Variables:', '  $gevt_deathmessage', '  $gevt_droppeditems']);
    h.scr = 'character-select';
    ub.tick();
    h.scr = 'world';
    ub.tick();
    expect(h.chats).toContain('/framerate');
    expect(h.vars_.gevt_name).toBe('Tester');
    h.push('death', 'You are liquified by Olthoi Slasher\'s attack!');
    h.push('chat', "You've lost 70 Pyreals!");
    ub.tick();
    expect(h.vars_.gevt_deathmessage).toBe('You are liquified by Olthoi Slasher\'s attack!');
    expect(h.vars_.gevt_droppeditems).toBe('70 Pyreals!');
    expect(deathDrops('You have retained all your items.')).toBe('');
    expect(deathDrops('hello')).toBeNull();
    expect(fireGameEvent('Logout', {}, [], { chat: () => {}, evaluate: () => '', setVar: () => {} })).toBe(0);
  });
});

describe('small commands', () => {
  it('prepclick answers the next dialog in time, or says the era has no confirmations', async () => {
    const { ub, h } = setup();
    expect(await ub.command('/ub prepclick yes 10')).toEqual(['Will click yes on the next dialog to appear within 10 seconds']);
    h.dlg = [{ text: 'Swear allegiance?', buttons: ['Yes', 'No'] }];
    ub.tick();
    expect(h.log).toContain('dialog Yes');
    expect(await ub.command('/ub prepclick stop')).toEqual(['Message boxes are not currently being watched']);
    h.lacks.confirmations = 'Yes / No confirmation dialogs';
    expect(await ub.command('/ub prepclick no 5')).toEqual(['This world has no Yes / No confirmation dialogs, so there is no dialog to click.']);
  });

  it('playeroption sets a character option by UB\'s name; an era without its feature says so', async () => {
    const { ub, h } = setup();
    expect(await ub.command('/ub playeroption AutoRepeatAttack on')).toEqual(['Set player option AutoRepeatAttack to On']);
    expect(h.opts.get(PLAYER_OPTIONS.AutoRepeatAttack!)).toBe(true);
    expect((await ub.command('/ub playeroption list'))![0]).toMatch(/^Valid values are: AutoRepeatAttack, /);
    expect((await ub.command('/ub playeroption Nope on'))![0]).toMatch(/^Invalid option\./);
    h.lacks.secureTrade = 'secure trade (September 2000)';
    expect(await ub.command('/ub playeroption IgnoreTradeRequests on')).toEqual(['This world has no secure trade (September 2000), so IgnoreTradeRequests has nothing to set.']);
  });

  it('login next by name, index, relative and looping; list; clear', async () => {
    const { ub, h } = setup();
    expect(await ub.command('/ub login next mule')).toEqual(['Logging in as Mule One next at index 1']);
    expect(h.next).toBe('Mule One');
    expect(await ub.command('/ub login nextrl 2')).toEqual(['Logging in as Alpha next at index 0']);
    expect(await ub.command('/ub login next 9')).toEqual(['Login index is out of bounds.  Use the [l]oop option to wrap around: /ub login nextl -100']);
    expect(h.next).toBeNull();
    expect((await ub.command('/ub login list'))!.slice(2)).toEqual(['0         Alpha                         ', '1         Mule One                      ', '2         **Tester**                    ', '3         Zed                           ']);
    expect(await ub.command('/ub login clear')).toEqual(['Next login cleared.']);
  });

  it('fellow and allegiance commands find the player and go through the panes', async () => {
    const { ub, h } = setup();
    h.world = [obj(30, 'Zero Cool', 'player', 4), obj(31, 'Bob', 'player', 2)];
    await ub.command('/ub fellow create Hunters');
    await ub.command('/ub fellow recruitp zero');
    await ub.command('/ub fellow leader');
    await ub.command('/ub fellow open');
    expect(h.log.filter((l) => l.startsWith('fellow'))).toEqual(['fellow create Hunters', 'fellow recruit Zero Cool', 'fellow leader Bob', 'fellow open']);
    expect(await ub.command('/ub swearallegiancep zero')).toEqual(['Swearing Allegiance to Zero Cool[0x0000001E]']);
    expect(h.log).toContain('swear 30');
    expect(await ub.command('/ub breakallegiance Bob')).toEqual(['Breaking Allegiance from Bob[0x0000001F]']);
    expect(h.log).toContain('break Bob');
  });
});

describe('the quest tracker (UB QuestTracker; /ub myquests, quests check, the quest meta functions)', () => {
  const line = 'regaliamaskuber - 1 solves (1522807913)"Player has collected the mask from a Virinidi Profatrix." -1 72000';
  it('parses ACE\'s /myquests lines as UB does', () => {
    expect(parseMyQuestLine(line)).toMatchObject({ key: 'regaliamaskuber', description: 'Player has collected the mask from a Virinidi Profatrix.', solves: 1, maxSolves: -1, completedOn: 1522807913, repeatSeconds: 72000 });
    const q = parseMyQuestLine('killtaskgolems - 5 solves (100)"Kill golems" 20 0')!;
    expect(questReady(q, 200_000)).toBe(true);
    expect(questReady(parseMyQuestLine('oncequest - 1 solves (100)"x" 1 0')!, 1e12)).toBe(false);
    expect(friendlyTime(90061)).toBe('1d 1h 1m 1s');
  });

  it('/ub myquests asks quietly through the client\'s one quest list (agent/questTracker.ts), which the meta functions read', async () => {
    vi.useFakeTimers();
    const { ub, h, quests } = setup();
    h.t = 1_700_000_100_000;
    expect(await ub.command('/ub myquests')).toEqual(['Refreshing quests']);
    expect(h.chats).toEqual(['@myquests']);
    expect(await ub.command('/ub myquests')).toEqual(['GetMyQuestsList called while it was already running']);
    expect(quests.onServerLine(line)).toBe(true);
    expect(quests.onServerLine('killtaskgolems - 5 solves (1700000000)"Kill golems" 20 0')).toBe(true);
    expect(quests.onServerLine('Someone says, "hi"')).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(quests.quest('KILLTASKGOLEMS')).toEqual({ solves: 5, maxSolves: 20, ready: true });
    await ub.command('/ub quests check killtask');
    // UB also thinks "has not been completed" when no flag is exactly the text.
    expect(h.chats.slice(-2)).toEqual(['/tell Tester, Quest: killtaskgolems is at 5 of 20', '/tell Tester, Quest: killtask has not been completed']);
    expect(await ub.command('/ub quests parse killtaskx - 2 solves (5)"y" 9 0')).toEqual(['Quest killtaskx repeat:0 solves:2/9']);
    vi.useRealTimers();
  });
});

describe('tinkering (UB AutoTinker / TinkerCalc; ACE RecipeManager.GetTinkerChance)', () => {
  it('the chance is ACE\'s: material mod, workmanship, attempt multiplier, the 0.03 sigmoid, imbues ÷ 3', () => {
    expect(materialMod(0x43)).toBe(11); // Granite
    expect(materialMod(0x3d)).toBe(12); // Iron
    expect(skillChance(300, 300)).toBeCloseTo(0.5);
    // Granite w10 on an item w8, first tink: floor((55 + 8·11·2 − 10·2·11/5) · 1) = 187.
    expect(tinkerChance({ material: 0x43, bagWork: 10, itemWork: 8, tinks: 0, skill: 187, imbue: false })).toBeCloseTo(0.5);
    expect(tinkerChance({ material: 0x43, bagWork: 10, itemWork: 8, tinks: 0, skill: 187, imbue: true })).toBeCloseTo(0.5 / 3);
    expect(tinkerChance({ material: 0x43, bagWork: 10, itemWork: 8, tinks: 10, skill: 999, imbue: false })).toBe(0);
  });

  it('tinkcalc picks granite or iron each step by damage; the plan takes the lowest bag that clears the minimum', () => {
    const r = bestGraniteIron({ maxDamage: 30, variance: 0.5, tinks: 0, spells: [] });
    expect(r.granite + r.iron).toBe(10);
    expect(r.order[0]).toBe('granite');
    const table: TinkerRow[] = [[0x43, 28, 1], [0x3d, 28, 1], [0x0f, 28, 2]];
    expect(tinkerRule(table, 0x0f)).toEqual({ skill: 28, imbue: true });
    const bags = [{ guid: 1, name: 'Salvaged Granite', material: 0x43, workmanship: 9 }, { guid: 2, name: 'Salvaged Granite', material: 0x43, workmanship: 6 }, { guid: 3, name: 'Salvaged Granite', material: 0x43, workmanship: 10 }];
    const plan = planTinkers({ table, target: { guid: 9, name: 'Axe', workmanship: 5, tinks: 0, melee: true }, bags, material: 0x43, skillOf: () => 400, minChance: 99, maxTinks: 10 });
    expect(plan.steps.map((s) => s.bag.guid)).toEqual([2, 1, 3]);
    expect(plan.stop).toMatch(/no Granite/);
    expect(planTinkers({ table: [], target: { guid: 9, name: 'Axe', workmanship: 5, tinks: 0, melee: true }, bags, material: 0x43, skillOf: () => 400, minChance: 99, maxTinks: 10 }).stop).toBe("Granite doesn't tinker in this world");
  });

  it('/ub tinkcalc and autotinker answer with the era\'s reason where it has no tinkering', async () => {
    const { ub, h } = setup();
    h.lacks.salvage = 'salvaging and tinkering';
    expect(await ub.command('/ub tinkcalc')).toEqual(['This world has no salvaging and tinkering.']);
    delete h.lacks.salvage;
    expect(await ub.command('/ub autotinker granite')).toEqual(["This world's recipes have no tinkering."]);
    h.tinker = [[0x43, 28, 1], [0x3d, 28, 1]];
    h.inv = [{ guid: 9, name: 'Axe', where: 'pack', itemType: 0x1 }, { guid: 1, name: 'Salvaged Granite', where: 'pack', materialType: 0x43, workmanship: 10, structure: 100 }];
    h.data.set(9, { int: { 105: 5, 171: 0, 44: 30 }, float: { 22: 0.5 }, spells: [] });
    h.skillRows = [{ id: 28, name: 'Weapon Tinkering', training: 'trained', base: 400, buffed: 400 }];
    h.sel = 9;
    expect((await ub.command('/ub tinkcalc'))![1]).toMatch(/^Axe: Final max damage: [\d.]+, \d+ granite, \d+ iron$/);
    const jobs = (await ub.command('/ub autotinker granite'))!;
    expect(jobs[0]).toBe('Tinker jobs for Axe:');
    expect(jobs[1]).toMatch(/^ {2}1\. Salvaged Granite \(w10\.00\): 99\.\d\d%$/);
    expect(await ub.command('/ub getjob')).toEqual(jobs.slice(0, -1));
    h.dlg = [{ text: 'You have a 100% chance', buttons: ['Yes', 'No'] }];
    expect(await ub.command('/ub autotinker start')).toEqual(['AutoTinker: applying 1 to Axe.']);
    await settle();
    expect(h.log).toContain('useon 1 9');
    expect(h.log).toContain('dialog Yes');
  });

  it('the per-era tables come from each era\'s recipes: none in 1999, the skills ACE\'s recipes give', () => {
    const eol = JSON.parse(eolTinker) as TinkerRow[];
    expect(JSON.parse(ac1999Tinker)).toEqual([]);
    expect(tinkerRule(eol, 0x43)).toEqual({ skill: 28, imbue: false }); // Granite: Weapon Tinkering
    expect(tinkerRule(eol, 0x0f)?.imbue).toBe(true); // Black Garnet imbues
    expect((JSON.parse(dmTinker) as TinkerRow[]).length).toBeGreaterThan(0);
    expect(bagMaterial('Salvaged Black Garnet')).toBe(0x0f);
    expect(bagMaterial('Salvage (Granite)')).toBe(0x43);
    expect(bagMaterial('Bowl')).toBeNull();
    const sql = "INSERT INTO `recipe` (`id`, `unknown_1`, `skill`, `difficulty`, `salvage_Type`, `success_W_C_I_D`) VALUES (3852, 0, 28 /* WeaponTinkering */, 0, 1, 0, 0, 'x');\nINSERT INTO `cook_book` (`recipe_Id`, `source_W_C_I_D`, `target_W_C_I_D`, `last_Modified`) VALUES (3852, 20985 /* Salvaged Granite */,   141 /* Bowl */, 'd'), (3852, 20985 /* Salvaged Granite */, 142 /* Chalice */, 'd');";
    expect(compactRows(parseTinkerSql(sql))).toEqual([[0x43, 28, 1]]);
  });
});

describe('UseSpecialAmmo\'s table (tools/build-ammo-tables.ts)', () => {
  it('Raider by name; SCurrency: ammo whose heads only an alternate-currency vendor sells', () => {
    const vendor = parseWeenieSql("INSERT INTO `weenie` (`class_Id`, `class_Name`, `type`, `last_Modified`)\nVALUES (36378, 'x', 12, 'd') /* Vendor */;\nINSERT INTO `weenie_properties_string` (`object_Id`, `type`, `value`)\nVALUES (36378,   1, 'Hisham al-Evv') /* Name */;\nINSERT INTO `weenie_properties_d_i_d` (`object_Id`, `type`, `value`)\nVALUES (36378,  57,      36376) /* AlternateCurrency - Small Olthoi Venom Sac */;\nINSERT INTO `weenie_properties_create_list` (`object_Id`, `destination_Type`, `weenie_Class_Id`, `stack_Size`, `palette`, `shade`, `try_To_Bond`)\nVALUES (36378, 4, 36375, -1, 0, 0, False) /* Create Crate of Olthoi Acid Arrowheads (36375) for Shop */;")!;
    expect(vendor).toEqual({ wcid: 36378, name: 'Hisham al-Evv', type: 12, altCurrency: true, shop: ['Crate of Olthoi Acid Arrowheads'] });
    expect(ammoFamily('Spectral Chill Arrow Bundle')).toBe('Spectral Chill');
    expect(ammoFamily('Mana Scarab')).toBeNull();
    const a = (wcid: number, name: string) => ({ wcid, name, type: 5, altCurrency: false, shop: [] });
    expect(specialAmmo([vendor, a(1, 'Olthoi Acid Arrow'), a(2, 'Acid Arrow'), a(3, 'Raider Lightning Bolt')])).toEqual([['Olthoi Acid Arrow', 2], ['Raider Lightning Bolt', 1]]);
    const eol = new Map(JSON.parse(eolAmmo) as Array<[string, number]>);
    expect(eol.get('Raider Lightning Arrow')).toBe(1);
    expect(eol.get('Spectral Chill Arrow')).toBe(2);
    expect(eol.get('Deadly Fire Arrow')).toBeUndefined();
    // Neither classic world sells either kind.
    expect(JSON.parse(dmAmmo)).toEqual([]);
    expect(JSON.parse(ac1999Ammo)).toEqual([]);
  });
});

describe('the importer takes every /ub command the client runs (vtank.ts chatAction)', () => {
  it('ubVerbOf follows UB\'s dispatch; a meta\'s /ub line becomes a Chat step', () => {
    expect(ubVerbOf('/ub usepi x on y')).toBe('use');
    expect(ubVerbOf('/ub jumpsw 180')).toBe('jump');
    expect(ubVerbOf('/ub videopatch enable')).toBeNull();
    const chat = (text: string) => ({ cond: 1, condData: { t: 'i' as const, v: 0 }, act: 2, actData: { t: 's' as const, v: text }, state: 'Default' });
    const lines = ['/ub myquests', '/ub vendor open Tunlok', '/ub equip load Set A', '/ub xp slow', '/ub prepclick yes 10', '/ub opt set AutoVendor.TestMode true', '/ub givep 3 Taper to Bob', '/ub videopatch enable'];
    const { value: p } = metToProfile('X', lines.map(chat));
    const steps = p.states[0]!.rules.map((r) => r.do[0]);
    expect(steps.slice(0, 7)).toEqual(lines.slice(0, 7).map((text) => ({ kind: 'say', text })));
    expect(steps[7]).toMatchObject({ kind: 'unsupported' });
    expect(importVTank([], null, 'X').problems).toEqual([]);
  });
});

describe('UbStore', () => {
  it('reads defaults, keeps typed values, and survives an unreadable document', () => {
    const storage = new MemStorage();
    storage.setItem(ubStorageKey('S', 'C'), '{not json');
    const s = new UbStore(() => ({ server: 'S', character: 'C' }), () => storage);
    expect(s.get('autoxp.stopbeforemax')).toBe(10);
    expect(() => s.setText('AutoXp.StopBeforeMax', 'ten')).toThrow('AutoXp.StopBeforeMax takes a number');
    s.setText('AutoXp.StopBeforeMax', '3');
    expect(new UbStore(() => ({ server: 'S', character: 'C' }), () => storage).num('AutoXp.StopBeforeMax')).toBe(3);
  });
});
