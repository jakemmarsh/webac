/**
 * AGENT.stream-reports-2026-10-18-0343: the AI stream pair's 02:41–03:43Z segment, 2026-10-18 (build 42518088; reports
 * stream/reports/{soldier-2026-10-18T03-43-21-815Z,mage-2026-10-18T03-42-39-338Z}-seg1.md; transcripts
 * stream/sessions/{soldier,mage}-2026-10-17-seg1.jsonl; page logs soldier.log / mage.log):
 * 1. "Bulwark fights" drinks a Stamina Elixir at 20% stamina; he carried none and went to 0/277 under a Dread (03:04Z).
 * 2. His stay_with walk leapt Mountain Keep's 7.1 m gap over 0x01D202A7 with Arcanist 10 m back (03:20:59Z); her own
 *    walk found no take-off once (a Dread beside her) and left the leap out for 30 min, though she had made it six times.
 * 3. With OnlyEngaged on, the routine ran after Dreads that went back up by routes of 10–85 doorways (03:16–03:20Z).
 * 4. `vendor target=` the Holtburg Pawn Shopkeep gave up at 45 s, 13 m short: three doorways left out as "something
 *    stands in it" (an NPC's disk on the straight line), the first of them 0.9 m from where he stalled (03:30:04–49Z).
 * 5. `equip` the Scalemail Shirt took the Covenant Pauldrons off (the double-click's one dequip) and was then refused
 *    for the girth; "not equipped" said nothing of the pauldrons, and `unequip` of them answered "is not worn".
 * 6. `buy items=` was refused as an unknown argument; `buy count=` too.
 * 7. `sell items=` with no window open was refused item by item; `sell target=<the Peddler> items=` sold to the
 *    Healer's window still open.
 * 8. Retail, said now: a mana stone on one item gives it only what it lacks (ACE ManaStone), the rest lost.
 *
 * Drives the real AgentApi / RoutineEngine / VtMacro and the real tool definitions on the fake host with the stream's
 * real profiles, and the real Mountain Keep cell DAT where routing matters.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import type { RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { routineSupplies, routineSuppliesLine } from '../packages/renderer/src/agent/macro/routineSupplies.ts';
import type { AgentItem, AgentResult } from '../packages/renderer/src/agent/types.ts';
import { TOOLS, TOOL_CALLER, routineFromFile, unknownArgs, vendorAndItem, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { readinessBrief } from '../tools/stream/prompt.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const REPO = resolve(__dirname, '..');
const ready = (profile: 'mage' | 'soldier'): RoutineProfile => {
  const r = routineFromFile(join(REPO, 'tools', 'stream', 'routines', `${profile}.json`));
  if ('text' in r) throw new Error(r.text);
  return r.profile;
};
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}
const tool = (name: string) => TOOLS.find((t) => t.name === name)!;
const MU = (n: number): number => (0x80000000 + n) >>> 0;
/** The host's paperdoll-to-pack move (AgentHost.placeItem), which the fake leaves out. */
const place = (h: FakeHost, f: (g: number) => boolean): void => { (h as unknown as { placeItem: (g: number) => boolean }).placeItem = f; };

// Bulwark's pack at 03:28:01Z (inventory), the parts that matter: kits, potions of the wrong name, no stamina at all.
const BULWARK_PACK = (): AgentItem[] => [
  { guid: 0x80007476, name: 'Excellent Healing Kit', where: 'main pack', type: 'Misc' },
  { guid: 0x8000b6b6, name: 'Excellent Healing Kit', where: 'main pack', type: 'Misc' },
  { guid: 0x8000b1f0, name: 'Excellent Healing Kit', where: 'main pack', type: 'Misc' },
  { guid: 0x8000e177, name: 'Potion of Healing', where: 'main pack', type: 'Misc', stack: 4 },
  { guid: 0x800082fc, name: 'Health Draught', where: 'main pack', type: 'Misc', stack: 5 },
  { guid: 0x800107e5, name: 'Mana Tincture', where: 'main pack', type: 'Misc' },
] as AgentItem[];

describe('1. what the routine drinks or bandages with, against what you carry', () => {
  it('Bulwark\'s profile: no stamina supplies is said first, by the routine\'s own names and mark; the kits and Health Draughts it uses are counted', () => {
    const line = routineSuppliesLine(ready('soldier'), BULWARK_PACK());
    expect(line).toBe('routine supplies (routine.json): Stamina Elixir, Stamina Potion or Stamina Tincture: NONE carried (your routine drinks one at 20% stamina); Excellent Healing Kit 3 (your routine uses one at 55% health); Health Draught 5 (your routine drinks one at 55% health)');
    // A "Potion of Healing" is not a listed "Health Potion" (the macro matches Consumables by name), and the mana line is
    // off (Recharge-Norm-Mana 1).
    const s = routineSupplies(ready('soldier'), BULWARK_PACK());
    expect(s.map((x) => `${x.vital}/${x.kind}`)).toEqual(['health/kits', 'health/drinks', 'stamina/drinks']);
    expect(s.find((x) => x.vital === 'health' && x.kind === 'drinks')!.carried).toBe(5);
  });

  it('the segment opening\'s readiness block carries it, with the 10 elixirs he bought at 03:27:39 counted', () => {
    const before = readinessBrief({ items: BULWARK_PACK(), sheet: null, session: null, routine: ready('soldier') })!;
    expect(before).toContain('\n- routine supplies (routine.json): Stamina Elixir, Stamina Potion or Stamina Tincture: NONE carried (your routine drinks one at 20% stamina);');
    const after = readinessBrief({ items: [...BULWARK_PACK(), { guid: 0x80005b05, name: 'Stamina Elixir', where: 'main pack', type: 'Misc', stack: 10 } as AgentItem], sheet: null, session: null, routine: ready('soldier') })!;
    expect(after).toContain('- routine supplies (routine.json): Excellent Healing Kit 3 (your routine uses one at 55% health); Health Draught 5 (your routine drinks one at 55% health); Stamina Elixir 10 (your routine drinks one at 20% stamina)');
    // No routine given: no line (other callers unchanged).
    expect(readinessBrief({ items: BULWARK_PACK(), sheet: null, session: null })).not.toMatch(/routine supplies/);
  });

  it('Arcanist\'s profile: her marks (70% health, 25% stamina), her list (no kits), and her spells first in magic mode', () => {
    const line = routineSuppliesLine(ready('mage'), [{ guid: 1, name: 'Stamina Elixir', where: 'main pack', stack: 2 } as AgentItem]);
    expect(line).toBe('routine supplies (routine.json): Health Draught or Health Potion: NONE carried (your routine drinks one at 70% health); Stamina Elixir 2 (your routine drinks one at 25% stamina)');
    // With Life Magic on the sheet: VTank's Regular Spell row comes before food in magic mode.
    const sheet = 'Specialized skills: War Magic 267, Life Magic 254\nTrained skills: Item Enchantment 166';
    const brief = readinessBrief({ items: [{ guid: 1, name: 'Stamina Elixir', where: 'main pack', stack: 2 } as AgentItem], sheet, session: null, routine: ready('mage') })!;
    expect(brief).toContain('- routine supplies (routine.json): Health Draught or Health Potion: NONE carried (your routine drinks one at 70% health, in magic mode only when no Heal spell of yours does it); Stamina Elixir 2 (your routine drinks one at 25% stamina, in magic mode only when no Revitalize spell of yours does it)');
  });

  it('observe says it while the routine runs, and only what is missing', () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const host = new FakeHost();
      host.me.name = 'Claude Bulwark';
      host.inv = BULWARK_PACK();
      const api = new AgentApi(host);
      expect(api.observe().routineSupplies).toBeUndefined();
      api.routine.start(ready('soldier'));
      const obs = api.observe();
      expect(obs.routineSupplies).toBe('"Bulwark fights" needs what you don\'t carry: Stamina Elixir, Stamina Potion or Stamina Tincture: NONE carried (your routine drinks one at 20% stamina)');
      expect(formatObservation(obs)).toContain('\nroutine supplies: "Bulwark fights" needs what you don\'t carry: Stamina Elixir');
      host.inv = [...host.inv, { guid: 0x80005b05, name: 'Stamina Elixir', where: 'main pack', stack: 10 } as AgentItem];
      expect(api.observe().routineSupplies).toBeUndefined();
      api.routine.stop();
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });
});

describe('5. a shirt worn over three pieces: each comes off first, and what came off is said', () => {
  let host: FakeHost;
  let api: AgentApi;
  const PAULDRONS = 0x80006f9f, GIRTH = 0x8000ddb6, PLATE = 0x80000f8a, SHIRT = 0x8000412e;
  const wornAt = (g: number, mask: number, name: string): AgentItem => ({ guid: g, name, where: 'equipped', type: 'Armor', slot: 'Worn', mask, validLocations: mask, itemType: 0x2 } as AgentItem);
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.inv = [
      wornAt(PAULDRONS, 0x800, 'Covenant Pauldrons'), wornAt(GIRTH, 0x400, 'Chainmail Girth'), wornAt(PLATE, 0x200, 'Platemail Breastplate'),
      { guid: SHIRT, name: 'Scalemail Shirt', where: 'main pack', type: 'Armor', validLocations: 0xe00, itemType: 0x2 } as AgentItem,
    ];
    const item = (g: number) => host.inv.find((i) => i.guid === g)!;
    // ACE: a piece goes into the pack on request; a wield over anything still worn on its slots is refused.
    place(host, (g) => { Object.assign(item(g), { where: 'main pack', mask: undefined }); return true; });
    host.wield = (g) => {
      host.sent.push(`wield ${g.toString(16)}`);
      const it = item(g);
      const on = host.inv.find((i) => i.where === 'equipped' && ((i.mask ?? 0) & (it.validLocations ?? 0)));
      if (on) { api.pushChat(`You must remove your ${on.name} to wield ${it.name}`, 0x05); return true; }
      Object.assign(it, { where: 'equipped', mask: it.validLocations });
      return true;
    };
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('equip takes off the pauldrons, the girth and the breastplate one at a time, then wields: one call (was: refused with the pauldrons silently off)', async () => {
    const r = (await settle(api, host, api.equip(SHIRT), 30_000))!;
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/^equipped Scalemail Shirt \(.*\), taking off Covenant Pauldrons #80006f9f, Chainmail Girth #8000ddb6, Platemail Breastplate #80000f8a into your pack/);
    expect(host.inv.filter((i) => i.where === 'equipped').map((i) => i.name)).toEqual(['Scalemail Shirt']);
    expect(host.sent.filter((s) => s.startsWith('wield'))).toEqual([`wield ${SHIRT.toString(16)}`]);
  });

  it('a refusal still names what came off on the way (here the client\'s own dequip of the first blocker)', async () => {
    // A wield path that takes one blocker off itself and is then refused (retail AutoWield's single dequip).
    host.wield = (g) => {
      Object.assign(host.inv.find((i) => i.guid === PAULDRONS)!, { where: 'main pack', mask: undefined });
      api.pushChat('You must remove your Chainmail Girth to wield Scalemail Shirt', 0x05);
      return !!g;
    };
    place(host, () => false); // taking off by hand fails, so equip leaves it to the double-click
    const one = { ...host.inv.find((i) => i.guid === GIRTH)!, where: 'main pack' as const, mask: undefined };
    host.inv = host.inv.map((i) => (i.guid === GIRTH ? one : i)).filter((i) => i.guid !== PLATE);
    const r = (await settle(api, host, api.equip(SHIRT), 30_000))!;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/You must remove your Chainmail Girth to wield Scalemail Shirt/);
    expect(r.message).toMatch(/Covenant Pauldrons #80006f9f came off on the way \(the double-click takes off what holds the first of its slots, then wields\): it is in your pack/);
    // And unequip of it says where it is (it was right: it is in the pack).
    expect((await api.unequip(PAULDRONS)).message).toBe('Covenant Pauldrons is not worn (it is in your main pack)');
  });

  it('one piece in the way is the double-click\'s own swap, unchanged (no extra take-off)', async () => {
    host.inv = host.inv.filter((i) => i.guid === PLATE || i.guid === SHIRT).map((i) => (i.guid === SHIRT ? { ...i, validLocations: 0x200 } : i));
    host.wield = (g) => {
      host.sent.push(`wield ${g.toString(16)}`);
      Object.assign(host.inv.find((i) => i.guid === PLATE)!, { where: 'main pack', mask: undefined });
      Object.assign(host.inv.find((i) => i.guid === g)!, { where: 'equipped', mask: 0x200 });
      return true;
    };
    const r = (await settle(api, host, api.equip(SHIRT), 30_000))!;
    expect(r.ok, r.message).toBe(true);
    expect(r.message).toMatch(/taking off Platemail Breastplate #80000f8a into your pack/);
  });
});

describe('6, 7. buy and sell: items=, count=, and the vendor\'s window opened for them', () => {
  const HEALER = 0x7a7b4002, PEDDLER = 0x7a7b4003, PAWN = 0x7a9b2011;
  const caller = (answer: (m: string, args: unknown[]) => AgentResult) => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const c = { calls, call: async (method: string, args: unknown[] = []) => { calls.push({ method, args }); return answer(method, args); } } as unknown as ToolCaller & { calls: typeof calls };
    return c;
  };

  it('buy items= is taken (Arcanist\'s "Bracelet, High Mana Charge, High Mana Charge"): one buy each, a name listed twice bought as 2', async () => {
    const t = tool('ac_buy');
    expect(unknownArgs(t, { items: 'Bracelet, High Mana Charge' })).toBeNull();
    expect(unknownArgs(t, { item: '#80004fb9', count: 10 })).toBeNull();
    const c = caller((m, a) => (m === 'vendorReady' ? { ok: true, message: '' } : { ok: true, message: `bought ${String(a[1] ?? 1)} ${String(a[0])}` }));
    const out = await TOOL_CALLER.run(c, () => t.run({ items: 'Bracelet, High Mana Charge, High Mana Charge' }));
    // The window opened once first (2026-10-18 12:24Z), then a buy per name.
    expect(c.calls).toEqual([{ method: 'vendorReady', args: [null] }, { method: 'buy', args: ['Bracelet', 1] }, { method: 'buy', args: ['High Mana Charge', 2] }]);
    expect(out.text).toBe('bought 2 of 2:\n  Bracelet: bought 1 Bracelet\n  High Mana Charge x2: bought 2 High Mana Charge');
    // Bulwark's `buy item=#80004fb9 count=10` (03:27:37Z): count= is amount=.
    const c2 = caller(() => ({ ok: true, message: 'ok' }));
    await TOOL_CALLER.run(c2, () => t.run({ item: '#80004fb9', count: 10 }));
    expect(c2.calls).toEqual([{ method: 'buy', args: [0x80004fb9, 10] }]);
  });

  it('target= with item= or items= is the vendor (Bulwark\'s sell target=#7a7b4003 items=…), alone it is still the item; vendor= goes to the page last', async () => {
    expect(vendorAndItem({ target: '#7a7b4003', items: 'A' })).toEqual({ vendor: '#7a7b4003', item: null });
    expect(vendorAndItem({ target: 'Cap' })).toEqual({ vendor: null, item: 'Cap' });
    expect(vendorAndItem({ vendor: 'Peddler', target: 'Cap' })).toEqual({ vendor: 'Peddler', item: 'Cap' });
    const c = caller(() => ({ ok: true, message: 'sold' }));
    await TOOL_CALLER.run(c, () => tool('ac_sell').run({ target: '#7a7b4003', items: '#8000412e, #80004242' }));
    // A list is one page call now, the vendor with it (2026-10-18 12:24Z).
    expect(c.calls).toEqual([{ method: 'sellList', args: [[0x8000412e, 0x80004242], null, PEDDLER] }]);
    // With no vendor named, the page gets the old two arguments (a page from before this still answers).
    const c2 = caller(() => ({ ok: true, message: 'sold' }));
    await TOOL_CALLER.run(c2, () => tool('ac_sell').run({ item: 'Cap', amount: 2 }));
    expect(c2.calls).toEqual([{ method: 'sell', args: ['Cap', 2] }]);
  });

  describe('the page', () => {
    let host: FakeHost;
    let api: AgentApi;
    const SHIRT = 0x8000412e, GEM = 0x80004242;
    const stock = (name: string, guid: number) => ({ name, guid, currency: 'Pyreals', items: [{ guid: MU(0x4fb9), name: 'Stamina Elixir', price: 233 }] });
    beforeEach(() => {
      vi.useFakeTimers();
      vi.spyOn(console, 'log').mockImplementation(() => {});
      host = new FakeHost();
      host.me.pyreals = 4200;
      host.inv = [
        { guid: SHIRT, name: 'Scalemail Shirt', where: 'main pack', type: 'Armor', itemType: 0x2 } as AgentItem,
        { guid: GEM, name: 'Hematite', where: 'main pack', type: 'Gem', itemType: 0x800 } as AgentItem,
      ];
      // The Holtburg Healer and Peddler (0xA7B40100, ACE-World landblock_instance), 1 m apart; the Pawn Shopkeep far off.
      host.add({ guid: HEALER, name: 'Healer', itemType: 0x10, objectDescFlags: 0x200, x: 81, y: 21, z: 94 });
      host.add({ guid: PEDDLER, name: 'Peddler', itemType: 0x10, objectDescFlags: 0x200, x: 80.5, y: 22, z: 94 });
      // A use opens that vendor's window (ACE Vendor.ActOnUse → ApproachVendor).
      const use0 = host.use;
      host.use = (g) => { const o = host.objs.get(g); if (o && (o.objectDescFlags & 0x200)) host.vendorOpen = stock(o.name, g); return use0(g); };
      // The Peddler takes gems (MerchandiseItemTypes 1074030613 has Gem); the Healer only Misc and notes (262272).
      host.vendorSell = (g, n) => {
        host.sent.push(`sell ${g.toString(16)} x${n} to ${host.vendorOpen?.name}`);
        const it = host.inv.find((i) => i.guid === g)!;
        if (host.vendorOpen?.name === 'Peddler' && it.type === 'Gem') { host.inv = host.inv.filter((i) => i.guid !== g); host.me.pyreals! += 1046; }
        else api.pushChat('That item cannot be sold here', 0x05);
        return true;
      };
      api = new AgentApi(host);
    });
    afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
    const surface = () => api.surface() as unknown as { sell: (i: unknown, n?: unknown, v?: unknown) => Promise<AgentResult>; buy: (i: unknown, n?: unknown, v?: unknown) => Promise<AgentResult> };

    it('sell with vendor= the Peddler while the Healer\'s window is open: the Peddler\'s window is opened, and the gem sold there', async () => {
      host.vendorOpen = stock('Healer', HEALER);
      const r = (await settle(api, host, surface().sell(GEM, null, PEDDLER), 30_000))!;
      expect(r.ok, r.message).toBe(true);
      expect(r.message).toMatch(/^\(used Peddler to open its window; Healer's was the one open\)\nsold Hematite for 1046 pyreals/);
      expect(host.sent).toContain(`sell ${GEM.toString(16)} x1 to Peddler`);
    });

    it('sell with no window open and two vendors beside you asks which; with one, it opens it (was "no vendor window is open (ac_use the vendor first)")', async () => {
      const two = (await settle(api, host, surface().sell(GEM), 30_000))!;
      expect(two.ok).toBe(false);
      expect(two.message).toMatch(/no vendor window is open, and 2 vendors stand near \(Healer #7a7b4002 .*Peddler #7a7b4003 .*\): name one with vendor=<name or #id>/);
      host.objs.delete(HEALER);
      const one = (await settle(api, host, surface().sell(GEM), 30_000))!;
      expect(one.ok, one.message).toBe(true);
      expect(one.message).toMatch(/^\(used Peddler to open its window\)\nsold Hematite/);
    });

    it('no vendor within 12 m and none open: the nearest is named; an open window is used as before; buy opens one too', async () => {
      host.objs.delete(HEALER); host.objs.delete(PEDDLER);
      host.add({ guid: PAWN, name: 'Pawn Shopkeep', itemType: 0x10, objectDescFlags: 0x200, x: 80, y: 50, z: 94 });
      const far = (await settle(api, host, surface().sell(GEM), 30_000))!;
      expect(far.message).toMatch(/no vendor window is open, and no vendor stands within 12 m \(the nearest: Pawn Shopkeep #7a9b2011, 30 m N\): name one with vendor=/);
      host.vendorOpen = stock('Healer', HEALER);
      const here = (await settle(api, host, surface().sell(SHIRT), 30_000))!;
      expect(here.message).not.toMatch(/used /);
      expect(here.message).toMatch(/Scalemail Shirt was not sold\nThat item cannot be sold here/);
      host.vendorOpen = null;
      host.objs.get(PAWN)!.y = 25;
      const buy = (await settle(api, host, surface().buy('Stamina Elixir', 2), 30_000))!;
      expect(buy.message).toMatch(/^\(used Pawn Shopkeep to open its window\)/);
      expect(host.sent).toContain(`buy ${MU(0x4fb9).toString(16)} x2`);
    });

    it('a named "vendor" that is not one is refused before any walk', async () => {
      host.add({ guid: 0x50000077, name: 'Claude Arcanist', itemType: 0x10, x: 81, y: 20, z: 94 });
      host.vendorOpen = stock('Healer', HEALER);
      const r = (await settle(api, host, surface().sell(GEM, null, 'Claude Arcanist'), 10_000))!;
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/no vendor/);
      expect(host.sent.filter((s) => s.startsWith('use'))).toEqual([]);
    });
  });
});

describe('4. a doorway left out as blocked comes back once you stand in it', () => {
  let host: FakeHost;
  let api: AgentApi;
  const lines: string[] = [];
  beforeEach(() => {
    vi.useFakeTimers();
    lines.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { lines.push(a.join(' ')); });
    host = new FakeHost();
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('an NPC stands in the doorway as the walk sets off; the walk stalls beside it, puts it back in the route and goes through (was: left out for the rest of the walk)', async () => {
    const LB = (HOLTBURG & 0xffff0000) >>> 0;
    const ROOM = (LB | 0x0106) >>> 0, SHOP = (LB | 0x0114) >>> 0, PAWN = 0x7a9b2011;
    const ox = ((LB >>> 24) & 0xff) * 192, oy = ((LB >>> 16) & 0xff) * 192;
    host.me.cell = ROOM; host.me.x = 80; host.me.y = 28.8; host.me.z = 0;
    // A wall along y 30 with the doorway at x 80 (79–81); the room a 6 m wide hall south of it. The Gamesmaster's disk
    // stands in the doorway as the walk sets off (the walk's probe sees NPC disks, as live) and steps aside once the walk
    // has stalled beside it.
    const aside = (): boolean => lines.some((l) => /walk stall 1 /.test(l));
    host.wall = (x, y) => (y >= 29.5 && y <= 30.5 && !(x > 79 && x < 81)) || (y < 29.5 && (x < 77 || x > 83)) || (!aside() && Math.hypot(x - 80, y - 30) < 1.1);
    // The cell graph's doorway route: through the doorway at (80, 30); with it left out, a doorway at (70, 30) the
    // statics wall off; with both, none.
    const closedRoutes: Array<Array<{ x: number; y: number }>> = [];
    const at = (cl: Array<{ x: number; y: number }> | undefined, x: number) => (cl ?? []).some((c) => Math.hypot(c.x - x, c.y - 30) < 1.5);
    (host as unknown as { route: unknown }).route = (_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }, o?: { closed?: Array<{ x: number; y: number }> }) => {
      closedRoutes.push(o?.closed ?? []);
      if (!at(o?.closed, 80)) return [{ x: 80, y: 30, z: 0 }, to];
      if (!at(o?.closed, 70)) return [{ x: 70, y: 30, z: 0 }, to];
      return null;
    };
    host.add({ guid: PAWN, name: 'Pawn Shopkeep', itemType: 0x10, objectDescFlags: 0x200, cell: SHOP, x: 80, y: 40, z: 0 });
    const r = await settle(api, host, api.walkTo(PAWN, { within: 2.5, timeoutMs: 45_000 }), 50_000);
    const trace = lines.filter((l) => /walk/.test(l)).join('\n');
    expect(trace).toMatch(new RegExp(`walk: no way into the doorway at \\(${ox + 80}\\.0, ${oy + 30}\\.0\\) \\(something stands in it\\); routing round it`));
    expect(trace).toMatch(new RegExp(`walk: at the doorway \\(${ox + 80}\\.0, ${oy + 30}\\.0\\) left out as blocked \\(something stood in it\\); you stand in it now, so routing through it again, 1 doorway\\(s\\)`));
    // The route asked for after it leaves the doorway out no more.
    const i = closedRoutes.findIndex((c, k) => k > 0 && !at(c, 80) && closedRoutes.slice(0, k).some((p) => at(p, 80)));
    expect(i, trace).toBeGreaterThan(0);
    expect(r?.ok, `${r?.message}\n${trace}`).toBe(true);
    expect(host.me.y).toBeGreaterThan(36);
  });
});

describe('8. a mana stone on one item: the rest is lost (ACE ManaStone), said with the items still out', () => {
  it('the hammer filled, the tassets still at 0/564: the answer says so and names the use on yourself', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const host = new FakeHost();
      const HAMMER = 0x80001c7a, TASSETS = 0x80010419, STONE = 0x800032dd;
      host.inv = [
        { guid: HAMMER, name: 'Lugian Hammer', where: 'equipped', type: 'Melee Weapon', slot: 'Wielded', itemType: 0x1 },
        { guid: TASSETS, name: 'Yoroi Tassets', where: 'equipped', type: 'Armor', slot: 'Worn', itemType: 0x2 },
        { guid: STONE, name: 'High Mana Charge', where: 'main pack', type: 'Mana Stone' },
      ] as AgentItem[];
      host.appraisalDatas.set(HAMMER, { int: { 107: 0, 108: 294 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
      host.appraisalDatas.set(TASSETS, { int: { 107: 0, 108: 564 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
      host.appraised.push(HAMMER, TASSETS);
      const api = new AgentApi(host);
      api.pushChat('Your Lugian Hammer is out of Mana.', 0x07);
      api.pushChat('Your Yoroi Tassets is out of Mana.', 0x07);
      host.useWithTarget = (s, t) => {
        host.sent.push(`usewith ${s.toString(16)} ${t.toString(16)}`);
        host.appraisalDatas.get(HAMMER)!.int[107] = 294;
        host.inv = host.inv.filter((i) => i.guid !== STONE);
        api.pushChat('The Mana Stone gives 294 points of mana to the Lugian Hammer.', 0x07);
        api.pushChat('The Mana Stone is destroyed.', 0x07);
        return true;
      };
      const r = (await settle(api, host, api.useOnReported(STONE, HAMMER), 20_000))!;
      expect(r.message, r.message).toMatch(/Lugian Hammer now: mana 294\/294/);
      expect(r.message).toMatch(/\(still out of mana: Yoroi Tassets 0\/564; a stone used on one item gives it only what it lacks and the rest of its charge is lost with it, while one used on yourself \(ac_use_on the stone with target=self\) is shared out among every worn item that needs mana\)/);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });
});

describe.skipIf(!existsSync(DAT_PATHS.cell) || !existsSync(DAT_PATHS.portal))('2, 3. the real Mountain Keep (0x01D2)', () => {
  const LB = 0x01d20000;
  const C = (n: number): number => (LB | n) >>> 0;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    // Buffed, as both were in the Keep that night (Quickness Other V, Arcanist's own): the split test's Arcanist config
    // (verify-stream-split-2026-10-17-2029.ts), whose jump makes the 7.1 m leap; Bulwark's made it live at 03:20:59Z.
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 230, runRate: getClientRunRate(0.5, 200) });
  }, 120_000);
  beforeEach(() => { vi.useFakeTimers(); vi.spyOn(console, 'log').mockImplementation(() => {}); });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const ARC = 0x50000077, BUL = 0x50000088;
  const newHost = async (name: string) => {
    const { DungeonHost } = await import('./_harness/dungeonWalk.js');
    const host = new DungeonHost(nav, { portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) }, LB, { rooms: true });
    host.me.health = { current: 187, max: 187 };
    host.me.stamina = { current: 277, max: 277 };
    host.me.name = name;
    return host;
  };
  const cellAt = (x: number, y: number, z: number): number => nav.col.findCellContaining(192 + x, 40320 + y, z + 0.5, 0)! >>> 0;

  it('2. a stay_with walk across the 7.1 m gap over 0x01D202A7 waits at the take-off while the fellow is behind, and jumps once she is beside it', async () => {
    const host = await newHost('Claude Bulwark');
    // Arcanist following 2 s (about 8 m) behind him, inside the leash, as at 03:20:59Z (her routine's follow, casting on
    // the way): she stops at the north doorway, and comes up beside him 5 s into his wait at the take-off.
    const start = { x: 90, y: -54.5, z: 0 };
    host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, cell: cellAt(start.x, start.y + 8, 0), x: start.x, y: start.y + 8, z: 0, heardAt: 0 });
    host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 183, max: 183 }, stamina: { cur: 247, max: 247 }, mana: { cur: 329, max: 329 } }];
    try {
      const trail: Array<{ t: number; cell: number; x: number; y: number; z: number }> = [];
      let waitAt = 0, joined = false, launchesAtWait = -1;
      // Bulwark from the north doorway (soldier.log 03:20:59Z: the leg from (282.0, 40265.5) to the take-off).
      const r = await host.run(cellAt(start.x, start.y, 0), start, (api) => api.walkTo('0x01D20294', { stayWith: 'Claude Arcanist', timeoutMs: 120_000 }), {
        maxMs: 120_000,
        each: () => {
          const a = host.objs.get(ARC)!;
          a.heardAt = host.t;
          trail.push({ t: host.t, cell: host.me.cell, x: host.me.x, y: host.me.y, z: host.me.z });
          if (!waitAt && host.traces.some((l) => /waiting at the take-off of a 7\.1 m gap/.test(l))) { waitAt = host.t; launchesAtWait = host.launches.length; }
          if (!waitAt) {
            const was = [...trail].reverse().find((p) => p.t <= host.t - 2000);
            // She stops (casting) at the north doorway, 9 m short of the take-off: inside the leash, not beside him.
            if (was && was.y >= -55.5) Object.assign(a, { cell: was.cell, x: was.x, y: was.y, z: was.z });
          } else if (!joined && host.t - waitAt > 5000) {
            joined = true;
            expect(host.launches.length).toBe(launchesAtWait);
            Object.assign(a, { cell: host.me.cell, x: host.me.x + 0.8, y: host.me.y + 0.5, z: host.me.z });
          }
        },
      });
      const trace = host.traces.join('\n');
      expect(trace, `${r.message}\n${trace.slice(-3000)}`).toMatch(/walk: waiting at the take-off of a 7\.1 m gap for Claude Arcanist \(\d+ m [NSEW]+\) to come up: they jump it after you/);
      expect(launchesAtWait, trace.slice(-3000)).toBe(0);
      expect(joined).toBe(true);
      expect(trace).toMatch(/walk: Claude Arcanist is here; across the 7\.1 m gap/);
      expect(host.launches.length, trace.slice(-3000)).toBeGreaterThan(0);
      // Across now, with her at the take-off (she jumps it after him): a wait for her that ends the walk names the gap.
      if (!r.ok) expect(r.message, r.message).toMatch(/you jumped a 7\.1 m gap on the way and they haven't come across: they jump it from where you took off/);
    } finally { host.dispose(); }
  }, 300_000);

  it('2. from Arcanist\'s spot (03:21:02Z) the take-off search is laid again a step aside and finds the leap; a no-take-off search for a leap made before doesn\'t leave it out', async () => {
    const host = await newHost('Claude Arcanist');
    try {
      // Her jump over the gap, as made 02:02:23Z: from the take-off to the far lip.
      const r = await host.run(C(0x2a6), { x: 88.8, y: -65, z: 0 }, (api) => api.walkTo('0x01D20294', { timeoutMs: 120_000 }), { maxMs: 120_000 });
      const api = (host as unknown as { api: AgentApi }).api;
      expect(host.launches.length, `${r.message}\n${host.traces.slice(-30).join('\n')}`).toBeGreaterThan(0);
      const landed = host.landings[host.landings.length - 1];
      const leap = { x: 192 + landed.x, y: 40320 + landed.y, z: landed.z, leap: 7.1 };
      // From her own spot (280.8, 40255.0) the first take-off search finds none; laid again a step aside it does (03:21:02Z).
      const walkTrace = host.traces.join('\n');
      expect(walkTrace).toMatch(/walk: no take-off on that search's grid; laying it again from \([\d.]+, [\d.]+\), a step aside \(1 of \d\)/);
      expect(walkTrace).not.toMatch(/remembering the 7\.1 m leap/);
      // A take-off search that does find none later (a Dread stood in the run-up): not remembered as a leap her jump fails.
      const said = (): string => vi.mocked(console.log).mock.calls.map((c) => c.join(' ')).join('\n');
      const noteFailed = (api as unknown as { noteLeapFailed: (p: { x: number; y: number; z: number; leap: number }, how: string) => void }).noteLeapFailed.bind(api);
      noteFailed(leap, 'no-takeoff');
      expect(said()).toMatch(/walk: no take-off found for the 7\.1 m leap to .* this time, but you made it \d+ min ago from .*: not left out/);
      expect(said()).not.toMatch(/remembering the 7\.1 m leap/);
      // So the route back across from the take-off side still takes the leap.
      Object.assign(host.me, { cell: C(0x2a6), x: 88.8, y: -65, z: 0 });
      const far = api.floorRoute({ guid: 1, name: 'x', itemType: 0, objectDescFlags: 0, cell: C(0x294), x: landed.x - 10, y: landed.y + 5, z: 0 } as never);
      expect(far && far !== 'none' && !('locked' in far) ? far.leaps : -1).toBe(1);
      // A leap never made is still remembered when its take-off isn't found.
      noteFailed({ x: 192 + 20, y: 40320 - 20, z: 0, leap: 6 }, 'no-takeoff');
      expect(said()).toMatch(/remembering the 6\.0 m leap/);
    } finally { host.dispose(); }
  }, 300_000);

  describe('3. "Bulwark fights" (OnlyEngaged, SkipUnreachableMonsters) and Dreads the long way round', () => {
    // Bulwark in 0x01D20127 (−12 floor) with Arcanist beside him; 0x01D20113 is 10 m west straight, about 41 m by the doorways.
    const ME = { x: 90, y: -67.3, z: -12 };
    const DREAD = MU(0x2a8b);
    const setUp = async () => {
      const host = await newHost('Claude Bulwark');
      host.me.combatMode = 'melee';
      host.inv = [{ guid: 0x80001c7a, name: 'Lugian Hammer', where: 'equipped', type: 'Melee Weapon', slot: 'Wielded', itemType: 0x1 }] as AgentItem[];
      (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 46, name: 'Heavy Weapons', training: 'specialized', base: 286, buffed: 286 }];
      (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells: new Map() });
      host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, cell: C(0x127), x: ME.x + 1, y: ME.y, z: ME.z, heardAt: 0 });
      host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: { cur: 183, max: 183 }, stamina: { cur: 247, max: 247 }, mana: { cur: 329, max: 329 } }];
      return host;
    };

    it('a Dread coming at you from 0x01D20113 is no target: the log says the way there is the long way round; one in your room is fought', async () => {
      const host = await setUp();
      try {
        host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: C(0x113), x: 80, y: -70, z: -12, level: 60, seeks: { guid: host.me.guid, kind: 'move' } });
        await host.run(C(0x127), ME, async (api) => { api.routine.start(ready('soldier')); return { ok: true, message: 'started' }; }, { maxMs: 200 });
        const api = (host as unknown as { api: AgentApi }).api;
        expect(api.meleeChaseBar(DREAD)).toMatch(/^it is 10 m W, but the way there is about 4\d m by the doorways: the long way round, away from you$/);
        await host.run(C(0x127), { x: host.me.x, y: host.me.y, z: host.me.z }, () => new Promise(() => {}), { maxMs: 4000, sameApi: true, each: () => { host.objs.get(ARC)!.heardAt = host.t; } });
        const hist = api.routine.history().join('\n');
        expect(host.sent.filter((s) => s.startsWith(`attack ${DREAD.toString(16)}`)), hist).toEqual([]);
        expect(hist).toMatch(/combat: not running after Dread Mu-miyah #80002a8b: it is 10 m W, but the way there is about 4\d m by the doorways: the long way round, away from you \(SkipUnreachableMonsters/);
        // Beside him (2.3 m): fought.
        Object.assign(host.objs.get(DREAD)!, { cell: C(0x127), x: ME.x, y: ME.y + 2.3, z: ME.z });
        await host.run(C(0x127), { x: host.me.x, y: host.me.y, z: host.me.z }, () => new Promise(() => {}), { maxMs: 4000, sameApi: true, each: () => { host.objs.get(ARC)!.heardAt = host.t; } });
        expect(api.meleeChaseBar(DREAD)).toBeNull();
        expect(host.sent.some((s) => s.startsWith(`attack ${DREAD.toString(16)}`)), api.routine.history().join('\n')).toBe(true);
        api.routine.stop();
      } finally { host.dispose(); }
    }, 300_000);

    it('sweep: a rules profile\'s attack-nearest skips it the same way (SkipUnreachableMonsters), and with the setting off goes after it', async () => {
      const host = await setUp();
      try {
        host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: C(0x113), x: 80, y: -70, z: -12, level: 60 });
        type Act = { act: (a: { kind: 'attack-nearest'; meters: number }, p: RoutineProfile) => Promise<AgentResult> };
        const rules = (skip: boolean): RoutineProfile => ({ ...ready('soldier'), macro: false, settings: { ...ready('soldier').settings, SkipUnreachableMonsters: skip } });
        let r: AgentResult | null = null;
        await host.run(C(0x127), ME, async (api) => { api.routine.start(rules(true)); r = await (api.routine as unknown as Act).act({ kind: 'attack-nearest', meters: 40 }, rules(true)); return r; }, { maxMs: 3000 });
        expect(r!.message).toBe('no monster in reach');
        const api = (host as unknown as { api: AgentApi }).api;
        api.routine.stop();
        await host.run(C(0x127), { x: host.me.x, y: host.me.y, z: host.me.z }, async (a) => { a.routine.start(rules(false)); void (a.routine as unknown as Act).act({ kind: 'attack-nearest', meters: 40 }, rules(false)); return { ok: true, message: '' }; }, { maxMs: 1500, sameApi: true });
        expect(host.sent.some((x) => x.startsWith(`attack ${DREAD.toString(16)}`)) || /walking to Dread|running up/.test(api.routine.history().join('\n')) || host.traces.some((l) => /walk /.test(l))).toBe(true);
        api.routine.stop();
      } finally { host.dispose(); }
    }, 300_000);

    it('a Dread that turns back up a storey mid run-up: the chase is stopped and said, and it is left alone (unless it hits you)', async () => {
      const host = await setUp();
      try {
        host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, cell: C(0x127), x: ME.x, y: ME.y + 2.3, z: ME.z, level: 60, seeks: { guid: host.me.guid, kind: 'move' } });
        await host.run(C(0x127), ME, async (api) => { api.routine.start(ready('soldier')); return { ok: true, message: 'started' }; }, { maxMs: 200 });
        const api = (host as unknown as { api: AgentApi }).api;
        let moved = false;
        await host.run(C(0x127), { x: host.me.x, y: host.me.y, z: host.me.z }, () => new Promise(() => {}), {
          maxMs: 6000, sameApi: true,
          each: () => {
            host.objs.get(ARC)!.heardAt = host.t;
            // The attack order is out: it goes back up to the 0x01D202A6 floor, 12 m over (the Keep's Dreads did, 03:16–03:20Z).
            if (!moved && host.sent.some((s) => s.startsWith(`attack ${DREAD.toString(16)}`))) { moved = true; Object.assign(host.objs.get(DREAD)!, { cell: C(0x2a6), x: 89, y: -61, z: 0, seeks: undefined }); }
          },
        });
        const hist = api.routine.history().join('\n');
        expect(moved, hist).toBe(true);
        expect(hist).toMatch(/combat: (stopped|not) running after Dread Mu-miyah #80002a8b: it is \d+ m [NSEW]+, 12 m up/);
        const attacks = host.sent.filter((s) => s.startsWith(`attack ${DREAD.toString(16)}`)).length;
        await host.run(C(0x127), { x: host.me.x, y: host.me.y, z: host.me.z }, () => new Promise(() => {}), { maxMs: 4000, sameApi: true, each: () => { host.objs.get(ARC)!.heardAt = host.t; } });
        expect(host.sent.filter((s) => s.startsWith(`attack ${DREAD.toString(16)}`)).length).toBe(attacks);
        api.routine.stop();
      } finally { host.dispose(); }
    }, 300_000);
  });
});
