/**
 * AGENT.stream-reports-2026-10-18-0615: the AI stream pair's 05:13–06:16Z segment in Aerbax Laboratory (0x029E) and
 * Aerbax Haven (0x029F), 2026-10-18, build 18602148 (reports stream/reports/{mage-2026-10-18T06-15-46-192Z,
 * soldier-2026-10-18T06-15-04-832Z}-seg1.md; transcripts stream/sessions/{mage,soldier}-2026-10-18-seg1.jsonl; page logs
 * mage.log / soldier.log):
 * 1. "Arcanist fights" let Aura of Hermetic Link Self V and Aura of Spirit Drinker Self V run out (05:45Z) while it
 *    recast his other buffs: the page's worn rows carry `slot: 'Held'` and the ItemType bits, no `type` label, and the
 *    macro found the wielded weapon by /weapon|wand|staff|orb|caster/ on that text, so a worn wand was no weapon and the
 *    caster auras were never wanted (the tests' fakes gave the wand `type: 'Caster'`).
 * 2. "Dark Marionette grazes your foot" went to the Marionette #80007e9b in sight (the line holds its name), and the Dark
 *    Marionette hitting through the wall of 0x029E0112 read "hit by, but not placed": now named where it is.
 * 3. "Invulnerability Self" came up IV: he knows IV and VI (not V), and VI at Creature Enchantment 255 against its 250 is
 *    59%, under the 75% a cast with no level asks. The reply now names the higher one passed over and its numbers.
 * 4. Bulwark's use of Surface 0.8 s after he arrived answered only "You resist the spell cast by Marionette"; the
 *    portal's "You have been teleported too recently!" (ACE Portal.minTimeSinceLastPortal 3.5 s) came on the way to it.
 * 5. One Frost Bolt crit raised vitals-low twice ([1761] "below 60%", [1762] "fell 187 → 107 at once").
 * 6. Attack run-ups and walks past Aerbax Haven #7029e002: each bend near it is reported (914c301d), and a run-up that
 *    went through a portal anyway ends there, not with an answer measured from the far side.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getClientRunRate } from '@ac/shared';
import type { RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { weaponKind, wieldedWeapon } from '../packages/renderer/src/agent/macro/wieldedWeapon.ts';
import type { AgentItem, AgentResult } from '../packages/renderer/src/agent/types.ts';
import { routineFromFile } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { DAT_PATHS, openDat } from './_harness/dat.ts';

const REPO = resolve(__dirname, '..');
const ready = (profile: 'mage' | 'soldier'): RoutineProfile => {
  const r = routineFromFile(join(REPO, 'tools', 'stream', 'routines', `${profile}.json`));
  if ('text' in r) throw new Error(r.text);
  return r.profile;
};
const step = async (api: AgentApi, host: FakeHost, ms: number, each?: () => void): Promise<void> => {
  for (let t = 0; t < ms; t += 100) { each?.(); run(api, host, 100); await vi.advanceTimersByTimeAsync(0); }
};
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); for (let k = 0; k < 5; k++) await Promise.resolve(); }
  return out;
}
type Table = { spells: Map<number, { name: string; desc: string; category: number; school: number; bitfield: number; power: number; duration?: number; nonComponentTargetType?: number }> };
const SCHOOLS: Record<number, string> = { 1: 'War', 2: 'Life', 3: 'Item', 4: 'Creature', 5: 'Void' };
const haveDat = existsSync(DAT_PATHS.cell) && existsSync(DAT_PATHS.portal);

// The page's own rows for worn gear (main.ts inventory): EquipMask slot names and the ItemType bits.
const HELD = 0x01000000;
const WAND: AgentItem = { guid: 0x8000b535, name: 'Wand', where: 'equipped', slot: 'Held', mask: HELD, validLocations: HELD, itemType: 0x8000 };

describe('1a. the wielded weapon by its numbers (no DAT)', () => {
  it('a worn wand as the page lists it (slot "Held", ItemType Caster, no type label) is a caster', () => {
    expect(weaponKind(WAND)).toBe('caster');
    expect(wieldedWeapon([WAND])?.item.guid).toBe(WAND.guid);
    // An orb with only its mask, and one with only its ItemType.
    expect(weaponKind({ guid: 1, name: 'Orb', where: 'equipped', mask: HELD })).toBe('caster');
    expect(weaponKind({ guid: 2, name: 'Staff', where: 'equipped', slot: 'Held', itemType: 0x8000 })).toBe('caster');
  });
  it('melee, two-handed and missile weapons by slot and type; ammunition, shields and armor are none', () => {
    expect(weaponKind({ guid: 3, name: 'Mace', where: 'equipped', slot: 'MeleeWeapon', mask: 0x00100000, itemType: 0x1 })).toBe('melee');
    expect(weaponKind({ guid: 4, name: 'Greataxe', where: 'equipped', slot: 'TwoHanded', mask: 0x02000000, itemType: 0x1 })).toBe('melee');
    expect(weaponKind({ guid: 5, name: 'Yumi', where: 'equipped', slot: 'MissileWeapon', mask: 0x00400000, itemType: 0x100 })).toBe('missile');
    expect(weaponKind({ guid: 6, name: 'Arrow', where: 'equipped', slot: 'MissileAmmo', mask: 0x00800000, itemType: 0x100 })).toBeNull();
    expect(weaponKind({ guid: 7, name: 'Kite Shield', where: 'equipped', slot: 'Shield', mask: 0x00200000, itemType: 0x2 })).toBeNull();
    expect(weaponKind({ guid: 8, name: 'Platemail Breastplate', where: 'equipped', slot: 'ChestArmor', mask: 0x200, itemType: 0x2 })).toBeNull();
    // The old fakes' shape still reads the same.
    expect(weaponKind({ guid: 9, name: 'Fire Wand', where: 'equipped', type: 'Caster', slot: 'Held', itemType: 0x8000 })).toBe('caster');
    // A pack item is never the wielded one.
    expect(wieldedWeapon([{ ...WAND, where: 'main pack' }])).toBeNull();
  });
});

describe.skipIf(!existsSync(DAT_PATHS.portal))('1b/3. Arcanist on the real end-of-retail spell table (needs DAT files)', () => {
  let table: Table;
  const id = (name: string): number => { const e = [...table.spells].find(([, s]) => s.name === name); if (!e) throw new Error(`no spell ${name}`); return e[0]; };
  beforeAll(async () => {
    const { SpellTable } = await import('../packages/dat-parser/src/file-types/SpellTable.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    table = new SpellTable(new DatReader(openDat(DAT_PATHS.portal).getFileData(0x0e00000e)!)) as unknown as Table;
  });

  let host: FakeHost;
  let api: AgentApi;
  const know = (names: string[]) => {
    const ids = names.map(id);
    host.spells = () => ids.map((k) => {
      const s = table.spells.get(k)!;
      return { id: k, name: s.name, school: SCHOOLS[s.school] ?? '', level: 1, category: s.category, power: s.power, duration: s.duration ?? 0, ...(s.nonComponentTargetType !== undefined ? { targetType: s.nonComponentTargetType >>> 0 } : {}), ...((s.bitfield & 0x8) ? { self: true } : {}), ...((s.bitfield & 0x4) && (s.duration ?? 0) !== 0 ? { buff: true } : {}) };
    });
  };
  // His skills at 05:14Z: the magic schools at 255 buffed (base 217, +20 from the Mastery buffs).
  const SKILLS = [
    { id: 33, name: 'Life Magic', training: 'trained', base: 217, buffed: 255 },
    { id: 34, name: 'War Magic', training: 'specialized', base: 268, buffed: 316 },
    { id: 31, name: 'Creature Enchantment', training: 'trained', base: 217, buffed: 255 },
    { id: 32, name: 'Item Enchantment', training: 'trained', base: 217, buffed: 255 },
  ];
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.name = 'Claude Arcanist';
    host.me.level = 50;
    (host as unknown as { spellTableData: () => Table }).spellTableData = () => table;
    (host as unknown as { skillList: () => unknown[] }).skillList = () => SKILLS;
    for (const s of SKILLS) host.skills.set(s.id, { base: s.base, buffed: s.buffed });
    host.me.combatMode = 'magic';
    host.me.health = { current: 183, max: 183 };
    host.me.mana = { current: 329, max: 329 };
    // Worn as the page lists it: no type labels.
    host.inv = [WAND, { guid: 0x80001100, name: 'Platemail Breastplate', where: 'equipped', slot: 'ChestArmor', mask: 0x200, itemType: 0x2 }];
    api = new AgentApi(host);
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); vi.restoreAllMocks(); });

  it('1. the routine recasts both caster auras under RebuffTimeRemainingSeconds, the wand being "Held" with no type label', async () => {
    know(['Aura of Hermetic Link Self V', 'Aura of Spirit Drinker Self V']);
    const HL = id('Aura of Hermetic Link Self V'), SD = id('Aura of Spirit Drinker Self V');
    // 05:43:47Z: 1m21s and 1m17s left (his RebuffTimeRemainingSeconds is 120).
    host.buffs = [
      { spellId: HL, name: 'Aura of Hermetic Link Self V', remaining: 81, beneficial: true },
      { spellId: SD, name: 'Aura of Spirit Drinker Self V', remaining: 77, beneficial: true },
    ];
    // The server lands each cast: the line, and the enchantment's clock back up.
    host.cast = (spell: number, t: number | null) => {
      host.sent.push(`cast ${spell} ${t === null ? 'self' : t.toString(16)}`);
      const s = table.spells.get(spell)!;
      setTimeout(() => {
        api.pushChat(`You cast ${s.name} on yourself, refreshing ${s.name}`, 0x07);
        host.buffs = host.buffs.map((b) => (b.spellId === spell ? { ...b, remaining: 1800 } : b));
      }, 1500);
      return true;
    };
    api.routine.start(ready('mage'));
    await step(api, host, 15_000);
    const casts = host.sent.filter((x) => x.startsWith('cast '));
    expect(casts, `${host.sent.join('\n')}\n${api.routine.history().join('\n')}`).toContain(`cast ${HL} self`);
    expect(casts).toContain(`cast ${SD} self`);
    // Each once: up again after it landed.
    expect(casts.filter((c) => c === `cast ${HL} self`)).toHaveLength(1);
    expect(api.routine.history().join('\n')).toMatch(/buff: weapon aura manaConversion/);
    expect(api.routine.history().join('\n')).toMatch(/buff: weapon aura elemental/);
  });

  it('3. "Invulnerability Self" knowing IV and VI: IV, and the reply names VI at 59% (255 against its 250)', async () => {
    know(['Invulnerability Self IV', 'Invulnerability Self VI']);
    const p = api.cast('Invulnerability Self', null);
    let out: AgentResult | null = null;
    void p.then((x) => { out = x; });
    for (let i = 0; i < 30 && !host.sent.some((s) => s.startsWith('cast ')); i++) { run(api, host, 100); for (let k = 0; k < 5; k++) await Promise.resolve(); }
    expect(host.sent).toContain(`cast ${id('Invulnerability Self IV')} self`);
    api.pushChat('You cast Invulnerability Self IV on yourself', 0x07);
    for (let i = 0; i < 30 && !out; i++) { run(api, host, 200); for (let k = 0; k < 5; k++) await Promise.resolve(); }
    const r = out as AgentResult | null;
    expect(r?.message.split('\n')[0]).toBe('casting Invulnerability Self IV on yourself (no level named: the highest of yours you can land, 100% to land; Invulnerability Self VI is higher but 59% to land (your Creature Enchantment 255 against its 250): name it to try it)');
  });

  it('3. with vitae on you the passed-over level says so', async () => {
    know(['Invulnerability Self IV', 'Invulnerability Self VI']);
    host.vitae = () => ({ multiplier: 0.95, cpPool: 0, deathLevel: 50 });
    host.skills.set(31, { base: 217, buffed: 242 });
    void api.cast('Invulnerability Self', null);
    for (let i = 0; i < 30 && !host.sent.some((s) => s.startsWith('cast ')); i++) { run(api, host, 100); for (let k = 0; k < 5; k++) await Promise.resolve(); }
    const note = (api as unknown as { spellPickNote: Map<number, string> }).spellPickNote.get(id('Invulnerability Self IV'));
    expect(note).toMatch(/Invulnerability Self VI is higher but \d+% to land \(your Creature Enchantment 242 against its 250, with vitae \(−5%\) on you\): name it to try it$/);
  });
});

describe('2. an attacker you can\'t see is named, with the server\'s last placement (no DAT)', () => {
  const CELL = 0x029e0112, OTHER = 0x029e0113;
  const MARIONETTE = 0x80007e9b, DARK = 0x80007f01;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, cell: CELL, x: 50, y: -620, z: -18, level: 50, health: { current: 183, max: 183 } };
    // The client shows creatures only in the cells yours can see: 0x029E0113 is not one of 0x029E0112's.
    (host as unknown as { cellSees: (a: number, b: number) => boolean }).cellSees = (_a, b) => b >>> 0 !== OTHER;
    host.add({ guid: MARIONETTE, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, cell: CELL, x: 50.5, y: -621.3, z: -18, level: 26 });
    host.add({ guid: DARK, name: 'Dark Marionette', itemType: 0x10, objectDescFlags: 0x10, cell: OTHER, x: 50, y: -626, z: -18, level: 35 });
    api = new AgentApi(host);
    run(api, host, 200, { physics: false });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('"Dark Marionette grazes your …" is not the Marionette beside you; observe says where the Dark Marionette is', () => {
    api.pushChat('Critical hit! Dark Marionette grazes your foot for 5 points of bludgeoning damage!', 0x15);
    api.pushChat('Dark Marionette chills you for 38 points with Frost Bolt III.', 0x15);
    const obs = api.observe();
    expect(obs.nearby.find((o) => o.guid === MARIONETTE)?.attackingYou).toBeUndefined();
    expect(obs.attackersUnplaced).toEqual([{ name: 'Dark Marionette', count: 2, unseen: { dist: 6, bearing: 180, dz: 0 } }]);
    const text = formatObservation(obs);
    expect(text).toContain("hit by a Dark Marionette you can't see (2× in 10 s): it's in a room out of your sight, 6 m S by the server's last placement. Its melee reaches through a wall or shut door (the server checks distance only); its bolts need a clear line from it, so they come through an opening into its room.");
    expect(text).not.toMatch(/but not placed/);
    // The aggro event says it once, plainly.
    const ups = api.eventsSince(0).filter((e) => e.type === 'attackers-up');
    expect(ups.map((e) => e.text)).toEqual([expect.stringMatching(/^hit by a Dark Marionette you can't see \(1× in 10 s\): it's in a room out of your sight, 6 m S by the server's last placement\./)]);
  });

  it('the Marionette\'s own lines still go to it, and "You evaded Dark Marionette!" / its spell to the unseen one', () => {
    api.pushChat('Marionette grazes your chest for 2 points of bludgeoning damage!', 0x15);
    api.pushChat('You evaded Dark Marionette!', 0x15);
    api.pushChat('You resist the spell cast by Dark Marionette', 0x15);
    const obs = api.observe();
    expect(obs.nearby.find((o) => o.guid === MARIONETTE)?.attackingYou).toBe(1);
    expect(obs.attackersUnplaced?.map((u) => [u.name, u.count])).toEqual([['Dark Marionette', 2]]);
  });

  it('none of its name known anywhere: said so', () => {
    host.objs.delete(DARK);
    api.pushChat('Dark Marionette grazes your hand for 1 point of bludgeoning damage!', 0x15);
    expect(formatObservation(api.observe())).toContain("hit by a Dark Marionette you can't see (1× in 10 s): none of that name is in sight within reach of you, and your client knows of none in the rooms out of your sight.");
  });
});

describe('4. a portal\'s refusal is the use\'s answer (no DAT)', () => {
  const SURFACE = 0x7029f017;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me = { ...host.me, cell: 0x029f017e, x: 20, y: -400, z: 0, level: 48, combatMode: 'melee' };
    host.add({ guid: SURFACE, name: 'Surface', itemType: 0x10000, objectDescFlags: 0x40000, cell: 0x029f017e, x: 20, y: -400.6, z: 0 });
    api = new AgentApi(host);
    run(api, host, 200);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const arrive = (): void => {
    host.screenName = 'portal-space';
    run(api, host, 200);
    host.screenName = 'world';
    run(api, host, 100);
  };

  it('just out of a portal, the use waits out the 3.5 s before it is sent (Bulwark used Surface 0.8 s after arriving)', async () => {
    arrive();
    const t0 = host.t;
    let sentAt: number | null = null;
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); sentAt ??= host.t; setTimeout(() => { host.screenName = 'portal-space'; }, 300); return true; };
    const r = await settle(api, host, api.use(SURFACE), 20_000);
    expect(sentAt, JSON.stringify(r)).not.toBeNull();
    expect(sentAt! - t0).toBeGreaterThanOrEqual(3400);
    expect(r?.ok).toBe(true);
  });

  it('refused all the same: "You have been teleported too recently!" is the answer, a resist meanwhile is not', async () => {
    // An old refusal (before this use began) is not this use's answer.
    api.pushChat('You have been teleported too recently!', 0x07);
    api.pushWeenieError(0x04a7);
    run(api, host, 5000);
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); setTimeout(() => { host.screenName = 'portal-space'; }, 300); return true; };
    const r = await settle(api, host, api.use(SURFACE), 20_000);
    expect(r?.message).not.toMatch(/teleported too recently/);
    host.screenName = 'world';
    run(api, host, 5000);

    // Now the refusal during the use (the walk-in's touch): it is named, with the cooldown.
    host.use = (g: number) => {
      host.sent.push(`use ${g.toString(16)}`);
      api.pushChat('You have been teleported too recently!', 0x07);
      api.pushWeenieError(0x04a7);
      api.pushChat('You resist the spell cast by Marionette', 0x15);
      return true;
    };
    arrive();
    run(api, host, 4000);
    const t1 = host.t;
    const r2 = await settle(api, host, api.use(SURFACE), 20_000);
    expect(r2?.ok).toBe(false);
    expect(r2?.message).toMatch(/the server refused it: You have been teleported too recently! \(Surface; WeenieError YouHaveBeenTeleportedTooRecently\): a portal takes you only 3\.5 s after you came out of the last one \(ACE Portal\.minTimeSinceLastPortal\); you arrived \d+\.\d s before it refused; it takes you now: use it again/);
    // Answered at once, not after the 10 s wait for a reply.
    expect(host.t - t1).toBeLessThan(3000);
  });
});

describe('5. one hit, one vitals-low (no DAT)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host = new FakeHost();
    host.me.health = { current: 187, max: 187 };
    api = new AgentApi(host);
    run(api, host, 300, { physics: false });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
  const lows = (): string[] => api.eventsSince(0).filter((e) => e.type === 'vitals-low').map((e) => e.text);

  it('a Frost Bolt crit 187 → 107 (57%): one event saying both the hit and the 60% line (was [1761] and [1762])', async () => {
    const w = api.wait({ types: ['vitals-low'], healthBelow: 0.5 }, 5000);
    host.me.health.current = 107;
    run(api, host, 300, { physics: false });
    expect(lows()).toEqual(['health fell 187 → 107 of 187 at once (−43% of your health in one hit): 107/187 (57%), below 60%']);
    expect((await w).map((e) => e.text)).toEqual(lows());
  });

  it('down past the critical line in one hit: the critical alarm says the hit too; a wait\'s own mark adds none beside it', async () => {
    const w = api.wait({ types: ['vitals-low'], healthBelow: 0.5 }, 5000);
    host.me.health.current = 60;
    run(api, host, 300, { physics: false });
    expect(lows()).toEqual([expect.stringMatching(/^health 60\/187 \(32%\): CRITICAL, below 40% \(it fell 187 → 60 of 187 at once \(−68% of your health in one hit\)\)\. Heal now .* this wakes every wait$/)]);
    expect(await w).toHaveLength(1);
  });

  it('two hits, neither a quarter: the 60% line alone; a wait\'s own 50% mark crossed in the same tick adds no second', async () => {
    for (const hp of [150, 115]) { host.me.health.current = hp; run(api, host, 300, { physics: false }); }
    const w = api.wait({ types: ['vitals-low'], healthBelow: 0.5 }, 5000);
    host.me.health.current = 90; // 48%: under 60% and the wait's 50% at once, −13%
    run(api, host, 300, { physics: false });
    expect(lows()).toEqual(['health 90/187 (48%): below 60%']);
    expect(await w).toHaveLength(1);
  });
});

describe.skipIf(!haveDat)('6. past Aerbax Haven #7029e002 in 0x029E: every reported line keeps out of it (needs DAT files)', () => {
  const LB = 0x029e0000;
  const C = (n: number): number => (LB | n) >>> 0;
  const AERBAX = 0x7029e002;
  const PORTAL = { x: 50, y: -640, z: -17.995 };
  // The portal's touch: its collision sphere (Setup 0x020001B3: 1.357 m) plus the body's (0.48 m).
  const TOUCH_M = 1.357 + 0.48;
  let nav: Awaited<ReturnType<typeof import('./_harness/dungeonNav.ts')['dungeonNav']>>;
  beforeAll(async () => {
    const { dungeonNav } = await import('./_harness/dungeonNav.ts');
    nav = await dungeonNav(LB, { statics: true, jumpSkill: 191, runRate: getClientRunRate(0.5, 179) });
  }, 180_000);
  const dats = (): { portal: ReturnType<typeof openDat>; cell: ReturnType<typeof openDat> } => ({ portal: openDat(DAT_PATHS.portal), cell: openDat(DAT_PATHS.cell) });

  /** The server's straight line between each two reported positions (ACE UpdatePlayerPosition), against the portal. */
  class ServerChords {
    last: { x: number; y: number; t: number; cell: number } | null = null;
    closest = Infinity;
    reports = 0;
    constructor(private readonly host: FakeHost) {}
    private send(): void {
      const me = this.host.me;
      if (this.last) {
        const ax = this.last.x, ay = this.last.y, dx = me.x - ax, dy = me.y - ay, l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.max(0, Math.min(1, ((PORTAL.x - ax) * dx + (PORTAL.y - ay) * dy) / l2)) : 0;
        if (Math.abs(me.z - PORTAL.z) < 3) this.closest = Math.min(this.closest, Math.hypot(ax + dx * t - PORTAL.x, ay + dy * t - PORTAL.y));
      }
      this.last = { x: me.x, y: me.y, t: this.host.t, cell: me.cell };
    }
    tick(): void {
      const me = this.host.me;
      if (!this.last || this.last.cell !== me.cell || (this.host.t - this.last.t > 1000 && Math.hypot(me.x - this.last.x, me.y - this.last.y) > 0.01)) this.send();
    }
    report = (): void => { this.reports++; this.send(); };
  }

  it('Bulwark\'s attack far=true at the Marionette 24 m S, across the portal (06:14:04Z): the run-up goes round, each line clear', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      class Fast extends DungeonHost { override physics(dt: number): void { super.physics(this.keys.has('ShiftLeft') ? dt : dt * 2.8); } }
      const host = new Fast(nav, dats(), LB, { rooms: true });
      try {
        host.me.health = { current: 187, max: 187 };
        host.me.combatMode = 'melee';
        host.add({ guid: AERBAX, name: 'Aerbax Haven', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x119), ...PORTAL });
        host.objectReach = (g) => (g === AERBAX ? 1.919 : 0);
        // The Marionette where it stood (24 m S of him: soldier.log 06:14:04Z, his run-up legs to (434, 29708.5) global).
        const at = { x: 50, y: -651, z: -18 };
        const mcell = nav.col.findCellContaining(384 + at.x, 30336 + at.y, at.z + 0.5, C(0x119));
        expect(mcell, 'the Marionette\'s spot is in a cell').toBeTruthy();
        const MARIONETTE = 0x80007e9b;
        host.add({ guid: MARIONETTE, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, cell: mcell! >>> 0, ...at, level: 26 });
        const server = new ServerChords(host);
        host.reportPosition = server.report;
        let started: AgentResult | null = null;
        const r = await host.run(C(0x119), { x: 50, y: -627.4, z: -18 }, async (api) => { started = api.attack(MARIONETTE, { far: true }); return started; }, { maxMs: 1000, each: () => server.tick() });
        expect(r.message, host.traces.join('\n')).toMatch(/^running up to Marionette .*round Aerbax Haven #7029e002/);
        // On with the run-up until it ends at the Marionette (or 40 s).
        for (let t = 0; t < 40_000; t += 100) {
          server.tick();
          host.t += 100;
          vi.advanceTimersByTime(100);
          host.physics(100);
          (host as unknown as { api: AgentApi }).api.tick();
          await Promise.resolve(); await Promise.resolve();
          if (host.sent.some((s) => s.startsWith(`attack ${MARIONETTE.toString(16)}`))) break;
        }
        expect(server.reports, host.traces.join('\n')).toBeGreaterThan(0);
        expect(server.closest, `closest ${server.closest.toFixed(2)} m\n${host.traces.join('\n')}`).toBeGreaterThan(TOUCH_M);
        expect(Math.hypot(host.me.x - at.x, host.me.y - at.y), host.traces.join('\n')).toBeLessThan(6);
      } finally { host.dispose(); }
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  }, 240_000);

  it('Arcanist\'s walk_to 0x029E0122 from 0x029E0112 (06:14:52Z): past the portal with every reported line clear', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const { DungeonHost } = await import('./_harness/dungeonWalk.js');
      class Fast extends DungeonHost { override physics(dt: number): void { super.physics(this.keys.has('ShiftLeft') ? dt : dt * 2.8); } }
      const host = new Fast(nav, dats(), LB, { rooms: true });
      try {
        host.add({ guid: AERBAX, name: 'Aerbax Haven', itemType: 0x10000, objectDescFlags: 0x40000, cell: C(0x119), ...PORTAL });
        host.objectReach = (g) => (g === AERBAX ? 1.919 : 0);
        const server = new ServerChords(host);
        host.reportPosition = server.report;
        // His first leg: 8.0 m to (434.0, 29721.0) global = (50, −615) in the landblock, from 0x029E0112.
        const from = host.cellPoint!(C(0x112))!;
        const r = await host.run(C(0x112), { x: from.x, y: from.y, z: from.z }, (api) => api.walkTo('0x029E0122'), { maxMs: 120_000, each: () => server.tick() });
        expect(r.message, host.traces.join('\n')).toMatch(/^arrived/);
        expect(server.closest, `closest ${server.closest.toFixed(2)} m\n${host.traces.join('\n')}`).toBeGreaterThan(TOUCH_M);
      } finally { host.dispose(); }
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  }, 240_000);
});

describe('6b. a run-up that went through a portal ends there (no DAT)', () => {
  it('no attack measured from the far side: target-lost says the run-up went through', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const host = new FakeHost();
      host.me = { ...host.me, cell: 0x029e0119, x: 50, y: -627, z: -18, combatMode: 'melee', level: 48 };
      const M = 0x80007e9b;
      host.add({ guid: M, name: 'Marionette', itemType: 0x10, objectDescFlags: 0x10, cell: 0x029e0119, x: 50, y: -651, z: -18, level: 26 });
      const api = new AgentApi(host);
      run(api, host, 200);
      const r = api.attack(M, { far: true });
      expect(r.message).toMatch(/^running up to Marionette/);
      // Two seconds into the run-up the body is carried away: portal space, then another dungeon.
      run(api, host, 2000);
      host.screenName = 'portal-space';
      host.me = { ...host.me, cell: 0x029f017e, x: 20, y: -400, z: 0 };
      run(api, host, 500);
      host.screenName = 'world';
      for (let i = 0; i < 40; i++) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
      const lost = api.eventsSince(0).filter((e) => e.type === 'target-lost').map((e) => e.text);
      expect(lost.join('\n')).toMatch(/the run-up (went through a portal|went into portal space)/);
      expect(lost.join('\n')).not.toMatch(/on the straight line to it/);
      expect(host.sent.filter((s) => s.startsWith(`attack ${M.toString(16)}`))).toEqual([]);
    } finally { vi.useRealTimers(); vi.restoreAllMocks(); }
  });
});
