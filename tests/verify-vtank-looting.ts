/**
 * VirindiTank's looting beyond the loot rules (docs/vtank-parity-gaps.md §3.3–§3.9): which corpses
 * (own kills by the corpse's "Killed by …", LootFellowCorpses, LootAllCorpses after 100 s, the
 * server's refusals), the corpse bookkeeping options and closing the corpse, CorpseApproachRange,
 * ReadUnknownScrolls and the Read action, mana donors, and /vt testitem / propertydump. The engine
 * runs on the fake agent host; the planners are pure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import {
  CORPSE_DENIAL_SKIP_MS, CORPSE_OTHERS_AFTER_MS, CorpseBook, corpseBookSettings, corpseIsRare, corpseKiller, isCorpseDenial,
} from '../packages/renderer/src/agent/macro/corpseBook.ts';
import { isDonor, manaLootAction, planDrain, spareStones } from '../packages/renderer/src/agent/macro/manaDonorPlan.ts';
import { canReadScroll, isScrollRefusal, scrollSpell } from '../packages/renderer/src/agent/macro/scrollPlan.ts';
import { propertyDumpLines, testItemLine } from '../packages/renderer/src/agent/macro/lootTest.ts';
import { ALL_MODULES_OFF, emptyVtankData, parseUtl, utlToLoot, vtLinkedSettings, vtOption, type LootRule, type RoutineProfile } from '../packages/shared/src/routines/index.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const S = corpseBookSettings({});

describe('the corpse\'s killer and the server\'s refusals, on every era\'s server', () => {
  it('reads "Killed by <name>." (ACE Creature_Death, GDLE / AC1999 Monster.cpp) and a rare\'s "generated"', () => {
    expect(corpseKiller('Killed by Claude Test.')).toBe('Claude Test');
    // ACE strips an admin's "+"; a server that doesn't still names the same character.
    expect(corpseKiller('Killed by +Jake.')).toBe('Jake');
    expect(corpseKiller("Killed by Drudge Ravener's-Kin.")).toBe("Drudge Ravener's-Kin");
    // ACE's no-killer death, and the AC1999 server's.
    expect(corpseKiller('Killed by misadventure.')).toBe('misadventure');
    expect(corpseKiller('Killed by a mysterious source.')).toBe('a mysterious source');
    expect(corpseKiller('')).toBe('');
    expect(corpseKiller('A fine sword. Killed by Bob.')).toBe('');
    expect(corpseIsRare('Killed by Bob. This corpse generated a rare item!')).toBe(true);
    expect(corpseIsRare('Killed by Bob.')).toBe(false);
  });

  it('knows each server\'s refusal lines (ACE Container.InUseMessage / Corpse.Open; GDLE / AC1999 CheckOpenContainer)', () => {
    expect(isCorpseDenial('The Corpse of Drudge Skulker is already in use by someone else!')).toBe(true);
    expect(isCorpseDenial('The Corpse of Drudge Skulker is already in use by Bob!')).toBe(true);
    expect(isCorpseDenial('You do not yet have the right to loot the Corpse of Drudge Skulker.')).toBe(true);
    expect(isCorpseDenial('You may not loot the Corpse of Drudge Skulker because the Corpse of Drudge Skulker has generated a rare item.')).toBe(true);
    expect(isCorpseDenial('You do not have permission to loot that corpse!')).toBe(true);
    expect(isCorpseDenial('You say, "the Corpse of X is already in use by someone else!"')).toBe(false);
  });
});

describe('CorpseBook: VTank\'s CanLoot and its bookkeeping', () => {
  const ctx = (over: Partial<Parameters<CorpseBook['mayLoot']>[1]> = {}) => ({ me: 'Claude Test', fellows: [], settings: S, now: 0, ...over });

  it('your own kill always; a stranger\'s only with LootAllCorpses after 100 s; never a rare of theirs or a killer-less one', () => {
    const b = new CorpseBook();
    b.observe([1, 2, 3, 4], 0, S);
    b.describe(1, 'Killed by Claude Test.', 0);
    b.describe(2, 'Killed by Someone.', 0);
    b.describe(3, 'Killed by Someone. This corpse generated a rare item!', 0);
    b.describe(4, 'An old corpse.', 0);
    expect(b.mayLoot(1, ctx())).toBe(true);
    expect(b.mayLoot(2, ctx())).toBe(false);
    const all = { ...S, lootAll: true };
    expect(b.mayLoot(2, ctx({ settings: all, now: CORPSE_OTHERS_AFTER_MS - 1 }))).toBe(false);
    expect(b.mayLoot(2, ctx({ settings: all, now: CORPSE_OTHERS_AFTER_MS }))).toBe(true);
    expect(b.mayLoot(3, ctx({ settings: all, now: 999_999 }))).toBe(false);
    expect(b.mayLoot(4, ctx({ settings: all, now: 999_999 }))).toBe(false);
    // Not described yet: undecided.
    expect(b.mayLoot(5, ctx())).toBeUndefined();
  });

  it('a fellow\'s kill: with LootFellowCorpses, at once when they share loot, else after 100 s; never without it', () => {
    const b = new CorpseBook();
    b.observe([1], 0, S);
    b.describe(1, 'Killed by Claude Bulwark.', 0);
    const fel = (shareLoot: boolean) => [{ name: 'Claude Bulwark', shareLoot }];
    expect(b.mayLoot(1, ctx({ fellows: fel(true), settings: { ...S, lootFellow: true } }))).toBe(true);
    expect(b.mayLoot(1, ctx({ fellows: fel(false), settings: { ...S, lootFellow: true } }))).toBe(false);
    expect(b.mayLoot(1, ctx({ fellows: fel(false), settings: { ...S, lootFellow: true }, now: CORPSE_OTHERS_AFTER_MS }))).toBe(true);
    // LootAllCorpses doesn't cover a fellow's kill (VTank asks LootFellowCorpses for those).
    expect(b.mayLoot(1, ctx({ fellows: fel(true), settings: { ...S, lootAll: true }, now: 999_999 }))).toBe(false);
  });

  it('refusals skip 10 s (the third for the blacklist time); failed opens blacklist at BlacklistCorpseOpenAttemptCount; the cache forgets', () => {
    const s = corpseBookSettings({ BlacklistCorpseOpenAttemptCount: 3, BlacklistCorpseOpenTimeoutSeconds: 50, CorpseCacheTimeoutMinutes: 2 });
    expect(s).toEqual({ lootAll: false, lootFellow: false, cacheMinutes: 2, openAttempts: 3, blacklistSeconds: 50 });
    const b = new CorpseBook();
    b.denied(1, 0, s);
    expect(b.skipped(1, CORPSE_DENIAL_SKIP_MS - 1, s)).toBe(true);
    expect(b.skipped(1, CORPSE_DENIAL_SKIP_MS, s)).toBe(false);
    b.denied(1, 20_000, s); b.denied(1, 40_000, s);
    expect(b.skipped(1, 40_000 + 49_000, s)).toBe(true);
    expect(b.skipped(1, 40_000 + 50_000, s)).toBe(false);
    expect(b.openFailed(2, 0, s)).toBe(false);
    expect(b.openFailed(2, 0, s)).toBe(false);
    expect(b.openFailed(2, 0, s)).toBe(true);
    expect(b.skipped(2, 49_999, s)).toBe(true);
    expect(b.skipped(2, 50_000, s)).toBe(false);
    b.complete(3, 0);
    expect(b.skipped(3, 1e9, s)).toBe(true);
    // Out of sight past the cache timeout: forgotten (a looted corpse could be looted again).
    b.observe([], 60_000, s);
    expect(b.skipped(3, 60_000, s)).toBe(true);
    b.observe([], 120_001, s);
    expect(b.skipped(3, 120_001, s)).toBe(false);
    // Three looks with no answer: no longer asked about.
    b.describe(4, null, 0); b.describe(4, null, 0);
    expect(b.needsDescription(4)).toBe(true);
    b.describe(4, null, 0);
    expect(b.needsDescription(4)).toBe(false);
  });
});

// ── the engine ──

const corpseProfile = (settings: Record<string, string | number | boolean>, over: Partial<RoutineProfile> = {}): RoutineProfile => ({
  name: 'Loot', modules: { ...ALL_MODULES_OFF, looting: true, combat: true, inventory: true },
  initialState: 'Hunt', loot: [], buffSets: [], routes: [], macro: true,
  states: [{ name: 'Hunt', rules: [] }],
  settings: { AttackDistance: 20, EnableLooting: true, EnableBuffing: false, ...settings },
  ...over,
});

describe('which corpses the macro loots', () => {
  let host: FakeHost;
  let api: AgentApi;
  const tick = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
  const uses = (g: number) => host.sent.filter((x) => x === `use ${g.toString(16)}`).length;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    // A corpse opens empty with a Use and closes with the next.
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); host.container = host.container?.guid === g ? null : { guid: g, items: [] }; return true; };
  });
  afterEach(() => { api.routine.stop(); vi.useRealTimers(); });
  const corpse = (guid: number, killer: string, x = 80, y = 23) => {
    host.add({ guid, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x, y });
    host.appraisals.set(guid, `Corpse of Drudge Skulker\nKilled by ${killer}.`);
  };

  it('LootAllCorpses: a stranger\'s corpse once it has lain 100 s, not before; off, never', async () => {
    corpse(0x80005001, 'Someone Else');
    api.routine.start(corpseProfile({ LootAllCorpses: true }));
    await tick(60_000);
    expect(uses(0x80005001)).toBe(0);
    await tick(55_000);
    expect(uses(0x80005001)).toBe(2); // opened, and closed when done
    api.routine.stop();
    corpse(0x80005002, 'Someone Else', 81, 23);
    api.routine.start(corpseProfile({}));
    await tick(120_000);
    expect(uses(0x80005002)).toBe(0);
  });

  it('LootFellowCorpses: a sharing fellow\'s kill at once', async () => {
    host.fellowInfo = { leader: false, open: false, count: 2, members: ['Claude Test', 'Claude Bulwark'], sharing: ['Claude Bulwark'] };
    corpse(0x80005011, 'Claude Bulwark');
    api.routine.start(corpseProfile({ LootFellowCorpses: true }));
    await tick(15_000);
    expect(uses(0x80005011)).toBe(2);
  });

  it('a stranger\'s kill of a monster you also killed is not taken as yours', async () => {
    host.add({ guid: 0x80005021, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23 });
    api.routine.start(corpseProfile({}));
    for (let i = 0; i < 40 && !host.sent.some((x) => x.startsWith('attack 80005021')); i++) await tick(100);
    host.pending = false;
    host.dying.add(0x80005021);
    await tick(300);
    host.objs.delete(0x80005021);
    // The corpse that turns up was someone else's kill (same name).
    corpse(0x80005022, 'Someone Else');
    await tick(20_000);
    expect(uses(0x80005022)).toBe(0);
    expect(api.routine.history().join('\n')).toMatch(/no corpse of ours within 5 m \(VTank walks to corpses only as far as CorpseApproachRange-Max/);
  });

  it('the server\'s "in use" skips the corpse 10 s, then it is tried again', async () => {
    corpse(0x80005031, 'Claude Test');
    let refuse = true;
    host.use = (g: number) => {
      host.sent.push(`use ${g.toString(16)}`);
      if (refuse) { api.pushChat('The Corpse of Drudge Skulker is already in use by someone else!', 0); return true; }
      host.container = host.container?.guid === g ? null : { guid: g, items: [] };
      return true;
    };
    api.routine.start(corpseProfile({ LootAllCorpses: true }));
    await tick(8_000);
    expect(uses(0x80005031)).toBe(1);
    expect(api.routine.history().join('\n')).toMatch(/refused, skipping it for 10 s/);
    await tick(5_000);
    expect(uses(0x80005031)).toBe(1);
    refuse = false;
    await tick(20_000);
    expect(uses(0x80005031)).toBe(3); // tried again, opened, closed
  });

  it('CorpseApproachRange-Max: beyond arm\'s reach nothing is walked to at 0 (VTank\'s default); set, it walks to within -Min and loots', async () => {
    corpse(0x80005041, 'Someone Else', 80, 32);
    api.routine.start(corpseProfile({ LootAllCorpses: true }));
    await tick(110_000);
    expect(uses(0x80005041)).toBe(0);
    api.routine.stop();
    api.routine.start(corpseProfile({ LootAllCorpses: true, 'CorpseApproachRange-Max': 20 }));
    await tick(20_000);
    expect(uses(0x80005041)).toBe(2);
    // It walked up to within CorpseApproachRange-Min (3.36 m) first.
    expect(Math.hypot(host.me.x - 80, host.me.y - 32)).toBeLessThanOrEqual(vtOption('CorpseApproachRange-Min')!.default as number + 0.5);
  });

  it('the Approach box links to the corpse range (vtLinkedSettings)', () => {
    expect(vtLinkedSettings('approachdistance', 25)).toEqual({ ApproachDistance: 25, 'CorpseApproachRange-Max': 25 });
    expect(vtLinkedSettings('AttackDistance', 25)).toEqual({ AttackDistance: 25 });
  });
});

describe('AgentApi.loot with VTank\'s corpse timings', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => vi.useRealTimers());
  const drive = async (p: Promise<unknown>, ms: number) => { let done = false; void p.then(() => { done = true; }); for (let t = 0; t < ms && !done; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };

  it('an empty listing waits CorpseItemAppearanceTimeoutSeconds for its items; the corpse is closed when done', async () => {
    host.add({ guid: 0x80005101, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 80, y: 22 });
    host.add({ guid: 0x80005102, name: 'Pyreals', itemType: 0x40, cell: 0 });
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); host.container = host.container?.guid === g ? null : { guid: g, items: [] }; return true; };
    host.pickUp = (g: number) => { host.sent.push(`pickup ${g.toString(16)}`); host.inv.push({ guid: g, name: 'Pyreals', where: 'main pack' }); host.container!.items = []; return true; };
    const p = api.loot(0x80005101, null, undefined, { appearMs: 6000, close: true });
    await drive(p, 3500);
    // The items arrive after the open.
    host.container!.items = [{ guid: 0x80005102, name: 'Pyreals' }];
    await drive(p, 10_000);
    const r = await p as { ok: boolean; message: string };
    expect(r.message).toMatch(/took 1: Pyreals/);
    expect(host.sent.filter((x) => x === 'use 80005101')).toHaveLength(2);
    expect(host.container).toBeNull();
  });

  it('an item the server won\'t move is picked up to CorpseLootItemMaxAttempts times; an open that never answers fails at the open timeout', async () => {
    host.add({ guid: 0x80005111, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 80, y: 22 });
    host.add({ guid: 0x80005112, name: 'Sticky Sword', itemType: 0x1, cell: 0 });
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); host.container = { guid: g, items: [{ guid: 0x80005112, name: 'Sticky Sword' }] }; return true; };
    const p = api.loot(0x80005111, null, undefined, { itemTries: 4 });
    await drive(p, 60_000);
    expect(host.sent.filter((x) => x === 'pickup 80005112')).toHaveLength(4);
    host.container = null;
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); return true; };
    const t0 = host.t;
    const q = api.loot(0x80005111, null, undefined, { openTimeoutMs: 1500 });
    await drive(q, 30_000);
    expect(((await q) as { message: string }).message).toMatch(/never opened/);
    expect(host.t - t0).toBeLessThan(5000);
  });
});

describe('ReadUnknownScrolls and the Read action (scrollPlan.ts)', () => {
  const table = new Map([[1, { name: 'Flame Bolt II', school: 1, power: 50 }], [2, { name: 'Flame Bolt VI', school: 1, power: 250 }], [3, { name: 'Flame Bolt I', school: 1, power: 1 }]]);
  const ctx = { known: new Set(['Flame Bolt I']), spell: (n: string) => [...table.values()].find((s) => s.name.toLowerCase() === n.toLowerCase()) ?? null, skill: (id: number) => (id === 34 ? 100 : null) };

  it('a scroll\'s spell from its examination, else "Scroll of …"; read only when unknown and the school skill reaches difficulty − 15', () => {
    expect(scrollSpell({ name: 'Scroll of Flame Bolt II', itemType: 0x2000 })).toBe('Flame Bolt II');
    expect(scrollSpell({ name: 'Inscription', itemType: 0x2000 }, { spells: ['Flame Bolt II'] })).toBe('Flame Bolt II');
    expect(scrollSpell({ name: 'Scroll of Flame Bolt II', itemType: 0x1 })).toBeNull();
    expect(scrollSpell({ name: 'A Book', itemType: 0x2000 })).toBeNull();
    expect(canReadScroll('Flame Bolt II', ctx)).toBe(true);
    expect(canReadScroll('Flame Bolt I', ctx)).toBe(false); // known
    expect(canReadScroll('Flame Bolt VI', ctx)).toBe(false); // 250 − 15 > 100
    expect(canReadScroll('No Such Spell', ctx)).toBe(false);
    expect(isScrollRefusal('You are not skilled enough in War Magic to learn this spell.')).toBe(true);
    expect(isScrollRefusal('You are not trained in War Magic!')).toBe(true);
    expect(isScrollRefusal('You do not have enough Arcane Lore to learn this spell.')).toBe(true);
  });

  const lootSetup = (items: Array<{ guid: number; name: string; itemType: number; uiEffects?: number }>, settings: Record<string, string | number | boolean>, over: Partial<RoutineProfile> = {}) => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    (host as unknown as { spellTableData: () => unknown }).spellTableData = () => ({ spells: new Map([...table].map(([id, s]) => [id, { ...s, desc: '', category: id, bitfield: 0 }])) });
    (host as unknown as { skillList: () => unknown[] }).skillList = () => [{ id: 34, name: 'War Magic', training: 'trained', base: 100, buffed: 100 }];
    for (const it of items) {
      host.add({ ...it, cell: 0 });
      // Examined, a scroll names its spell (ACE AppraiseInfo.BuildSpells: the SpellDID).
      host.appraisals.set(it.guid, it.name);
      host.appraisalDatas.set(it.guid, { int: {}, float: {}, string: {}, bool: {}, did: {}, spells: [it.name.replace(/^Scroll of /, '')] });
    }
    host.add({ guid: 0x80006001, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 80, y: 22 });
    host.appraisals.set(0x80006001, 'Killed by Someone.');
    host.use = (g: number) => {
      host.sent.push(`use ${g.toString(16)}`);
      if (g === 0x80006001) host.container = host.container?.guid === g ? null : { guid: g, items: items.filter((i) => !host.inv.some((x) => x.guid === i.guid)).map(({ guid, name }) => ({ guid, name })) };
      return true;
    };
    host.pickUp = (g: number) => { host.sent.push(`pickup ${g.toString(16)}`); const o = host.objs.get(g)!; host.inv.push({ guid: g, name: o.name, where: 'main pack', itemType: o.itemType, uiEffects: o.uiEffects } as never); if (host.container) host.container.items = host.container.items.filter((i) => i.guid !== g); return true; };
    const reports: string[] = [];
    api.routine.onReport = (r) => reports.push(r);
    api.routine.start(corpseProfile({ LootAllCorpses: true, ...settings }, over));
    const tick = async (ms: number) => { for (let t = 0; t < ms; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); } };
    return { host, api, reports, tick };
  };

  it('no rule takes it: an unknown scroll you can learn is taken and read; a known one is left; a refused read is kept', async () => {
    const t = lootSetup([
      { guid: 0x80006011, name: 'Scroll of Flame Bolt II', itemType: 0x2000 },
      { guid: 0x80006012, name: 'Scroll of Flame Bolt I', itemType: 0x2000 },
    ], {});
    // Reading it: the scroll is used up (ACE Scroll.ActOnUse: "The scroll is destroyed.").
    const corpseUse = t.host.use;
    t.host.use = (g: number) => { if (g === 0x80006011) { t.host.sent.push('use 80006011'); t.host.inv = t.host.inv.filter((i) => i.guid !== g); return true; } return corpseUse(g); };
    await t.tick(130_000);
    expect(t.host.sent).toContain('pickup 80006011');
    expect(t.host.sent).not.toContain('pickup 80006012');
    expect(t.host.sent).toContain('use 80006011');
    expect(t.reports).toEqual(expect.arrayContaining(['Took to read Scroll of Flame Bolt II (an unknown scroll)', 'Read Scroll of Flame Bolt II']));
    t.api.routine.stop();
    vi.useRealTimers();
  });

  it('ReadUnknownScrolls off: left; the server refusing a read keeps the scroll unread, once', async () => {
    const off = lootSetup([{ guid: 0x80006021, name: 'Scroll of Flame Bolt II', itemType: 0x2000 }], { ReadUnknownScrolls: false });
    await off.tick(130_000);
    expect(off.host.sent).not.toContain('pickup 80006021');
    off.api.routine.stop();
    vi.useRealTimers();
    const t = lootSetup([{ guid: 0x80006022, name: 'Scroll of Flame Bolt II', itemType: 0x2000 }], {});
    const corpseUse = t.host.use;
    t.host.use = (g: number) => { if (g === 0x80006022) { t.host.sent.push('use 80006022'); t.api.pushChat('You are not skilled enough in War Magic to learn this spell.', 0); return true; } return corpseUse(g); };
    await t.tick(140_000);
    expect(t.host.sent.filter((x) => x === 'use 80006022')).toHaveLength(1);
    expect(t.reports).toContain('Kept Scroll of Flame Bolt II unread: You are not skilled enough in War Magic to learn this spell.');
    t.api.routine.stop();
    vi.useRealTimers();
  });

  it('a rule that leaves the item (Leave / NoLoot) still lets an unknown scroll be taken to read', async () => {
    const t = lootSetup([{ guid: 0x80006041, name: 'Scroll of Flame Bolt II', itemType: 0x2000 }], {}, { loot: [{ label: 'No scrolls', action: 'ignore', match: { name: 'Scroll' } }] });
    await t.tick(125_000);
    expect(t.host.sent).toContain('pickup 80006041');
    t.api.routine.stop();
    vi.useRealTimers();
  });

  it('a .utl Read rule (VTClassic action 4) imports enabled as read, and takes its item', async () => {
    const utl = ['UTL', '1', '1', 'Scrolls', '', '0;4;1', '13', 'Flame Bolt', '1', ''].join('\r\n');
    const rules: LootRule[] = utlToLoot(parseUtl(utl)).value;
    expect(rules[0]).toMatchObject({ action: 'read', match: { name: 'Flame Bolt' } });
    expect(rules[0].disabled).toBeUndefined();
    const t = lootSetup([{ guid: 0x80006031, name: 'Scroll of Flame Bolt I', itemType: 0x2000 }], {}, { loot: rules });
    await t.tick(130_000);
    // Taken by the rule (a scroll you know is still taken: the rule says so; it just isn't read).
    expect(t.host.sent).toContain('pickup 80006031');
    expect(t.reports).toContain('Took to read Scroll of Flame Bolt I (rule: Scrolls)');
    expect(t.host.sent).not.toContain('use 80006031');
    t.api.routine.stop();
    vi.useRealTimers();
  });
});

describe('mana donors (manaDonorPlan.ts)', () => {
  const stone = (guid: number, charged = false) => ({ guid, name: 'Mana Stone', itemType: 0x80000, uiEffects: charged ? 1 : 0 });
  const donorProps = { int: { 107: 3000, 105: 5 } };

  it('a donor holds the minimum, has a workmanship, was never tinkered, isn\'t retained or written on', () => {
    expect(isDonor(donorProps, 1000)).toBe(true);
    expect(isDonor({ int: { 107: 999, 105: 5 } }, 1000)).toBe(false);
    expect(isDonor({ int: { 107: 3000 } }, 1000)).toBe(false);
    expect(isDonor({ int: { 107: 3000, 105: 5, 171: 1 } }, 1000)).toBe(false);
    expect(isDonor({ ...donorProps, bool: { 91: true } }, 1000)).toBe(false);
    expect(isDonor(donorProps, 1000, 0x01000000)).toBe(false);
    expect(isDonor({ ...donorProps, string: { 7: 'Mine' } }, 1000)).toBe(false);
    expect(isDonor(null, 1000)).toBe(false);
  });

  it('stones up to ManaStoneLootCount; donors only while a spare empty stone waits; nothing without a stone on Consumables', () => {
    const ctx = { carried: [stone(1)], consumables: ['Mana Stone'], stoneCount: 2, minimum: 1000, donorsWaiting: 0 };
    expect(manaLootAction(stone(9), null, ctx)).toBe('stone');
    expect(manaLootAction(stone(9), null, { ...ctx, carried: [stone(1), stone(2)] })).toBeNull();
    expect(manaLootAction({ guid: 5, name: 'Gold Ring', itemType: 0x8, uiEffects: 1 }, donorProps, ctx)).toBe('donor');
    expect(manaLootAction({ guid: 5, name: 'Gold Ring', itemType: 0x8, uiEffects: 1 }, donorProps, { ...ctx, donorsWaiting: 1 })).toBeNull();
    expect(manaLootAction({ guid: 5, name: 'Gold Ring', itemType: 0x8, uiEffects: 1 }, donorProps, { ...ctx, carried: [stone(1, true)] })).toBeNull();
    expect(manaLootAction(stone(9), null, { ...ctx, consumables: [] })).toBeNull();
    expect(spareStones([stone(1), stone(2), stone(3, true)], ['Mana Stone'], 1)).toBe(1);
  });

  it('drains the fullest donor into the lowest-id empty stone', () => {
    const carried = [stone(20), stone(10), stone(5, true), { guid: 30, name: 'Ring', itemType: 0x8 }, { guid: 31, name: 'Wand', itemType: 0x8000 }];
    const props = (g: number) => (g === 30 ? { int: { 107: 2000, 105: 4 } } : g === 31 ? { int: { 107: 5000, 105: 4 } } : null);
    expect(planDrain(carried, new Set([30, 31]), ['Mana Stone'], 1000, props)).toMatchObject({ stone: { guid: 10 }, donor: { guid: 31 } });
    expect(planDrain(carried, new Set(), ['Mana Stone'], 1000, props)).toBeNull();
  });

  it('the macro takes a donor from a corpse and empties it into an empty stone', async () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.inv.push({ guid: 0x50007001, name: 'Mana Stone', where: 'main pack', itemType: 0x80000, uiEffects: 0 } as never);
    host.add({ guid: 0x80007002, name: 'Gold Ring', itemType: 0x8, uiEffects: 1, cell: 0 });
    host.add({ guid: 0x80007003, name: 'Plain Ring', itemType: 0x8, cell: 0 });
    host.appraisals.set(0x80007002, 'Gold Ring');
    host.appraisalDatas.set(0x80007002, { int: { 107: 3000, 105: 5 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    host.add({ guid: 0x80007001, name: 'Corpse of Drudge Skulker', objectDescFlags: 0x2000, x: 80, y: 22 });
    host.appraisals.set(0x80007001, 'Killed by Someone.');
    const items = [{ guid: 0x80007002, name: 'Gold Ring' }, { guid: 0x80007003, name: 'Plain Ring' }];
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); host.container = host.container?.guid === g ? null : { guid: g, items: items.filter((i) => !host.inv.some((x) => x.guid === i.guid)) }; return true; };
    host.pickUp = (g: number) => { host.sent.push(`pickup ${g.toString(16)}`); host.inv.push({ guid: g, name: host.objs.get(g)!.name, where: 'main pack', itemType: 0x8 } as never); return true; };
    // The client asks first (TargetedUsageConfirmation_ManaStone); Yes drains the ring and destroys it (ACE ManaStone.HandleActionUseOnTarget).
    host.useWithTarget = (s: number, t: number) => {
      host.sent.push(`usewith ${s.toString(16)} ${t.toString(16)}`);
      host.dialogList.push({ text: '\nAre you sure you want to attempt to destroy your Gold Ring and drain its mana into this stone?', buttons: ['Yes', 'No'] });
      host.answerDialog = (label: string) => {
        host.dialogList = [];
        host.sent.push(`dialog ${label}`);
        if (label === 'Yes') { host.inv = host.inv.filter((i) => i.guid !== t); api.pushChat('The Mana Stone drains 3,000 points of mana from the Gold Ring.\nThe Gold Ring is destroyed.', 0); }
        return true;
      };
      return true;
    };
    const reports: string[] = [];
    api.routine.onReport = (r) => reports.push(r);
    api.routine.start(corpseProfile({ LootAllCorpses: true }, { vtank: { ...emptyVtankData(), consumables: ['Mana Stone'] } }));
    for (let t = 0; t < 130_000; t += 100) { run(api, host, 100); await vi.advanceTimersByTimeAsync(100); }
    expect(host.sent).toContain('pickup 80007002');
    expect(host.sent).not.toContain('pickup 80007003');
    expect(host.sent).toContain('usewith 50007001 80007002');
    expect(host.sent).toContain('dialog Yes');
    expect(reports).toEqual(expect.arrayContaining(['Took for its mana Gold Ring (a mana donor)', 'Drained Gold Ring into Mana Stone']));
    api.routine.stop();
    vi.useRealTimers();
  });
});

describe('/vt testitem and /vt propertydump', () => {
  it('formats the answer and the dump with ACE\'s property names', () => {
    expect(testItemLine('Sword', { action: 'sell', rule: 'Junk' })).toBe('TestItem: Sword => sell (rule: Junk)');
    expect(testItemLine('Sword', null)).toBe('TestItem: Sword => no rule matches (left on the corpse)');
    expect(propertyDumpLines('Sword', { int: { 19: 80, 5: 200 }, string: { 1: 'Sword' }, did: { 1: 0x02000123 }, spells: ['Blood Drinker I'] })).toEqual([
      'Properties of Sword:',
      '  Int: EncumbranceVal(5)=200, Value(19)=80',
      '  String: Name(1)="Sword"',
      '  DataId: Setup(1)=0x02000123',
      '  Spells: Blood Drinker I',
    ]);
    expect(propertyDumpLines('Sword', null)).toEqual(['Sword: no examination data']);
  });

  it('the engine tests the selected item against the rules, examining it first', async () => {
    vi.useFakeTimers();
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.inv.push({ guid: 0x50008001, name: 'Rusty Sword', where: 'main pack' });
    host.appraisals.set(0x50008001, 'Rusty Sword\nValue: 80\nBurden: 200');
    host.appraisalDatas.set(0x50008001, { int: { 19: 80 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    const rules: LootRule[] = [{ label: 'Cheap', action: 'ignore', match: { valueAtMost: 10 } }, { label: 'Junk', action: 'sell', match: { valueAtLeast: 50 } }];
    expect(await api.routine.testItem(rules)).toEqual(['TestItem: select an item first.']);
    host.target = 0x50008001;
    expect(await api.routine.testItem(rules)).toEqual(['TestItem: Rusty Sword => sell (rule: Junk)']);
    expect(await api.routine.testItem([rules[0]])).toEqual(['TestItem: Rusty Sword => no rule matches (left on the corpse)']);
    expect(await api.routine.propertyDump()).toEqual(['Properties of Rusty Sword:', '  Int: Value(19)=80']);
    vi.useRealTimers();
  });
});

describe('version-0 .utl files (no UTL header, no expression line, no length codes)', () => {
  it('reads each requirement by its own line count (VTClassic\'s Read()), keep-up-to included', () => {
    const v0 = ['2', 'Money', '0;1;1', 'Pyreal', '1', 'Kits', '0;10;7;2', '5', '29', '100', '19', ''].join('\r\n');
    const rules = parseUtl(v0);
    expect(rules).toEqual([
      { name: 'Money', action: 1, reqs: [{ type: 1, lines: ['Pyreal', '1'] }] },
      { name: 'Kits', action: 10, keepCount: 5, reqs: [{ type: 7, lines: ['29'] }, { type: 2, lines: ['100', '19'] }] },
    ]);
    const loot = utlToLoot(rules).value;
    expect(loot[0]).toMatchObject({ action: 'keep', match: { name: 'Pyreal' } });
    expect(loot[1]).toMatchObject({ action: 'keep-up-to', count: 5, match: { valueAtMost: 100 } });
    // A type VTClassic doesn't know can't be skipped without a length: refused, not misread.
    expect(() => parseUtl(['1', 'X', '0;1;4242', 'a', ''].join('\r\n'))).toThrow(/type 4242/);
  });
});
