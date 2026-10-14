/**
 * Mag-Tools' background features (@ac/shared magtools/, rebuilt from docs/plugin-specs/magtools.md
 * §9): Autopack (and how VirindiTank's tidy leaves its placement alone), auto add to trade, auto
 * trade accept, login / login complete / periodic commands, one-touch heal, log out on death,
 * open main pack on login, and the chat filters, read against our own client's chat strings.
 */
import { describe, expect, it } from 'vitest';
import {
  ChatMessageType, MT_KILL_TEMPLATES, MT_TRADE_WHITELIST_KEY, MtAutoTradeAccept, MtAutoTradeAdd, MtAutopacker, MtChatFilter,
  MtLoginCommands, MtOptions, MT_FILTER_FIELDS, WeenieErrorWithString, formatWeenieErrorWithString, mtAutopackPlacement,
  mtAutopackRulePacks, mtCommandListKey, mtEnabledFilters, mtHidesStatusText, mtIsAutopackTrigger, mtKeepPackDigits,
  mtLogOutOnDeath, mtMinuteOfDay, mtOneTouchHeal, mtOpenMainPackOnLogin, mtParsePeriodic, mtPeriodicDue, mtPlanAutopack,
  mtTradeRuleVerdict, mtTradeWhitelistAdd, mtTradeWhitelistMatches, readMtCommands, readMtTradeWhitelist, weenieErrorText, writeMtCommands,
  writeMtTradeWhitelist, type MtChatLine, type MtFilterField, type MtKeepPacks, type MtOptionStorage, type MtPackInfo,
  type MtPackItem, type MtTradeItem,
} from '@ac/shared';
import { evasionAttackerLine, evasionDefenderLine } from '../packages/renderer/src/ui/ServerMessageText.ts';
import { enchantmentExpiredLine } from '../packages/renderer/src/chat/EnchantmentExpiry.ts';
import { salvageResultChatLines } from '../packages/renderer/src/ui/SalvagePanel.ts';
import { formatSpeechLine } from '../packages/renderer/src/chat/SpeechLine.ts';
import { planInventory, InventoryTidy, type InvItem, type InvPack } from '../packages/renderer/src/agent/macro/inventoryPlan.ts';

function memStore(init: Record<string, string> = {}): MtOptionStorage & { data: Record<string, string> } {
  const data = { ...init };
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = v; } };
}

// ─── Autopack ────────────────────────────────────────────────────────

const item = (id: number, name: string, pack: number, extra: Partial<MtPackItem> = {}): MtPackItem =>
  ({ id, name, pack, stack: 1, maxStack: 1, equipped: false, isContainer: false, ...extra });
const pack = (index: number, count: number, capacity = 24): MtPackInfo => ({ index, id: 0x500 + index, capacity, count });

describe('Autopack planner (§9.1)', () => {
  it('reads Keep # digits as pack indices, in index order; only keep-up-to rules place', () => {
    expect(mtKeepPackDigits(12)).toEqual([1, 2]);
    expect(mtKeepPackDigits(345)).toEqual([3, 4, 5]);
    expect(mtKeepPackDigits(0)).toEqual([0]);
    expect(mtKeepPackDigits(21)).toEqual([1, 2]);
    expect(mtKeepPackDigits(undefined)).toBeNull();
    expect(mtAutopackRulePacks({ action: 'keep-up-to', count: 12, match: {} })).toEqual([1, 2]);
    expect(mtAutopackRulePacks({ action: 'keep', match: {} })).toBeNull();
    expect(mtAutopackRulePacks({ action: 'keep-up-to', count: 1, match: {}, disabled: true })).toBeNull();
    expect(mtAutopackRulePacks(null)).toBeNull();
  });

  it('stacks first, within one pack only', () => {
    const items = [
      item(1, 'Pyreal', 0, { stack: 10, maxStack: 25000 }),
      item(2, 'Pyreal', 1, { stack: 5, maxStack: 25000 }),
      item(3, 'Pyreal', 1, { stack: 7, maxStack: 25000 }),
    ];
    const plan = mtPlanAutopack({ items, packs: [pack(0, 1, 102), pack(1, 2)], keepPacks: () => null });
    expect(plan.move).toMatchObject({ kind: 'merge', from: 3, onto: 2 });
  });

  it('moves to the first listed pack with room, skips items in their first choice, never moves worn items, packs or foci', () => {
    const keep: Record<string, MtKeepPacks> = { Scarab: [1, 2], Gem: [2], Sword: [1], Pack: [1], Focus: [1] };
    const kp = (i: MtPackItem) => keep[i.name] ?? null;
    const items = [
      item(1, 'Scarab', 1),
      item(2, 'Sword', 0, { equipped: true }),
      item(3, 'Pack', 0, { isContainer: true }),
      item(4, 'Focus', 0, { isFocus: true }),
      item(5, 'Gem', 0),
    ];
    const plan = mtPlanAutopack({ items, packs: [pack(0, 4, 102), pack(1, 1), pack(2, 0)], keepPacks: kp });
    expect(plan.move).toMatchObject({ kind: 'move', id: 5, pack: 2 });
    // A full first choice falls through to the next listed pack; already in a later listed pack with no earlier room: stays.
    const full = [pack(0, 1, 102), pack(1, 24), pack(2, 3)];
    expect(mtPlanAutopack({ items: [item(7, 'Scarab', 0)], packs: full, keepPacks: kp }).move).toMatchObject({ id: 7, pack: 2 });
    expect(mtPlanAutopack({ items: [item(7, 'Scarab', 2)], packs: full, keepPacks: kp }).move).toBeNull();
    // A listed pack that doesn't exist is skipped.
    expect(mtPlanAutopack({ items: [item(8, 'Gem', 0)], packs: [pack(0, 1, 102), pack(1, 0)], keepPacks: kp }).move).toBeNull();
  });

  it('collects items whose rule needs an appraisal', () => {
    const plan = mtPlanAutopack({ items: [item(1, 'Ring', 0)], packs: [pack(0, 1, 102), pack(1, 0)], keepPacks: () => 'appraise' });
    expect(plan).toEqual({ move: null, appraise: [1] });
  });

  it('the trigger line: any non-say line with "<me> autopack", any case', () => {
    expect(mtIsAutopackTrigger('Mulebot tells you, "Hero autopack"', 'Hero', false)).toBe(true);
    expect(mtIsAutopackTrigger('mule tells you, "HERO AUTOPACK please"', 'Hero', false)).toBe(true);
    expect(mtIsAutopackTrigger('Bob says, "Hero autopack"', 'Hero', true)).toBe(false);
    expect(mtIsAutopackTrigger('Hero, autopack', 'Hero', false)).toBe(false);
  });
});

describe('Autopack runner', () => {
  function rig(opts: { profile?: boolean } = {}) {
    let t = 0;
    const items: MtPackItem[] = [item(10, 'Gem', 0), item(11, 'Mana Stone', 0)];
    const packs: MtPackInfo[] = [pack(0, 2, 102), pack(1, 0)];
    const printed: string[] = [];
    const appraised: number[] = [];
    let answer = true;
    let busy = false;
    const rules: Record<string, MtKeepPacks> = { Gem: [1], 'Mana Stone': [1] };
    const host = {
      items: () => items.map((i) => ({ ...i })),
      packs: () => packs.map((p) => ({ ...p })),
      hasProfile: () => opts.profile ?? true,
      keepPacks: (i: MtPackItem) => rules[i.name] ?? null,
      place: (id: number, to: { pack: number } | { onto: number }) => {
        if (answer && 'pack' in to) { const it = items.find((i) => i.id === id)!; packs[it.pack]!.count--; it.pack = to.pack; packs[to.pack]!.count++; }
        return true;
      },
      appraise: (id: number) => { appraised.push(id); },
      print: (s: string) => { printed.push(s); },
      busy: () => busy,
    };
    const p = new MtAutopacker(host, () => t);
    return { p, printed, appraised, rules, items, adv: (ms: number) => { t += ms; }, setAnswer: (v: boolean) => { answer = v; }, setBusy: (v: boolean) => { busy = v; } };
  }

  it('does nothing, silently, without a profile', () => {
    const r = rig({ profile: false });
    expect(r.p.start()).toBe(false);
    expect(r.printed).toEqual([]);
  });

  it('starts, moves one item per answered step, completes', () => {
    const r = rig();
    expect(r.p.start()).toBe(true);
    expect(r.printed).toEqual(['Auto Pack - Started.']);
    expect(r.p.step()).toBe('moved');
    expect(r.p.step()).toBe('moved'); // the first was answered; the second goes
    expect(r.p.step()).toBe('done');
    expect(r.printed).toEqual(['Auto Pack - Started.', 'Auto Pack - Completed.']);
    expect(r.items.every((i) => i.pack === 1)).toBe(true);
  });

  it('waits while another mover (VirindiTank\'s tidy) is busy', () => {
    const r = rig();
    r.p.start();
    r.setBusy(true);
    expect(r.p.step()).toBe('busy');
    expect(r.items[0]!.pack).toBe(0);
  });

  it('blacklists an item that fails for 10 s', () => {
    const r = rig();
    r.setAnswer(false);
    r.rules['Mana Stone'] = null;
    r.p.start();
    expect(r.p.step()).toBe('moved');
    r.adv(1000); expect(r.p.step()).toBe('waiting');
    for (let k = 0; k < 6; k++) { r.adv(2000); r.p.step(); }
    expect(r.printed).toContain('Blacklisting item: 10, Gem');
    expect(r.p.blacklist.has(10)).toBe(true);
    // The step that blacklisted it found nothing else to do.
    expect(r.printed.at(-1)).toBe('Auto Pack - Completed.');
    expect(r.p.running).toBe(false);
  });

  it('asks for appraisals and gives up on them after 10 s', () => {
    const r = rig();
    r.rules.Gem = 'appraise';
    r.rules['Mana Stone'] = null;
    r.p.start();
    expect(r.p.step()).toBe('appraising');
    expect(r.p.step()).toBe('appraising');
    expect(r.appraised).toEqual([10]);
    r.adv(10000);
    expect(r.p.step()).toBe('done');
  });
});

describe('Autopack beside VirindiTank Autostack / Autocram (inventoryPlan keepIn)', () => {
  const inv = (guid: number, name: string, packSlot: number, extra: Partial<InvItem> = {}): InvItem =>
    ({ guid, name, packSlot, stack: 1, maxStack: 1, wcid: guid, isPack: false, equipped: false, ...extra });
  const ipacks: InvPack[] = [{ slot: 0, guid: 0x10, capacity: 102, count: 2 }, { slot: 1, guid: 0x11, capacity: 24, count: 0 }, { slot: 2, guid: 0x12, capacity: 24, count: 1 }];

  it('placement is what Keep # rules place, only for movable items', () => {
    const items = [item(1, 'Gem', 0), item(2, 'Sword', 0, { equipped: true }), item(3, 'Junk', 0), item(4, 'Ring', 0)];
    const m = mtAutopackPlacement(items, (i) => (i.name === 'Gem' || i.name === 'Sword' ? [0] : i.name === 'Ring' ? 'appraise' : null));
    expect([...m.entries()]).toEqual([[1, [0]]]);
  });

  it('autocram leaves an item Autopack placed in the main pack, and crams the rest', () => {
    const items = [inv(1, 'Gem', 0), inv(2, 'Junk', 0)];
    expect(planInventory({ items, packs: ipacks, autostack: false, autocram: true })).toMatchObject({ guid: 1 });
    expect(planInventory({ items, packs: ipacks, autostack: false, autocram: true, keepIn: new Map([[1, [0]]]) })).toMatchObject({ kind: 'move', guid: 2, packSlot: 1 });
  });

  it('autostack never merges a placed stack into another pack (and keeps its own direction)', () => {
    const scarab = (guid: number, packSlot: number, stack: number) => inv(guid, 'Scarab', packSlot, { wcid: 99, stack, maxStack: 100, burden: stack });
    const items = [scarab(1, 0, 5), scarab(2, 2, 10)];
    // Untouched: the main-pack stack goes onto the side pack's.
    expect(planInventory({ items, packs: ipacks, autostack: true, autocram: false })).toMatchObject({ kind: 'merge', from: 1, onto: 2 });
    // Autopack keeps #1 in the main pack: it may not leave. VTank stacks toward the side packs, so nothing goes.
    expect(planInventory({ items, packs: ipacks, autostack: true, autocram: false, keepIn: new Map([[1, [0]]]) })).toBeNull();
    // A third stack: the pinned one is passed over and the next merges.
    const three = [scarab(1, 0, 5), scarab(3, 1, 4), scarab(2, 2, 10)];
    expect(planInventory({ items: three, packs: ipacks, autostack: true, autocram: false, keepIn: new Map([[1, [0]]]) })).toMatchObject({ kind: 'merge', from: 3, onto: 2 });
    // Both pinned to their own packs: nothing.
    expect(planInventory({ items, packs: ipacks, autostack: true, autocram: false, keepIn: new Map([[1, [0]], [2, [2]]]) })).toBeNull();
  });

  it('InventoryTidy reads the placement each step', () => {
    const items = [inv(1, 'Gem', 0)];
    const moves: number[] = [];
    const tidy = new InventoryTidy({ itemSlots: () => items, packs: () => ipacks, placeItem: (g) => { moves.push(g); return { ok: true, message: '' }; } }, () => 0);
    tidy.keepIn = () => new Map([[1, [0]]]);
    expect(tidy.step({ autostack: true, autocram: true }).kind).toBe('idle');
    tidy.keepIn = null;
    expect(tidy.step({ autostack: true, autocram: true }).kind).toBe('moved');
    expect(moves).toEqual([1]);
  });
});

// ─── Trade ───────────────────────────────────────────────────────────

describe('Auto trade accept (§9.3, §3.4)', () => {
  it('stores the whitelist as JSON under its key, and matches whole names by regex', () => {
    const s = memStore();
    writeMtTradeWhitelist(s, ['Hero.*', '', 'Mule']);
    expect(JSON.parse(s.data[MT_TRADE_WHITELIST_KEY]!)).toEqual(['Hero.*', 'Mule']);
    expect(readMtTradeWhitelist(s)).toEqual(['Hero.*', 'Mule']);
    expect(readMtTradeWhitelist(memStore({ [MT_TRADE_WHITELIST_KEY]: 'not json' }))).toEqual([]);
    expect(mtTradeWhitelistMatches('Heroine', ['Hero.*'])).toBe(true);
    expect(mtTradeWhitelistMatches('Mule2', ['Mule'])).toBe(false);
    expect(mtTradeWhitelistMatches('A Mule', ['Mule'])).toBe(false);
    expect(mtTradeWhitelistMatches('mule', ['Mule'])).toBe(false);
    expect(mtTradeWhitelistMatches('Bob', ['Mule|Bob'])).toBe(true); // alternation stays anchored (a full match)
    expect(mtTradeWhitelistMatches('xBob', ['Mule|Bob'])).toBe(false);
    expect(mtTradeWhitelistMatches('Bob', ['(bad'])).toBe(false);
  });

  it('the editor\'s Add trims, ignores blanks and duplicates, and refuses text that isn\'t a regex', () => {
    expect(mtTradeWhitelistAdd(['Hero.*'], '  Mule  ')).toEqual({ list: ['Hero.*', 'Mule'], changed: true });
    expect(mtTradeWhitelistAdd(['Hero.*'], 'Hero.*')).toEqual({ list: ['Hero.*'], changed: false });
    expect(mtTradeWhitelistAdd([], '   ')).toEqual({ list: [], changed: false });
    expect(mtTradeWhitelistAdd([], '(bad').error).toBe('Auto Trade Accept - "(bad" is not a valid regular expression.');
    // Valid only once wrapped (^(?:a)(b)$) is still refused: on its own it isn't a regex.
    expect(mtTradeWhitelistAdd([], 'a)(b')).toMatchObject({ list: [], changed: false });
    expect(mtTradeWhitelistAdd([], 'a)(b').error).toBeDefined();
  });

  it('accepts when the partner accepted, is whitelisted, the option is on, and 2 s have passed', () => {
    let t = 10000;
    const a = new MtAutoTradeAccept(() => t);
    const e = { enabled: true, whoAccepted: 'Mule', me: 'Hero', partner: 'Mule', whitelist: ['Mule'] };
    expect(a.accepted({ ...e, enabled: false })).toBe(false);
    expect(a.accepted({ ...e, whoAccepted: 'Hero' })).toBe(false);
    expect(a.accepted({ ...e, whitelist: ['Bob'] })).toBe(false);
    expect(a.accepted(e)).toBe(true);
    t += 1999; expect(a.accepted(e)).toBe(false);
    t += 1; expect(a.accepted(e)).toBe(true);
  });
});

describe('Auto add to trade (§9.2)', () => {
  function rig() {
    let t = 0;
    const inventory: MtTradeItem[] = [{ id: 1, name: 'Sword', equipped: true }, { id: 2, name: 'Gem', equipped: false }, { id: 3, name: 'Junk', equipped: false }, { id: 4, name: 'Ring', equipped: false }];
    const added: number[] = []; const printed: string[] = []; const appraised: number[] = [];
    let ringAppraised = false;
    const profiles: Record<string, (i: MtTradeItem) => 'keep' | 'no' | 'appraise'> = {
      Mule: (i) => (i.name === 'Ring' ? (ringAppraised ? 'keep' : 'appraise') : i.name === 'Gem' || i.name === 'Sword' ? 'keep' : 'no'),
    };
    const add = new MtAutoTradeAdd({ inventory: () => inventory, profile: (p) => profiles[p] ?? null, add: (id) => added.push(id), appraise: (id) => appraised.push(id), print: (s) => printed.push(s) }, () => t);
    return { add, added, printed, appraised, adv: (ms: number) => { t += ms; }, appraiseRing: () => { ringAppraised = true; } };
  }

  it('runs only when I opened the trade, with the option on and a profile for the partner', () => {
    const r = rig();
    expect(r.add.opened({ enabled: false, iInitiated: true, partner: 'Mule' })).toBe(false);
    expect(r.add.opened({ enabled: true, iInitiated: false, partner: 'Mule' })).toBe(false);
    expect(r.add.opened({ enabled: true, iInitiated: true, partner: 'Stranger' })).toBe(false);
    expect(r.add.step()).toBe('idle');
  });

  it('adds Keep items one per tick (never worn ones), appraises as needed, then prints the done line', () => {
    const r = rig();
    expect(mtTradeRuleVerdict({ action: 'keep', match: {} })).toBe('keep');
    expect(mtTradeRuleVerdict({ action: 'keep-up-to', count: 1, match: {} })).toBe('no');
    expect(r.add.opened({ enabled: true, iInitiated: true, partner: 'Mule' })).toBe(true);
    expect(r.add.step()).toBe('added');
    expect(r.added).toEqual([2]);
    expect(r.add.step()).toBe('appraising');
    expect(r.appraised).toEqual([4]);
    r.appraiseRing();
    expect(r.add.step()).toBe('added');
    expect(r.add.step()).toBe('done');
    expect(r.added).toEqual([2, 4]);
    expect(r.printed).toEqual(['Auto Add To Trade - Inventory scan complete.']);
    expect(r.add.step()).toBe('idle');
  });

  it('stops on trade end', () => {
    const r = rig();
    r.add.opened({ enabled: true, iInitiated: true, partner: 'Mule' });
    r.add.ended();
    expect(r.add.step()).toBe('idle');
    expect(r.added).toEqual([]);
  });
});

// ─── Login / Login Complete / Periodic ───────────────────────────────

describe('Login, Login Complete and periodic commands (§9.4)', () => {
  const charScope = { account: 'acct', server: 'Coldeve', character: 'Hero' };
  const srvScope = { server: 'Coldeve' };

  it('stores each list under its key; the periodic Add checks its numbers', () => {
    const s = memStore();
    writeMtCommands(s, 'OnLoginCommands', charScope, ['/mt opt list', 'hi']);
    expect(s.data[mtCommandListKey('OnLoginCommands', charScope)]).toBe('["/mt opt list","hi"]');
    expect(readMtCommands(s, 'OnLoginCommands', charScope)).toEqual(['/mt opt list', 'hi']);
    s.set(mtCommandListKey('PeriodicCommands', srvScope), JSON.stringify([{ command: 'x', interval: 5, offset: 0 }, { command: 'bad', interval: 0, offset: 0 }]));
    expect(readMtCommands(s, 'PeriodicCommands', srvScope)).toEqual([{ command: 'x', interval: 5, offset: 0 }]);
    expect(mtParsePeriodic('x', '10', '0')).toEqual({ command: 'x', interval: 10, offset: 0 });
    expect(mtParsePeriodic('', '10', '0')).toBeNull();
    expect(mtParsePeriodic('x', '0', '0')).toBeNull();
    expect(mtParsePeriodic('x', '10', '-1')).toBeNull();
    expect(mtParsePeriodic('x', '1.5', '0')).toBeNull();
  });

  it('adds the offset: due when (m + offset) % interval == 0', () => {
    expect(mtPeriodicDue({ command: 'x', interval: 60, offset: 0 }, 120)).toBe(true);
    expect(mtPeriodicDue({ command: 'x', interval: 60, offset: 15 }, 45)).toBe(true);
    expect(mtPeriodicDue({ command: 'x', interval: 60, offset: 15 }, 75)).toBe(false);
    expect(mtMinuteOfDay(new Date(2026, 0, 1, 13, 7, 30))).toBe(13 * 60 + 7);
  });

  function rig() {
    const s = memStore();
    const mt: string[] = []; const chat: string[] = [];
    const lc = new MtLoginCommands({ characterScope: () => charScope, serverScope: () => srvScope, store: s, runMt: (c) => mt.push(c), sendChat: (c) => chat.push(c) });
    return { s, lc, mt, chat };
  }

  it('queues a placeholder, the character list, then the server list, one per frame', () => {
    const r = rig();
    writeMtCommands(r.s, 'OnLoginCommands', charScope, ['/MT opt list', '/tell Mule hi']);
    writeMtCommands(r.s, 'OnLoginCommands', srvScope, ['/a hello']);
    writeMtCommands(r.s, 'OnLoginCompleteCommands', charScope, ['/mt use self']);
    r.lc.login();
    expect(r.lc.frame()).toBe('');
    expect(r.mt).toEqual([]);
    expect(r.lc.frame()).toBe('/MT opt list');
    expect(r.mt).toEqual(['/MT opt list']);
    expect(r.lc.frame()).toBe('/tell Mule hi');
    expect(r.lc.frame()).toBe('/a hello');
    expect(r.chat).toEqual(['/tell Mule hi', '/a hello']);
    expect(r.lc.frame()).toBeNull();
    r.lc.loginComplete(0);
    expect(r.lc.frame()).toBe('');
    expect(r.lc.frame()).toBe('/mt use self');
    expect(r.lc.frame()).toBeNull();
  });

  it('periodic: a 20 s timer from Login Complete, each clock minute worked once, character before server', () => {
    const r = rig();
    writeMtCommands(r.s, 'PeriodicCommands', charScope, [{ command: 'char', interval: 2, offset: 0 }]);
    writeMtCommands(r.s, 'PeriodicCommands', srvScope, [{ command: 'srv', interval: 1, offset: 0 }]);
    r.lc.tick(30000, 10); // before Login Complete: nothing
    expect(r.lc.pending).toBe(0);
    r.lc.loginComplete(0);
    r.lc.frame(); // the placeholder
    r.lc.tick(19999, 10);
    expect(r.lc.pending).toBe(0);
    r.lc.tick(20000, 10);
    expect([r.lc.frame(), r.lc.frame(), r.lc.frame()]).toEqual(['char', 'srv', null]);
    r.lc.tick(40000, 10); // the same minute again: nothing
    expect(r.lc.pending).toBe(0);
    r.lc.tick(60000, 11);
    expect([r.lc.frame(), r.lc.frame()]).toEqual(['srv', null]);
    r.lc.logout();
    r.lc.tick(200000, 12);
    expect(r.lc.pending).toBe(0);
  });
});

// ─── One-touch heal, death, login ────────────────────────────────────

describe('One-touch heal (§9.5)', () => {
  const base = { health: 50, maxHealth: 100, healingTrained: true, healingSkill: 150, inCombat: false, kits: [], food: [] };
  it('nothing at full health or with nothing to use', () => {
    expect(mtOneTouchHeal({ ...base, health: 100 })).toEqual({ kind: 'none', reason: 'full' });
    expect(mtOneTouchHeal(base)).toEqual({ kind: 'none', reason: 'nothing' });
  });
  it('the appraised kit with the fewest uses; else the first kit, asking for its appraisal', () => {
    const kits = [{ id: 1, name: 'Kit A', appraised: false }, { id: 2, name: 'Kit B', appraised: true, boost: 10, usesLeft: 20 }, { id: 3, name: 'Kit C', appraised: true, boost: 10, usesLeft: 5 }];
    expect(mtOneTouchHeal({ ...base, kits })).toMatchObject({ kind: 'kit', id: 3, appraise: false, required: 100, chance: 160 });
    expect(mtOneTouchHeal({ ...base, kits: [kits[0]!] })).toMatchObject({ kind: 'kit', id: 1, appraise: true });
  });
  it('kit when required < skill + boost (2× peace, ceil 2.6× combat), else healing food; kit anyway with no food', () => {
    const kits = [{ id: 1, name: 'Kit', appraised: true, boost: 20, usesLeft: 5 }];
    const food = [{ id: 7, name: 'Apple' }, { id: 8, name: 'Cooked Meat' }, { id: 9, name: 'Healing Elixir' }];
    // missing 50: peace needs 100 < 170 → kit; combat needs ceil(130) = 130 < 170 → kit.
    expect(mtOneTouchHeal({ ...base, kits, food })).toMatchObject({ kind: 'kit' });
    // missing 70 in combat: ceil(182) = 182 ≥ 170 → food (the first whose name has Heal or Meat).
    expect(mtOneTouchHeal({ ...base, health: 30, inCombat: true, kits, food })).toEqual({ kind: 'food', id: 8 });
    // missing 85, peace: 170 is not < 170 → food.
    expect(mtOneTouchHeal({ ...base, health: 15, kits, food })).toEqual({ kind: 'food', id: 8 });
    expect(mtOneTouchHeal({ ...base, health: 15, kits, food: [{ id: 7, name: 'Apple' }] })).toMatchObject({ kind: 'kit', id: 1 });
    // Healing untrained: kits are never used.
    expect(mtOneTouchHeal({ ...base, healingTrained: false, kits, food })).toEqual({ kind: 'food', id: 8 });
    expect(mtOneTouchHeal({ ...base, healingTrained: false, kits })).toEqual({ kind: 'none', reason: 'nothing' });
  });
});

describe('Log out on death, open main pack on login (§9.6, §9.7)', () => {
  it('follow their options and defaults', () => {
    const o = new MtOptions(memStore());
    expect(mtLogOutOnDeath(o, true)).toBe(false);
    expect(mtOpenMainPackOnLogin(o)).toBe(true);
    o.set('Misc.LogOutOnDeath', true);
    o.set('Misc.OpenMainPackOnLogin', false);
    expect(mtLogOutOnDeath(o, true)).toBe(true);
    expect(mtLogOutOnDeath(o, false)).toBe(false);
    expect(mtOpenMainPackOnLogin(o)).toBe(false);
  });
});

// ─── Chat filters ────────────────────────────────────────────────────

describe('Chat filters (§9.8)', () => {
  const ME = 'Hero';
  const f = new MtChatFilter({ me: () => ME });
  const all = new Set<MtFilterField>(MT_FILTER_FIELDS);
  const sys = (text: string, type: number = ChatMessageType.Broadcast): MtChatLine => ({ text, type });
  const only = (field: MtFilterField) => new Set<MtFilterField>([field]);
  const pk = (code: number, v: string) => formatWeenieErrorWithString(code, v);

  /** Our client's own lines, each with the filter that must hide it. */
  const cases: Array<[MtFilterField, MtChatLine]> = [
    ['AttackEvades', evasionAttackerLine('Drudge Skulker')],
    ['DefenseEvades', evasionDefenderLine('Drudge Skulker')],
    ['AttackResists', sys('Drudge Skulker resists your spell', ChatMessageType.Magic)],
    ['DefenseResists', sys('You resist the spell cast by Drudge Skulker', ChatMessageType.Magic)],
    ['DefenseResists', sys(pk(WeenieErrorWithString.YouHaveNoTargetsForSpellOf_, 'Bob'))],
    ['DefenseResists', sys(pk(WeenieErrorWithString.YouAreInvalidTargetForSpellOf_, 'Bob'))],
    ['DefenseResists', sys('Bob tried to cast a spell on you, but was too far away!')],
    ['NPKFails', sys(pk(WeenieErrorWithString.YouFailToAffect_YouAreNotPK, 'Bob'))],
    ['NPKFails', sys(pk(WeenieErrorWithString._FailsToAffectYou_TheyAreNotPK, 'Bob'))],
    ['DirtyFighting', sys('Dirty Fighting! Hero delivers a Bleeding Assault to Drudge Skulker!', ChatMessageType.CombatSelf)],
    ['MonsterDeaths', sys(MT_KILL_TEMPLATES.find((k) => k === 'You killed {0}!')!.replace('{0}', 'Drudge Skulker'), ChatMessageType.CombatSelf)],
    ['SpellCastFizzles', sys(weenieErrorText(0x0402)!, ChatMessageType.Magic)],
    ['CompUsage', sys('The spell consumed the following components: Lead Scarab, Hyssop', ChatMessageType.Magic)],
    ['SpellExpires', sys(enchantmentExpiredLine(2, 'Strength Self I')!, ChatMessageType.Magic)],
    ['HealingKitSuccess', sys('You heal yourself for 34 Health points. Your Healing Kit has 9 uses left.')],
    ['HealingKitSuccess', sys('You expertly heal yourself for 70 Health points. Your Healing Kit has 9 uses left.')],
    ['HealingKitFail', sys('You fail to heal yourself. Your Healing Kit has 8 uses left.')],
    ['Salvaging', sys(salvageResultChatLines('Salvaging', [{ material: 'Iron', units: 5, workmanship: 6 }], 0)[0]!, ChatMessageType.Salvaging)],
    ['SalvagingFails', sys(salvageResultChatLines('Salvaging', [], 0)[0]!, ChatMessageType.Salvaging)],
    ['SalvagingFails', sys('The following were not suitable for salvaging: Leather Cap.')],
    ['AuraOfCraftman', sys('Your Aura of the Craftman augmentation increased your skill by 5!')],
    ['ManaStoneUsage', sys('The Mana Stone gives 4,496 points of mana to the following items: Qafiya, Ring.')],
    ['ManaStoneUsage', sys('You need 2,232 more mana to fully charge your items.')],
    ['ManaStoneUsage', sys('The Mana Stone drains 5,253 points of mana from the Wand.')],
    ['ManaStoneUsage', sys('The Wand is destroyed.')],
    ['FailedAssess', sys('Bob tried and failed to assess you!', ChatMessageType.Appraisal)],
    ['KillTaskComplete', sys('You have killed 20 Drudge Skulkers! Your task is complete!')],
    ['AllMasterArbitratorChat', sys('Your fellowship is now locked. If you leave, you have 15 minutes to be recruited back.')],
  ];

  it.each(cases)('%s hides %o', (field, line) => {
    expect(f.hides(line, only(field))).toBe(field);
    expect(f.hides(line, new Set())).toBeNull();
  });

  it('a filter hides only its own lines', () => {
    for (const [field, line] of cases) {
      const others = new Set(MT_FILTER_FIELDS.filter((x) => x !== field && !x.startsWith('StatusText')));
      // Monster deaths, Mana Stone and the fizzle overlap nothing else; every line has exactly its own filter.
      expect(f.hides(line, others), `${field}: ${line.text}`).toBeNull();
    }
  });

  it('Spell Expires keeps the rare buffs', () => {
    for (const w of ['Brilliance', 'Prodigal Strength', 'Spectral Blood Drinker']) expect(f.hides(sys(`${w} has expired.`), all)).toBeNull();
    expect(f.hides(sys('Your enchantments have expired.'), only('SpellExpires'))).toBe('SpellExpires');
  });

  it('text filters skip speech', () => {
    const say = formatSpeechLine('Bob', 'Drudge evaded your attack.', false);
    expect(f.hides({ text: say, type: ChatMessageType.Speech, speech: { kind: 'say', sender: 'Bob', message: 'Drudge evaded your attack.', senderClass: 'player' } }, all)).toBeNull();
    expect(f.hides({ text: 'Bob tells you, "You evaded the drudge!"', type: ChatMessageType.Tell }, all)).toBeNull();
  });

  it('spell words: mine and other players\', by the Spellcasting type', () => {
    const mine: MtChatLine = { text: formatSpeechLine(ME, 'Zojak Malar', true), type: ChatMessageType.Spellcasting, speech: { kind: 'say', sender: ME, message: 'Zojak Malar', self: true } };
    const theirs: MtChatLine = { text: formatSpeechLine('Bob', 'Zojak Malar', false), type: ChatMessageType.Spellcasting, speech: { kind: 'say', sender: 'Bob', message: 'Zojak Malar', senderClass: 'player' } };
    expect(f.hides(mine, only('SpellCastingMine'))).toBe('SpellCastingMine');
    expect(f.hides(mine, only('SpellCastingOthers'))).toBeNull();
    expect(f.hides(theirs, only('SpellCastingOthers'))).toBe('SpellCastingOthers');
    expect(f.hides(theirs, only('SpellCastingMine'))).toBeNull();
    // Plain speech with the same words is not an incantation.
    expect(f.hides({ ...theirs, type: ChatMessageType.Speech }, all)).toBeNull();
    // A host can say what an incantation is (a server that sends them as speech).
    const g = new MtChatFilter({ me: () => ME, isSpellWords: (l) => l.speech?.message === 'Zojak Malar' });
    expect(g.hides({ ...theirs, type: ChatMessageType.Speech }, only('SpellCastingOthers'))).toBe('SpellCastingOthers');
  });

  it('Trade/Buff Bot Spam: a player say ending -t-" or -b-", an emote ending -t- or -b-', () => {
    const bot = (msg: string, senderClass: 'player' | 'npc' = 'player'): MtChatLine => ({ text: formatSpeechLine('Bot', msg, false), type: ChatMessageType.Speech, speech: { kind: 'say', sender: 'Bot', message: msg, senderClass } });
    expect(f.hides(bot('Buffs here -b-'), only('TradeBuffBotSpam'))).toBe('TradeBuffBotSpam');
    expect(f.hides(bot('WTS gems -t-'), only('TradeBuffBotSpam'))).toBe('TradeBuffBotSpam');
    expect(f.hides(bot('WTS gems -t- now'), only('TradeBuffBotSpam'))).toBeNull();
    expect(f.hides(bot('-b-', 'npc'), only('TradeBuffBotSpam'))).toBeNull();
    expect(f.hides({ text: 'Bot is open for business -t-', type: ChatMessageType.Emote, speech: { kind: 'emote', sender: 'Bot', message: 'is open for business -t-' } }, only('TradeBuffBotSpam'))).toBe('TradeBuffBotSpam');
  });

  it('Vendor Tells, Monster Tells, NPC Chatter by the sender\'s class', () => {
    const tell = (senderClass: 'vendor' | 'monster' | 'npc' | 'player'): MtChatLine => ({ text: `X tells you, "hi"`, type: ChatMessageType.Tell, speech: { kind: 'tell', sender: 'X', message: 'hi', senderClass } });
    const say = (senderClass: 'npc' | 'player'): MtChatLine => ({ text: formatSpeechLine('X', 'hi', false), type: ChatMessageType.Speech, speech: { kind: 'say', sender: 'X', message: 'hi', senderClass } });
    expect(f.hides(tell('vendor'), only('VendorTells'))).toBe('VendorTells');
    expect(f.hides(tell('monster'), only('MonsterTell'))).toBe('MonsterTell');
    expect(f.hides(tell('npc'), all)).toBeNull();
    expect(f.hides(tell('player'), all)).toBeNull();
    expect(f.hides(say('npc'), only('NpcChatter'))).toBe('NpcChatter');
    expect(f.hides(say('player'), all)).toBeNull();
    expect(f.hides(tell('vendor'), only('NpcChatter'))).toBeNull();
  });

  it('Master Arbitrator: the spam phrases, or everything', () => {
    const maTell = (msg: string): MtChatLine => ({ text: `Master Arbitrator tells you, "${msg}"`, type: ChatMessageType.Tell, speech: { kind: 'tell', sender: 'Master Arbitrator', message: msg, senderClass: 'npc' } });
    const maSay = (msg: string): MtChatLine => ({ text: `Master Arbitrator says, "${msg}"`, type: ChatMessageType.Speech, speech: { kind: 'say', sender: 'Master Arbitrator', message: msg, senderClass: 'npc' } });
    expect(f.hides(maTell('You shall be known as a champion.'), only('MasterArbitratorSpam'))).toBe('MasterArbitratorSpam');
    expect(f.hides(maTell('Use the the key wisely.'), only('MasterArbitratorSpam'))).toBe('MasterArbitratorSpam');
    expect(f.hides(maSay("Don't forget your prize."), only('MasterArbitratorSpam'))).toBe('MasterArbitratorSpam');
    expect(f.hides(maSay('You shall be known'), only('MasterArbitratorSpam'))).toBeNull(); // a tell phrase, said
    expect(f.hides(maSay('Welcome.'), only('MasterArbitratorSpam'))).toBeNull();
    expect(f.hides(maSay('Welcome.'), only('AllMasterArbitratorChat'))).toBe('AllMasterArbitratorChat');
    // No packet info: the line's own start.
    expect(f.hides({ text: 'Master Arbitrator tells you, "Take this knowledge"', type: ChatMessageType.Tell }, only('MasterArbitratorSpam'))).toBe('MasterArbitratorSpam');
  });

  it('Monster Deaths only for my kills', () => {
    expect(f.hides(sys('Bob killed Drudge Skulker!'), only('MonsterDeaths'))).toBeNull();
    expect(f.hides(sys('You smite Drudge Skulker mightily!'), only('MonsterDeaths'))).toBe('MonsterDeaths');
  });

  it('status-bar text', () => {
    expect(mtHidesStatusText("You're too busy!", only('StatusTextYoureTooBusy'))).toBe('StatusTextYoureTooBusy');
    expect(mtHidesStatusText("You're too busy!!", only('StatusTextYoureTooBusy'))).toBeNull();
    expect(mtHidesStatusText('Casting Strength Self I', only('StatusTextCasting'))).toBe('StatusTextCasting');
    expect(mtHidesStatusText('Anything', only('StatusTextAll'))).toBe('StatusTextAll');
    expect(mtHidesStatusText('Anything', new Set())).toBeNull();
  });

  it('the enabled set comes from the options (all off by default)', () => {
    const o = new MtOptions(memStore());
    expect(mtEnabledFilters(o).size).toBe(0);
    o.set('Filters.NpcChatter', true);
    expect([...mtEnabledFilters(o)]).toEqual(['NpcChatter']);
  });
});
