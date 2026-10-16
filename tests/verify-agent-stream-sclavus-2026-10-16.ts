/**
 * The stream players' reports from the Sclavus camp and the Holtburg run (end-of-retail local ACE, segment 10:00–11:01
 * UTC 2026-10-16, build 4ad7ef9b; reports stream/reports/*2026-10-16T11-01*.md, transcripts
 * stream/sessions/{mage,soldier}-2026-10-16-seg1.jsonl, chat logs mage.chat.log / soldier.chat.log):
 *  1. "Phantom Sclavus hits": every hit from the Sata / Essa Sclavus standing 20–22 m away read "hit by, but not placed …
 *     its melee reaches through a wall" (cell 0xA3AD002C, 10:29–10:37). They were shooting: Sata Sclavus wield a Yumi and
 *     arrows, Essa Sclavus javelins (ACE-World wielded treasure 168 / 169; AiAllowedCombatStyle Bow | ThrownWeapon), and
 *     ACE's ranged monsters TurnTo their target and stand (Monster_Navigation). Their places were right; the attacker
 *     attribution only looked within melee reach.
 *  2. A give that went through showed "You can only move or use one item at a time" (another give's, sent 0.24 s later).
 *  3. `vendor target=#7a9b301a` was refused as an unknown argument with no hint.
 *  4. The Academy Dirk was listed under filter=sell; every vendor said "The Academy Dirk is unsellable." (ACE refuses
 *     !IsSellable || Retained, both sent in an appraisal).
 * Each drives the shipped AgentApi / format / tools code against the fake host (tests/_harness/agentFake.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { filterInventory, formatInventory, formatInventoryFiltered, formatObservation, isSellable } from '../packages/renderer/src/agent/format.ts';
import { TOOL_BY_NAME, TOOL_CALLER } from '../tools/ac-agent/tools.ts';
import { parseCliArgs } from '../tools/ac-agent/cli.ts';
import { READ_METHODS } from '../packages/renderer/src/agent/claudeControl.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const SATA = 0x80003ab7;
const ESSA = 0x80003991;
const YUMI = 0x80003ab8;

describe('1. a monster shooting at you from 20 m is placed (Sata Sclavus, 0xA3AD002C, 10:29 UTC)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    // You at (80, 20); the Sata 22.3 m SE, an Essa beside you.
    host.add({ guid: SATA, name: 'Sata Sclavus', itemType: 0x10, objectDescFlags: 0x10, x: 95.8, y: 4.2, level: 60 });
    host.add({ guid: ESSA, name: 'Essa Sclavus', itemType: 0x10, objectDescFlags: 0x10, x: 81.5, y: 19.4, level: 30 });
  });
  afterEach(() => vi.useRealTimers());

  it('wielding a bow: its arrows go to it at 22 m, and observe says ATTACKING YOU, not "not placed"', () => {
    host.add({ guid: YUMI, name: 'Yumi', itemType: 0x100, objectDescFlags: 0, cell: null, wielderId: SATA });
    api.pushChat('Critical hit! Sata Sclavus nicks your lower leg for 6 points of piercing damage!', 0x15);
    api.pushChat('Sata Sclavus nicks your abdomen for 3 points of piercing damage!', 0x15);
    api.pushChat('Essa Sclavus nicks your chest for 1 point of piercing damage!', 0x15);
    expect([...api.attackersOfMe()]).toEqual([[SATA, 2], [ESSA, 1]]);
    expect(api.attackersUnplaced()).toEqual([]);
    const text = formatObservation(api.observe());
    expect(text).not.toMatch(/not placed/);
    expect(text).toMatch(/under attack by: .*Sata Sclavus #80003ab7 22\.\dm \(2× in 10 s\)/);
  });

  it('turned to face you (ACE TurnTo: a ranged monster aims and stands) is placed too, with no weapon seen', () => {
    host.objs.get(SATA)!.seeks = { guid: host.me.guid, kind: 'turn' };
    api.pushChat('Sata Sclavus nicks your foot for 3 points of piercing damage!', 0x15);
    expect([...api.attackersOfMe()]).toEqual([[SATA, 1]]);
  });

  it('a melee monster 22 m off with no missile weapon stays unplaced (a swing reaches 8 m), as before', () => {
    host.add({ guid: 0x80003abc, name: 'Spear', itemType: 0x1, objectDescFlags: 0, cell: null, wielderId: SATA });
    api.pushChat('Sata Sclavus nicks your foot for 3 points of piercing damage!', 0x15);
    expect(api.attackersOfMe().size).toBe(0);
    expect(api.attackersUnplaced()).toEqual([{ name: 'Sata Sclavus', count: 1 }]);
  });

  it('beyond any missile range (ACE MissileRangeCap 85 yd = 78 m) a bow does not place it', () => {
    host.objs.get(SATA)!.x = 80; host.objs.get(SATA)!.y = 99;
    host.add({ guid: YUMI, name: 'Yumi', itemType: 0x100, objectDescFlags: 0, cell: null, wielderId: SATA });
    api.pushChat('Sata Sclavus nicks your foot for 3 points of piercing damage!', 0x15);
    expect(api.attackersOfMe().size).toBe(0);
  });
});

describe('2. a give that went through drops a busy notice from its reply (Bulwark, 10:41:15 UTC)', () => {
  let host: FakeHost;
  let api: AgentApi;
  const ARCANIST = 0x500000a3;
  const SCROLL = 0x8000ee56;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.inv = [{ guid: SCROLL, name: 'Scroll of Flame Volley IV', where: 'main pack', itemType: 0x2000 }];
    host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80.8, y: 20 });
  });
  afterEach(() => vi.useRealTimers());
  async function settle<T>(p: Promise<T>, ms: number): Promise<T | null> {
    let out: T | null = null;
    let done = false;
    void p.then((x) => { out = x; done = true; });
    for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
    return out;
  }

  it('the item left the pack: "gave …", and the other give\'s "one item at a time" is not in it', async () => {
    host.give = (t, i, n) => {
      host.sent.push(`give ${i.toString(16)} to ${t.toString(16)} x${n}`);
      setTimeout(() => api.pushChat('You can only move or use one item at a time', 0x1a), 150);
      setTimeout(() => { host.inv = []; api.pushChat('You give Claude Arcanist Scroll of Flame Volley IV.', 0x0); }, 400);
      return true;
    };
    const r = await settle(api.give('Scroll of Flame Volley IV', 'Claude Arcanist', null), 20_000);
    expect(r).toEqual({ ok: true, message: 'gave 1 Scroll of Flame Volley IV to Claude Arcanist\n  You give Claude Arcanist Scroll of Flame Volley IV.' });
    expect(host.sent.filter((x) => x.startsWith('give'))).toHaveLength(1);
  });

  it('a give that really failed still reports it', async () => {
    host.give = (t, i, n) => {
      host.sent.push(`give ${i.toString(16)} to ${t.toString(16)} x${n}`);
      setTimeout(() => api.pushChat('You can only move or use one item at a time', 0x1a), 300);
      return true;
    };
    const r = await settle(api.give('Scroll of Flame Volley IV', 'Claude Arcanist', null), 40_000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toContain('You can only move or use one item at a time');
  });
});

describe('3. ac_vendor target= opens the vendor through ac_use\'s own use (11 refusals, 2026-10-16)', () => {
  let host: FakeHost;
  let api: AgentApi;
  const SCRIVENER = 0x7a9b301a;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.add({ guid: SCRIVENER, name: 'Journeyman Scrivener of Item Magic', itemType: 0x10, objectDescFlags: 0x200, x: 80.6, y: 20 });
  });
  afterEach(() => vi.useRealTimers());
  async function settle<T>(p: Promise<T>, ms: number): Promise<T | null> {
    let out: T | null = null;
    let done = false;
    void p.then((x) => { out = x; done = true; });
    for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
    return out;
  }
  const window = { name: 'Journeyman Scrivener of Item Magic', guid: SCRIVENER, currency: 'Pyreals', items: [{ guid: 0x80000f89, name: 'Foci of Artifice', price: 25000 }] };

  it('not open: uses it, then lists its stock', async () => {
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); setTimeout(() => { host.vendorOpen = window; }, 300); return true; };
    const r = await settle(api.vendorAt(SCRIVENER), 20_000);
    expect(host.sent).toContain(`use ${SCRIVENER.toString(16)}`);
    expect(r?.ok).toBe(true);
    expect(r?.message.split('\n')[0]).toBe('(used Journeyman Scrivener of Item Magic to open its window)');
    expect(r?.message).toContain('#80000f89 Foci of Artifice  25000');
  });

  it('already open: just the listing, no use sent', async () => {
    host.vendorOpen = window;
    const r = await settle(api.vendorAt(SCRIVENER), 2000);
    expect(r?.message).toMatch(/^Journeyman Scrivener of Item Magic sells/);
    expect(host.sent.filter((s) => s.startsWith('use'))).toEqual([]);
  });

  it('the use opened nothing: says so with the use\'s answer', async () => {
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); setTimeout(() => api.pushChat('Journeyman Scrivener of Item Magic is busy.', 0x1a), 300); return true; };
    const r = await settle(api.vendorAt(SCRIVENER), 30_000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^Journeyman Scrivener of Item Magic's vendor window did not open \(ac_use Journeyman Scrivener of Item Magic answered\):/);
  });

  it('the tool takes target= and calls the acting vendorAt; without it, the read vendor', async () => {
    const tool = TOOL_BY_NAME.get('ac_vendor')!;
    const calls: Array<[string, unknown[]]> = [];
    const caller = { notice: null, call: async <T,>(m: string, a: unknown[]) => { calls.push([m, a]); return { ok: true, message: 'x' } as T; } };
    await TOOL_CALLER.run(caller, () => tool.run(parseCliArgs(tool, ['target=#7a9b301a'])));
    await TOOL_CALLER.run(caller, () => tool.run(parseCliArgs(tool, [])));
    expect(calls).toEqual([['vendorAt', [0x7a9b301a]], ['vendor', []]]);
    // vendorAt walks and uses: an action (the relay's control gate and the daemon's reply deadline treat it so).
    expect(READ_METHODS.has('vendorAt')).toBe(false);
    expect(READ_METHODS.has('vendor')).toBe(true);
    expect(typeof (api.surface() as Record<string, unknown>).vendorAt).toBe('function');
  });
});

describe('4. an item no vendor buys is not under filter=sell (the Academy Dirk, Bulwark)', () => {
  let host: FakeHost;
  let api: AgentApi;
  const DIRK = 0x8000ba61;
  const MACE = 0x8000ba70;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.inv = [
      { guid: DIRK, name: 'Academy Dirk', where: 'main pack', itemType: 0x1, value: 200, type: 'Melee Weapon' },
      { guid: MACE, name: 'Flaming Great Star Mace', where: 'main pack', itemType: 0x1, value: 2300, type: 'Melee Weapon' },
    ];
  });
  afterEach(() => vi.useRealTimers());

  it('its appraisal says IsSellable false (PropertyBool 69): marked, and left out of filter=sell', () => {
    host.appraised.push(DIRK);
    host.appraisalDatas.set(DIRK, { int: {}, float: {}, string: {}, bool: { 69: false }, did: {}, spells: [] });
    const inv = api.inventory();
    expect(inv.find((i) => i.guid === DIRK)?.unsellable).toBe(true);
    expect(inv.find((i) => i.guid === MACE)?.unsellable).toBeUndefined();
    expect(filterInventory(inv, 'sell').items.map((i) => i.name)).toEqual(['Flaming Great Star Mace']);
    expect(formatInventory(inv)).toMatch(/#8000ba61 Academy Dirk {2}\(.*value 200, unsellable: no vendor buys it/);
    expect(formatInventoryFiltered(inv, 'weapon')).toMatch(/Academy Dirk {2}\(.*unsellable: no vendor buys it/);
  });

  it('Retained (PropertyBool 91) likewise; IsSellable true is sellable', () => {
    host.appraised.push(DIRK, MACE);
    host.appraisalDatas.set(DIRK, { int: {}, float: {}, string: {}, bool: { 91: true }, did: {}, spells: [] });
    host.appraisalDatas.set(MACE, { int: {}, float: {}, string: {}, bool: { 69: true }, did: {}, spells: [] });
    const inv = api.inventory();
    expect(isSellable(inv.find((i) => i.guid === DIRK)!)).toBe(false);
    expect(isSellable(inv.find((i) => i.guid === MACE)!)).toBe(true);
  });

  it('never appraised: a vendor\'s "The Academy Dirk is unsellable." marks it from then on', async () => {
    host.vendorOpen = { name: 'Pawn Shopkeep', guid: 0x80000c00, currency: 'Pyreals', items: [] };
    host.vendorSell = (g: number) => { setTimeout(() => api.pushChat('The Academy Dirk is unsellable.', 0x05), 300); return g > 0; };
    expect(filterInventory(api.inventory(), 'sell').items.map((i) => i.name)).toContain('Academy Dirk');
    const r = api.sell('Academy Dirk');
    await vi.advanceTimersByTimeAsync(6000);
    expect((await r).ok).toBe(false);
    expect(filterInventory(api.inventory(), 'sell').items.map((i) => i.name)).toEqual(['Flaming Great Star Mace']);
  });
});
