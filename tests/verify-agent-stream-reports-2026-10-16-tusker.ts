/**
 * The tool bugs (not movement) the stream players (Claude Arcanist / Claude Bulwark, end-of-retail local ACE) reported
 * in the Tusker dungeon (Hollow Lair, landblock 0x039C), 2026-10-16 04:24–05:21 UTC (progress.md 2026-10-16):
 *  1. "Swift Killer V" / "Defender IV" didn't find Aura of Swift Killer Other V / Aura of Defender Other IV.
 *  2. Impenetrability IV with no target asked for target=self while Self spells defaulted to you.
 *  3. A fizzle said nothing of how near the skill is to landing it.
 *  4. use_on a healing kit during a swing: "You cannot move or use an item while attacking".
 *  5. After a portal the old target read 36 km away.
 *  6. use on a portal that had already taken you reported a failure.
 *  7. pick_up took item= only; target= was "unknown argument".
 *  8. inventory had no filter.
 *  9. give: the server's "You give …" read as no answer; a give that failed far off said nothing of the distance.
 * Each drives the shipped AgentApi / tools / format / ObjectRangeChecks code (fake host: tests/_harness/agentFake.ts).
 */
import { existsSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, isArmorRedirectBuff, magicSkillChance, matchSpell, schoolSkill, spellNameParts } from '../packages/renderer/src/agent/AgentApi.ts';
import { filterInventory, formatInventory, formatInventoryFiltered, formatObservation } from '../packages/renderer/src/agent/format.ts';
import type { AgentItem, AgentSpell } from '../packages/renderer/src/agent/types.ts';
import { TOOL_BY_NAME, TOOL_CALLER, argAliases, inputSchema, missingRequired, withArgAliases, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { parseCliArgs } from '../tools/ac-agent/cli.ts';
import { handle } from '../tools/ac-agent/mcp-server.ts';
import { inAnotherSpace } from '../packages/renderer/src/world/ObjectRangeChecks.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';
import { SpellTable } from '../packages/dat-parser/src/file-types/SpellTable.ts';
import { DatReader } from '../packages/dat-parser/src/DatReader.ts';

const BULWARK = 0x500000a4;
const ARCANIST = 0x500000a3;

/** Run the page's ticks (and the fake clock) until the promise settles, or `ms` pass. */
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

const SPELLS: AgentSpell[] = [
  { id: 6026, name: 'Aura of Swift Killer Other III', school: 'Item', level: 3, category: 154, power: 150, buff: true, targetType: 0x10 },
  { id: 2626, name: 'Aura of Swift Killer Other V', school: 'Item', level: 5, category: 154, power: 250, buff: true, targetType: 0x10 },
  { id: 2625, name: 'Aura of Swift Killer Self V', school: 'Item', level: 5, category: 154, power: 250, self: true, buff: true, targetType: 0x10 },
  { id: 1600, name: 'Aura of Defender Other IV', school: 'Item', level: 4, category: 156, power: 200, buff: true, targetType: 0x10 },
  { id: 1484, name: 'Impenetrability IV', school: 'Item', level: 4, category: 160, power: 200, buff: true, targetType: 0x6 },
  { id: 1560, name: 'Blade Bane IV', school: 'Item', level: 4, category: 174, power: 200, buff: true, targetType: 0x6 },
  { id: 1490, name: 'Brittlemail IV', school: 'Item', level: 4, category: 161, power: 200, targetType: 0x6 },
  { id: 27, name: 'Flame Bolt I', school: 'War', level: 1, power: 1, projectile: true },
  { id: 83, name: 'Flame Bolt IV', school: 'War', level: 4, power: 200, projectile: true },
  { id: 6, name: 'Heal Self I', school: 'Life', level: 1, self: true, power: 1 },
];

describe('1–2. spell names as players say them, and item buffs that go on you', () => {
  it('a name is its family, level and Self / Other word ("Aura of" left out)', () => {
    expect(spellNameParts('Aura of Swift Killer Other V')).toEqual({ family: 'swift killer', level: 5, side: 'other' });
    expect(spellNameParts('Swift Killer V')).toEqual({ family: 'swift killer', level: 5, side: null });
    expect(spellNameParts('Impenetrability IV')).toEqual({ family: 'impenetrability', level: 4, side: null });
    expect(spellNameParts('heal self 1')).toEqual({ family: 'heal', level: 1, side: 'self' });
  });

  it('"Swift Killer V" is the Other one at a fellow and the Self one on you; "Defender IV" the only Defender IV', () => {
    expect(matchSpell(SPELLS, 'Swift Killer V', 'other')).toMatchObject({ name: 'Aura of Swift Killer Other V' });
    expect(matchSpell(SPELLS, 'Swift Killer V', 'self')).toMatchObject({ name: 'Aura of Swift Killer Self V' });
    expect(matchSpell(SPELLS, 'Swift Killer V', null)).toMatchObject({ name: 'Aura of Swift Killer Self V' });
    expect(matchSpell(SPELLS, 'Defender IV', 'self')).toMatchObject({ name: 'Aura of Defender Other IV' });
    expect(matchSpell(SPELLS, 'aura of defender other iv', 'other')).toMatchObject({ id: 1600 });
    // An exact name, and the old substring match of one spell, still work.
    expect(matchSpell(SPELLS, 'Impenetrability IV', null)).toMatchObject({ id: 1484 });
    expect(matchSpell(SPELLS, 'heal self', null)).toMatchObject({ id: 6 });
  });

  it('several that fit equally are listed for the caller to name; nothing that fits is null', () => {
    expect(matchSpell(SPELLS, 'Flame Bolt', 'other')).toEqual({ candidates: [SPELLS[7], SPELLS[8]] });
    expect(matchSpell(SPELLS, 'Swift Killer', 'other')).toEqual({ candidates: [SPELLS[0], SPELLS[1]] });
    expect(matchSpell(SPELLS, 'Ring of Fire', 'other')).toBeNull();
  });

  it('an armor-targeted buff lands on your armor (the spell table\'s target type, any era\'s numbering); Brittlemail and weapon auras do not', () => {
    // End of retail / Dark Majesty DATs: Impenetrability IV and Blade Bane IV are Armor | Clothing (0x6), beneficial.
    expect(isArmorRedirectBuff({ buff: true, targetType: 0x6 })).toBe(true);
    expect(isArmorRedirectBuff({ buff: true, targetType: 0x2 })).toBe(true);
    // Brittlemail IV (harmful, 0x6), Aura of Swift Killer Other V (a creature, 0x10), a host that can't say.
    expect(isArmorRedirectBuff({ targetType: 0x6 })).toBe(false);
    expect(isArmorRedirectBuff({ buff: true, targetType: 0x10 })).toBe(false);
    expect(isArmorRedirectBuff({ buff: true })).toBe(false);
  });

  describe.skipIf(!existsSync(DAT_PATHS.portal))('against the end-of-retail spell table (0x0E00000E)', () => {
    let table: SpellTable;
    beforeAll(() => { table = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!)); });
    /** As the game host builds an AgentSpell's buff / targetType (main.ts spells()). */
    const asAgent = (id: number) => { const b = table.spells.get(id)!; return { buff: (b.bitfield & 0x4) !== 0 && (b.duration ?? 0) !== 0, targetType: b.nonComponentTargetType >>> 0 }; };
    it('Impenetrability IV / V and Blade Bane IV go on you; Brittlemail IV, the weapon auras and Strength Other IV do not', () => {
      expect([1484, 1485, 1560].map((id) => isArmorRedirectBuff(asAgent(id)))).toEqual([true, true, true]);
      expect([1490, 6028, 6002, 1335].map((id) => isArmorRedirectBuff(asAgent(id)))).toEqual([false, false, false, false]);
    });
  });

  describe('through ac_cast', () => {
    let host: FakeHost;
    let api: AgentApi;
    beforeEach(() => {
      vi.useFakeTimers();
      host = new FakeHost();
      api = new AgentApi(host);
      host.spells = () => SPELLS;
      host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 82, y: 20 });
      host.cast = (id, t) => {
        host.sent.push(`cast ${id} ${t === null ? 'self' : t.toString(16)}`);
        const s = SPELLS.find((x) => x.id === id)!;
        setTimeout(() => api.pushChat(`You cast ${s.name} on ${t === null ? 'yourself' : 'Claude Bulwark'}`, 0x11), 300);
        return true;
      };
    });
    afterEach(() => vi.useRealTimers());

    it('"Swift Killer V" at Claude Bulwark casts Aura of Swift Killer Other V at him (was "you don\'t know a spell matching")', async () => {
      const r = await settle(api, host, api.cast('Swift Killer V', 'Claude Bulwark'), 5000);
      expect(r?.ok).toBe(true);
      expect(r?.message.split('\n')[0]).toBe('casting Aura of Swift Killer Other V at Claude Bulwark #500000a4');
      expect(host.sent).toContain('cast 2626 500000a4');
    });

    it('a family named without a level casts the highest you can land, saying so (was "fits 2 of your spells: name one")', async () => {
      // Asking which one cost Arcanist a round trip at 26/146 (2026-10-16 19:58:44Z): verify-agent-critical-health.ts.
      const r = await settle(api, host, api.cast('Flame Bolt', 'Claude Bulwark'), 2000);
      expect(r?.message.split('\n')[0]).toBe('casting Flame Bolt IV at Claude Bulwark #500000a4 (no level named: the highest of yours you can land)');
      expect(host.sent.filter((x) => x.startsWith('cast'))).toEqual(['cast ' + SPELLS.find((x) => x.name === 'Flame Bolt IV')!.id + ' 500000a4']);
    });

    it('a name that fits different spells still says which', async () => {
      const r = await settle(api, host, api.cast('IV', null), 2000);
      expect(r?.ok).toBe(false);
      expect(r?.message).toMatch(/^"IV" fits \d+ of your spells: .*Name one/);
      expect(host.sent.filter((x) => x.startsWith('cast'))).toEqual([]);
    });

    it('Impenetrability IV and Blade Bane IV with no target go on you, as Heal Self does; Brittlemail still needs a target', async () => {
      const impen = await settle(api, host, api.cast('Impenetrability IV', null), 5000);
      expect(impen?.message.split('\n')[0]).toBe('casting Impenetrability IV on yourself');
      const bane = await settle(api, host, api.cast('Blade Bane IV', null), 5000);
      expect(bane?.ok).toBe(true);
      expect(host.sent.filter((x) => x.startsWith('cast'))).toEqual(['cast 1484 self', 'cast 1560 self']);
      expect(await api.cast('Brittlemail IV', null)).toEqual({ ok: false, message: 'Brittlemail IV needs a target: pass target= (a creature or player), or "self"' });
    });
  });
});

describe('3. a fizzle says how near the skill is to the spell', () => {
  it('the magic skill curve is ACE SkillCheck.GetMagicSkillChance (factor 0.07)', () => {
    expect(magicSkillChance(250, 250)).toBeCloseTo(0.5, 6);
    expect(magicSkillChance(260, 250)).toBeCloseTo(1 - 1 / (1 + Math.exp(0.7)), 6);
    expect(magicSkillChance(181, 250)).toBeLessThan(0.01);
    expect(schoolSkill('Item')).toEqual({ id: 32, name: 'Item Enchantment' });
    expect(schoolSkill('War')).toEqual({ id: 34, name: 'War Magic' });
    expect(schoolSkill('Void')).toEqual({ id: 43, name: 'Void Magic' });
  });

  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.spells = () => SPELLS;
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 82, y: 20 });
    host.cast = (id, t) => { host.sent.push(`cast ${id} ${t?.toString(16)}`); setTimeout(() => api.pushChat('Your spell fizzled.', 0x11), 300); return true; };
  });
  afterEach(() => vi.useRealTimers());

  it('Swift Killer V at Item Enchantment 181 (buffed): difficulty 250, under 1%, and below ACE\'s floor', async () => {
    host.skills.set(32, { base: 170, buffed: 181 });
    const r = await settle(api, host, api.cast('Swift Killer V', 'Claude Bulwark'), 5000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toBe([
      'casting Aura of Swift Killer Other V at Claude Bulwark #500000a4',
      '  Your spell fizzled.',
      '  your Item Enchantment is 181 against its difficulty 250: under 1% of casts get past the skill roll (ACE servers let none land that far under: 200 at least): raise Item Enchantment (ac_raise), buff it (a Item Enchantment Mastery self spell), or cast a lower level',
    ].join('\n'));
  });

  it('at 245 against 250 it says the odds (about 41%)', async () => {
    host.skills.set(32, { base: 240, buffed: 245 });
    const r = await settle(api, host, api.cast('Swift Killer V', 'Claude Bulwark'), 5000);
    expect(r?.message).toContain('your Item Enchantment is 245 against its difficulty 250: about 41% of casts get past the skill roll: raise');
  });

  it('no skill known to the host: the fizzle alone, as before', async () => {
    const r = await settle(api, host, api.cast('Swift Killer V', 'Claude Bulwark'), 5000);
    expect(r?.message).toBe('casting Aura of Swift Killer Other V at Claude Bulwark #500000a4\n  Your spell fizzled.');
  });
});

describe('4. a use during a swing breaks the attack off first (the client\'s Cancel Attack)', () => {
  let host: FakeHost;
  let api: AgentApi;
  let swinging: boolean;
  const KIT = 0x8000fa17;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    swinging = true;
    host.attacking = () => swinging;
    host.inv = [{ guid: KIT, name: 'Adept Healing Kit', where: 'main pack', stack: 1 }];
    host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 20 });
  });
  afterEach(() => vi.useRealTimers());

  it('the healing kit on Arcanist: Cancel Attack, the swing\'s AttackDone, then the use, and the reply says so', async () => {
    host.cancelAttack = () => { host.sent.push('cancel'); setTimeout(() => { swinging = false; }, 1200); };
    host.useWithTarget = (s, t) => {
      if (swinging) { api.pushChat('You cannot move or use an item while attacking', 0x1a); return false; }
      host.sent.push(`usewith ${s.toString(16)} ${t.toString(16)}`);
      setTimeout(() => api.pushChat('You heal Claude Arcanist for 40 Health points. Your Adept Healing Kit has 23 uses left.', 0x0), 400);
      return true;
    };
    const r = await settle(api, host, api.useOnReported('Adept Healing Kit', 'Claude Arcanist'), 10_000);
    expect(host.sent).toEqual(['cancel', `usewith ${KIT.toString(16)} ${ARCANIST.toString(16)}`]);
    expect(r?.ok).toBe(true);
    expect(r?.message).toBe([
      'used Adept Healing Kit on Claude Arcanist:',
      '  You heal Claude Arcanist for 40 Health points. Your Adept Healing Kit has 23 uses left.',
      '  (broke off your attack first: the client takes no use or item move while a swing is in progress, as retail\'s ("You cannot move or use an item while attacking"); ac_attack to go back to it)',
    ].join('\n'));
  });

  it('a swing that never ends refuses the use with why, and nothing is sent', async () => {
    const r = await settle(api, host, api.useOnReported('Adept Healing Kit', 'Claude Arcanist'), 10_000);
    expect(r).toEqual({ ok: false, message: 'Adept Healing Kit not used on Claude Arcanist: your swing is still going 4 s after breaking the attack off, and the client takes no use while it is: try again in a moment' });
    expect(host.sent).toEqual(['cancel']);
  });

  it('a send the client refuses says so with its line (was "use-with refused", or "used" with the refusal under it)', async () => {
    swinging = false;
    host.useWithTarget = () => { api.pushChat('You can only move or use one item at a time', 0x1a); return false; };
    const r = await settle(api, host, api.useOnReported('Adept Healing Kit', 'Claude Arcanist'), 5000);
    expect(r).toEqual({ ok: false, message: 'Adept Healing Kit not used on Claude Arcanist: your client refused to send it (You can only move or use one item at a time)' });
  });

  it('a give and a drop break it off too; nothing swinging: no cancel', async () => {
    host.cancelAttack = () => { host.sent.push('cancel'); setTimeout(() => { swinging = false; }, 500); };
    host.drop = (g) => { host.sent.push(`drop ${g.toString(16)}`); host.inv = []; return true; };
    const d = await settle(api, host, api.drop('Adept Healing Kit'), 10_000);
    expect(d?.ok).toBe(true);
    expect(d?.message).toBe('dropped Adept Healing Kit\n  (broke off your attack first: the client takes no use or item move while a swing is in progress, as retail\'s ("You cannot move or use an item while attacking"); ac_attack to go back to it)');
    expect(host.sent).toEqual(['cancel', `drop ${KIT.toString(16)}`]);
    host.inv = [{ guid: KIT, name: 'Adept Healing Kit', where: 'main pack', stack: 1 }];
    host.sent = [];
    host.give = (t, i, n) => { host.sent.push(`give ${i.toString(16)} to ${t.toString(16)} x${n}`); setTimeout(() => { host.inv = []; api.pushChat('You give Claude Arcanist Adept Healing Kit.', 0x0); }, 300); return true; };
    const g = await settle(api, host, api.give('Adept Healing Kit', 'Claude Arcanist', null), 30_000);
    expect(g?.ok).toBe(true);
    expect(host.sent).toEqual([`give ${KIT.toString(16)} to ${ARCANIST.toString(16)} x1`]);
  });
});

describe('5. a target left behind by a portal', () => {
  let host: FakeHost;
  let api: AgentApi;
  const DOLL = 0x8000f451;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.spells = () => SPELLS;
    host.cellSealed = (c) => (c & 0xffff) >= 0x100;
    // Bulwark in Hollow Lair; the doll he had selected is in the doll dungeon 0x0290.
    host.me.cell = 0x039c019c;
    host.add({ guid: DOLL, name: 'Broken Doll', itemType: 0x10, objectDescFlags: 0x10, cell: 0x029002e6, x: 60, y: 40, z: -12 });
    host.target = DOLL;
  });
  afterEach(() => vi.useRealTimers());

  it('observe says none, naming what was left behind (was "Broken Doll … 36210.2m ahead-right")', () => {
    const o = api.observe();
    expect(o.target).toBeNull();
    expect(o.targetLeftBehind).toBe('Broken Doll #8000f451');
    expect(formatObservation(o).split('\n').find((l) => l.startsWith('target:'))).toBe('target: none (your last target, Broken Doll #8000f451, was left behind in another place: you went through a portal or far away since; pick a new one)');
  });

  it('a cast or an attack with no target named does not go at it', async () => {
    expect(await api.cast('Flame Bolt IV', null)).toEqual({ ok: false, message: 'Flame Bolt IV needs a target: pass target= (a creature or player), or "self"' });
    expect(api.attack(null)).toEqual({ ok: false, message: 'no target selected and no monster nearby' });
  });

  it('one in the same dungeon is still the target', () => {
    host.add({ guid: DOLL, name: 'Broken Doll', itemType: 0x10, objectDescFlags: 0x10, cell: 0x039c019b, x: host.me.x + 5, y: host.me.y, z: host.me.z });
    expect(api.observe().target?.name).toBe('Broken Doll');
  });

  it('the client\'s selection range check: another dungeon, or the landscape seen from one, is another space', () => {
    const sealed = (c: number) => (c & 0xffff) >= 0x100;
    expect(inAnotherSpace(0x029002e6, 0x039c019c, sealed)).toBe(true);
    expect(inAnotherSpace(0xa9b40019, 0x039c019c, sealed)).toBe(true);
    expect(inAnotherSpace(0x039c019b, 0x039c019c, sealed)).toBe(false);
    // Neighbouring landscape landblocks (and a surface building's SeenOutside cell) are one world.
    expect(inAnotherSpace(0xa9b30039, 0xa9b40019, sealed)).toBe(false);
    expect(inAnotherSpace(0xa9b30105, 0xa9b40019, () => false)).toBe(false);
    expect(inAnotherSpace(null, 0xa9b40019, sealed)).toBe(false);
  });
});

describe('6. a portal that took you during the walk to it is a use that worked', () => {
  let host: FakeHost;
  let api: AgentApi;
  const PORTAL = 0x7a9b4080;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.add({ guid: PORTAL, name: 'Portal to Town Network', itemType: 0x10000, objectDescFlags: 0x40000, x: 80, y: 30 });
    // A wall between: the use walks there itself (straightStopsShort), as on the stream.
    host.wall = (_x, y) => y > 24 && y < 25.5;
  });
  afterEach(() => vi.useRealTimers());

  it('used again after the walk up to it already went in: "it already took you" (was "outside this dungeon … No walk gets there")', async () => {
    host.cellSealed = (c) => (c & 0xffff) >= 0x100;
    // The walk_to before stepped into it: portal space, then the Town Network.
    host.screenName = 'portal-space';
    run(api, host, 500);
    host.me.cell = 0x00070143; host.me.x = 60; host.me.y = 60;
    host.screenName = 'world';
    run(api, host, 2500);
    const r = await settle(api, host, api.use('Portal to Town Network'), 10_000);
    expect(r).toEqual({ ok: true, message: 'used Portal to Town Network: it already took you through 2 s ago (on the way to it): you are now indoors (cell 0x00070143), and Portal to Town Network is back where you were' });
    expect(host.sent.filter((x) => x.startsWith('use'))).toEqual([]);
  });

  it('long after the last portal, a portal in another place is still "no walk gets there"', async () => {
    host.cellSealed = (c) => (c & 0xffff) >= 0x100;
    host.me.cell = 0x00070143;
    const r = await settle(api, host, api.use('Portal to Town Network'), 10_000);
    expect(r?.ok).toBe(false);
  });

  it('in portal space at the end: success, and the arrival to wait for', async () => {
    const r = await settle(api, host, api.use('Portal to Town Network'), 60_000, () => {
      if (host.t === 1500) host.screenName = 'portal-space';
    });
    expect(r?.ok).toBe(true);
    expect(r?.message).toMatch(/^used Portal to Town Network: /);
  });
});

describe('7. item= and target= alike for the one-object tools', () => {
  const calls: Array<[string, unknown[]]> = [];
  const caller: ToolCaller = { notice: null, call: async <T,>(method: string, args?: unknown[]) => { calls.push([method, args ?? []]); return { ok: true, message: `${method} done` } as T; } };
  beforeEach(() => { calls.length = 0; });

  it('pick_up target=#8000f95f is item= (was: unknown argument "target")', async () => {
    const tool = TOOL_BY_NAME.get('ac_pick_up')!;
    const args = parseCliArgs(tool, ['target=#8000f95f']);
    expect(missingRequired(tool, args)).toBeNull();
    const r = await TOOL_CALLER.run(caller, () => tool.run(args));
    expect(r.text).toBe('pickUp done');
    expect(calls).toEqual([['pickUp', [0x8000f95f]]]);
  });

  it('appraise / use / loot take item= for target=, equip / drop take target= for item=; the real name wins', async () => {
    expect(withArgAliases(TOOL_BY_NAME.get('ac_appraise')!, { item: 'Gold Ring' })).toEqual({ target: 'Gold Ring' });
    expect(withArgAliases(TOOL_BY_NAME.get('ac_equip')!, { target: 'Bracelet', slot: 'left wrist' })).toEqual({ item: 'Bracelet', slot: 'left wrist' });
    expect(withArgAliases(TOOL_BY_NAME.get('ac_drop')!, { item: 'A', target: 'B' })).toEqual({ item: 'A' });
    await TOOL_CALLER.run(caller, () => TOOL_BY_NAME.get('ac_use')!.run({ item: 'Lytelthorpe Portal' }));
    await TOOL_CALLER.run(caller, () => TOOL_BY_NAME.get('ac_loot')!.run({ item: '#8000aaaa' }));
    expect(calls).toEqual([['use', ['Lytelthorpe Portal']], ['loot', [0x8000aaaa, null]]]);
  });

  it('give and use_on name two things (item= what, target= whom): no aliases there', () => {
    expect(argAliases(TOOL_BY_NAME.get('ac_give')!)).toEqual({});
    expect(argAliases(TOOL_BY_NAME.get('ac_use_on')!)).toEqual({});
    expect(missingRequired(TOOL_BY_NAME.get('ac_give')!, { target: 'Claude Arcanist' })).toBe('ac_give: missing item (usage: give item=… target=… [amount=…])');
  });

  it('over MCP: the schema lists the alias and leaves the requirement to either name; target= alone goes through', async () => {
    const tool = TOOL_BY_NAME.get('ac_pick_up')!;
    const schema = inputSchema(tool) as { properties: Record<string, unknown>; required: string[] };
    expect(Object.keys(schema.properties)).toEqual(expect.arrayContaining(['item', 'target']));
    expect(schema.required).toEqual([]);
    const r = await TOOL_CALLER.run(caller, () => handle({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'ac_pick_up', arguments: { target: '#8000f95f' } } }, { hosted: true })) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(r.result.isError).toBeUndefined();
    expect(calls).toEqual([['pickUp', [0x8000f95f]]]);
    const none = await handle({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'ac_pick_up', arguments: {} } }) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    expect(none.result.content[0].text).toBe('ac_pick_up: missing item (usage: pick_up item=…)');
  });
});

describe('8. inventory filter=', () => {
  const ITEMS: AgentItem[] = [
    { guid: 0x80000001, name: 'Handy Healing Kit', where: 'main pack', type: 'Misc', itemType: 0x80, value: 60 },
    { guid: 0x80000002, name: 'Potion of Healing', where: 'main pack', stack: 8, type: 'Food', itemType: 0x20 },
    { guid: 0x80000003, name: 'Scroll of Heal Other IV', where: 'Sack', inside: 0x80000009, type: 'Writable', itemType: 0x2000 },
    { guid: 0x80000004, name: 'Lugian Hammer', where: 'main pack', type: 'Melee Weapon', itemType: 0x1 },
    { guid: 0x80000005, name: 'Salvaged Iron', where: 'main pack', type: 'Tinkering Material', itemType: 0x40000000 },
    { guid: 0x80000006, name: 'Chainmail Shirt', where: 'equipped', slot: 'chest', type: 'Armor', itemType: 0x2 },
    { guid: 0x80000007, name: 'Bread', where: 'main pack', type: 'Food', itemType: 0x20 },
  ];
  const calls: string[] = [];
  const caller: ToolCaller = { notice: null, call: async <T,>(method: string) => { calls.push(method); return ITEMS as T; } };

  it('kinds and names', () => {
    expect(filterInventory(ITEMS, 'potion').items.map((i) => i.name)).toEqual(['Potion of Healing']);
    expect(filterInventory(ITEMS, 'kits').items.map((i) => i.name)).toEqual(['Handy Healing Kit']);
    expect(filterInventory(ITEMS, 'scroll').items.map((i) => i.name)).toEqual(['Scroll of Heal Other IV']);
    expect(filterInventory(ITEMS, 'weapon').items.map((i) => i.name)).toEqual(['Lugian Hammer']);
    expect(filterInventory(ITEMS, 'salvage').items.map((i) => i.name)).toEqual(['Salvaged Iron']);
    expect(filterInventory(ITEMS, 'food').items.map((i) => i.name)).toEqual(['Bread']);
    expect(filterInventory(ITEMS, 'armor').items.map((i) => i.name)).toEqual(['Chainmail Shirt']);
    expect(filterInventory(ITEMS, 'Healing')).toEqual({ items: [ITEMS[0], ITEMS[1]], kind: null });
  });

  it('through ac_inventory: the matching items with where each is; no filter is the full listing as before', async () => {
    const tool = TOOL_BY_NAME.get('ac_inventory')!;
    const f = await TOOL_CALLER.run(caller, () => tool.run(parseCliArgs(tool, ['filter=potion'])));
    expect(f.text).toBe('1 potion items:\n  #80000002 Potion of Healing  (in main pack, x8, Food)');
    const n = await TOOL_CALLER.run(caller, () => tool.run(parseCliArgs(tool, ['filter=Revitalize'])));
    expect(n.text).toMatch(/^no items named like "Revitalize" in your inventory \(kinds: weapon, armor/);
    const all = await TOOL_CALLER.run(caller, () => tool.run({}));
    expect(all.text).toBe(formatInventory(ITEMS));
    expect(formatInventoryFiltered(ITEMS, 'worn')).toBe('1 worn items:\n  #80000006 Chainmail Shirt  (worn: chest, Armor)');
  });
});

describe('9. give: the server\'s "You give" is the answer; a failure far off says how far', () => {
  let host: FakeHost;
  let api: AgentApi;
  const NOTE = 0x8000d1a5;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80.8, y: 20 });
  });
  afterEach(() => vi.useRealTimers());

  it('one Trade Note out of a stack of two: "You give …" before the pack updates is a give (was "did not get")', async () => {
    host.inv = [{ guid: NOTE, name: 'Trade Note (10,000)', where: 'main pack', stack: 2 }];
    host.give = () => { setTimeout(() => api.pushChat('You give Claude Arcanist Trade Note (10,000).', 0x0), 5000); return true; };
    const r = await settle(api, host, api.give(NOTE, 'Claude Arcanist', 1), 30_000);
    expect(r).toEqual({ ok: true, message: 'gave 1 Trade Note (10,000) to Claude Arcanist\n  You give Claude Arcanist Trade Note (10,000).' });
  });

  it('no answer with the recipient 26 m off by then: the distance and what to do', async () => {
    host.inv = [{ guid: NOTE, name: 'Trade Note (10,000)', where: 'main pack', stack: 1 }];
    host.give = () => { const a = host.objs.get(ARCANIST)!; a.x = host.me.x + 26; a.y = host.me.y; return true; };
    const r = await settle(api, host, api.give(NOTE, 'Claude Arcanist', null), 40_000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toBe([
      'Claude Arcanist did not get your Trade Note (10,000) (no answer from the server in 17 s, and it is still in your pack: ac_inventory in a moment shows whether it went)',
      '  (you are 26.0 m from Claude Arcanist: too far for the give; the server\'s walk there didn\'t get you beside them. ac_walk_to Claude Arcanist, then give again)',
    ].join('\n'));
  });
});

