/**
 * The stream players' reports of 2026-10-16 13:25 UTC (end-of-retail local ACE, segment 12:55–13:25, build
 * ed7114f3 / 71a232b9; reports stream/reports/{mage,soldier}-2026-10-16T13-25-*-seg2.md, transcripts
 * stream/sessions/{mage,soldier}-2026-10-16-seg2.jsonl, page logs mage.log / soldier.log):
 *  1. `vendor target=` at Shopkeeper Renald the Elder (UseRadius 5) answered "Welcome! … Thank you for your business.
 *     Please return soon. … you are still 7.0 m from" twice: the shop opened and shut as Bulwark stood at the edge of
 *     its reach (ACE Vendor.CheckClose). A vendor use that leaves you off at its edge with no shop open walks up and
 *     uses it again (ac_use and ac_vendor target= share it).
 *  2. After the Holtburg portal, `wait types=portal` answered at once with the last trip's "arrived" and this trip's
 *     "entered portal space", and observe said "screen: portal-space" at Holtburg (the world still fading in): a portal
 *     wait answered only by a trip's start now waits on for its arrival.
 *  3. `follow` stopped every 120 s: with no duration it now runs until the leader has stood beside you 30 s, at most
 *     10 minutes ("still following").
 *  4. A `say` holding "<->" was refused by Claude Code's permission check (its ZSH_NUMERIC_GLOB_RE /<\d*-\d*>/ flags a
 *     zsh numeric-range glob, quoted or not): the brief says so.
 *  5. The Tower Shield's spells stayed off after 288 mana went in: ACE turns a wielded item's spells off at 0 mana
 *     ("Your X is out of Mana.") and back on only on a wield with mana in it. use_on, equip and observe say so.
 *  6. "The Pathwarden Helm can't be dropped": ACE's AttunedItem refusal (Attuned 114, retail's attunement). drop says
 *     why, inventory marks attuned / bonded items and junk leaves them out.
 * Each drives the shipped AgentApi / format code against the fake host (tests/_harness/agentFake.ts).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, giveRefusalHint } from '../packages/renderer/src/agent/AgentApi.ts';
import { filterInventory, formatInventory, formatObservation } from '../packages/renderer/src/agent/format.ts';
import { TOOL_BY_NAME } from '../tools/ac-agent/tools.ts';
import { FakeHost } from './_harness/agentFake.ts';

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) {
    each?.();
    host.t += 100;
    vi.advanceTimersByTime(100);
    host.physics(100);
    api.tick();
    await Promise.resolve(); await Promise.resolve();
  }
  return out;
}

describe('1. a vendor use that leaves you at the edge of its reach walks up and uses it again (Renald, 13:05 UTC)', () => {
  let host: FakeHost;
  let api: AgentApi;
  const RENALD = 0x7a9b4021;
  const window = { name: 'Shopkeeper Renald the Elder', guid: RENALD, currency: 'Pyreals', items: [{ guid: 0x80000f89, name: 'Leather Cap', price: 120 }] };
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    // You at (80, 20); Renald 7 m north (a vendor: ObjectDescriptionFlags Vendor 0x200).
    host.add({ guid: RENALD, name: 'Shopkeeper Renald the Elder', itemType: 0x10, objectDescFlags: 0x200, x: 80, y: 27 });
  });
  afterEach(() => vi.useRealTimers());

  /** ACE: the shop opens within the vendor's reach and shuts (its farewell) once you are farther than 5 m off. */
  const renaldUse = (): void => {
    host.use = (g: number) => {
      host.sent.push(`use ${g.toString(16)}`);
      const o = host.objs.get(RENALD)!;
      const d = Math.hypot(host.me.x - o.x, host.me.y - o.y);
      setTimeout(() => api.pushChat('Shopkeeper Renald the Elder tells you, "Welcome! What\'s your pleasure today?"', 0x0), 300);
      if (d > 5) setTimeout(() => api.pushChat('Shopkeeper Renald the Elder tells you, "Thank you for your business. Please return soon."', 0x0), 1800);
      else setTimeout(() => { host.vendorOpen = window; }, 400);
      return true;
    };
  };

  it('vendor target=: the first use from 7 m shuts again; it walks up, uses it once more, and lists the stock', async () => {
    renaldUse();
    const r = await settle(api, host, api.vendorAt(RENALD), 60_000);
    expect(host.sent.filter((s) => s.startsWith('use'))).toHaveLength(2);
    expect(r?.ok).toBe(true);
    expect(r?.message).toContain('#80000f89 Leather Cap  120');
    expect(Math.hypot(host.me.x - 80, host.me.y - 27)).toBeLessThan(2.5);
  });

  it('ac_use says why it used the vendor twice', async () => {
    renaldUse();
    const r = await settle(api, host, api.use(RENALD), 60_000);
    expect(r?.ok).toBe(true);
    expect(r?.message).toMatch(/vendor window open/);
    expect(r?.message).toMatch(/the first use left you 7\.0 m from Shopkeeper Renald the Elder, at the edge of its reach/);
  });

  it('beside the vendor already: one use, no walk (as before)', async () => {
    host.objs.get(RENALD)!.y = 21;
    renaldUse();
    const r = await settle(api, host, api.vendorAt(RENALD), 30_000);
    expect(host.sent.filter((s) => s.startsWith('use'))).toHaveLength(1);
    expect(r?.ok).toBe(true);
  });
});

describe('2. a portal wait answered only by a trip\'s start waits for its arrival (Holtburg portal, 13:13:53 UTC)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
  });
  afterEach(() => vi.useRealTimers());
  const step = (screen: 'world' | 'portal-space'): void => { host.screenName = screen; host.t += 100; vi.advanceTimersByTime(100); api.tick(); };

  it('the last trip\'s arrival and this trip\'s entry, unread: it waits on and ends with "arrived"', async () => {
    step('world');
    // The Town Network trip, then into the Holtburg portal: neither read by a wait since.
    step('portal-space'); step('world'); step('portal-space');
    let evs: Array<{ type: string; text: string }> | null = null;
    void api.wait({ types: ['portal'] }, 20_000).then((e) => { evs = e; });
    for (let i = 0; i < 20; i++) { step('portal-space'); await Promise.resolve(); }
    expect(evs).toBeNull();
    step('world');
    for (let i = 0; i < 5 && !evs; i++) { await Promise.resolve(); step('world'); }
    const portal = evs!.filter((e) => e.type === 'portal').map((e) => e.text);
    expect(portal.at(-1)).toBe('arrived');
    expect(portal.filter((t) => t === 'entered portal space').length).toBeGreaterThanOrEqual(1);
  });

  it('back in the world already: answers at once, as before', async () => {
    step('world'); step('portal-space'); step('world');
    const evs = await api.wait({ types: ['portal'] }, 20_000);
    expect(evs.map((e) => e.text)).toEqual(['entered portal space', 'arrived']);
  });

  it('observe in portal space says it lasts until the world has faded in where you arrive', () => {
    step('portal-space');
    expect(formatObservation(api.observe())).toMatch(/^screen: portal-space \(until the world has faded in where you arrive: ac_wait types=portal for the arrival\)/);
  });
});

describe('3. follow with no duration runs until the leader stops (Bulwark: "follow stopping every 120 seconds")', () => {
  let host: FakeHost;
  let api: AgentApi;
  const LEADER = 0x500000a3;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.add({ guid: LEADER, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 40 });
  });
  afterEach(() => vi.useRealTimers());

  it('a leader walking 150 s, then stopping: still following at 120 s, ended 30 s after they stood beside you', async () => {
    const r = await settle(api, host, api.follow(LEADER), 400_000, () => {
      const o = host.objs.get(LEADER)!;
      if (host.t < 150_000) o.y += 0.25; // 2.5 m/s north
    });
    expect(r?.ok).toBe(true);
    expect(r?.message).toMatch(/^followed Claude Arcanist for 1[89]\d s, until they stopped: they have stood \d m from you for 3\d s/);
    expect(host.t).toBeGreaterThan(150_000);
  });

  it('a leader who never stops: "still following" at the 10-minute cap', async () => {
    let dir = 1;
    const r = await settle(api, host, api.follow(LEADER), 700_000, () => {
      const o = host.objs.get(LEADER)!;
      o.y += 0.25 * dir;
      if (o.y > 400 || o.y < 40) dir = -dir;
    });
    expect(r?.ok).toBe(true);
    expect(r?.message).toMatch(/^still following Claude Arcanist after 600 s, the longest one follow runs \(they kept moving\); .*ac_follow again to keep going/);
  });

  it('duration_s given: that long, whether they stop or not (as before)', async () => {
    const r = await settle(api, host, api.follow(LEADER, { durationMs: 40_000 }), 60_000);
    expect(r?.message).toMatch(/^followed Claude Arcanist for 40 s; they are \d m/);
  });

  it('ac_follow sends no duration unless duration_s is given', () => {
    const tool = TOOL_BY_NAME.get('ac_follow')!;
    expect(tool.description).toMatch(/until they stop \(they stand beside you 30 s/);
    expect(String((tool.props as Record<string, { description: string }>).duration_s.description)).toMatch(/Default: until they stop beside you/);
  });
});

describe('4. chat text with a zsh numeric-range glob is refused by the permission check: the brief says to avoid it', () => {
  // Claude Code 2.1.301's ZSH_NUMERIC_GLOB_RE ("Contains zsh <N-M> numeric-range glob"): the refused command, 13:24:19.
  const ZSH_NUMERIC_GLOB_RE = /<\d*-\d*>/;
  const brief = readFileSync(join(__dirname, '..', 'tools', 'stream', 'brief.md'), 'utf8');
  it('the refused line matches it; the ones that went through did not', () => {
    expect(ZSH_NUMERIC_GLOB_RE.test('./ac say text="/f Plan: loop Grievvers <-> Sclavus while pumpkin buffs last (~15m)"')).toBe(true);
    expect(ZSH_NUMERIC_GLOB_RE.test('./ac say text="/f RUN rule: me <50%, you <35%, or 3+ on us"')).toBe(false);
    expect(ZSH_NUMERIC_GLOB_RE.test('./ac say text="/f Town Network -> Plateau Village"')).toBe(false);
  });
  it('the brief names the pattern, its examples and what to write instead', () => {
    expect(brief).toMatch(/never put a number range or a dash between `<` and `>` \(`<->`, `<1-5>`\)/);
    for (const ex of ['<->', '<1-5>']) expect(ZSH_NUMERIC_GLOB_RE.test(ex)).toBe(true);
    for (const ok of ['<50%', '->']) expect(ZSH_NUMERIC_GLOB_RE.test(ok)).toBe(false);
  });
});

describe('5. a wielded item out of mana: its mana and its spells, and the re-wield that turns them on (Tower Shield, 13:06 UTC)', () => {
  let host: FakeHost;
  let api: AgentApi;
  const SHIELD = 0x80008329;
  const STONE = 0x8000499b;
  const IMPEN = 1486, BANE = 1468;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.inv = [
      { guid: SHIELD, name: 'Tower Shield', where: 'equipped', slot: 'Shield', itemType: 0x2, uiEffects: 0x1 },
      { guid: STONE, name: 'Mana Stone', where: 'main pack', itemType: 0x80000 },
    ];
    host.appraisalDatas.set(SHIELD, { int: { 107: 0, 108: 1089 }, float: {}, string: {}, bool: {}, did: {}, spells: [], spellIds: [IMPEN, BANE], activeSpellIds: [] });
  });
  afterEach(() => vi.useRealTimers());

  it('"Your Tower Shield is out of Mana." puts it in observe until it is wielded again', async () => {
    api.pushChat('Your Tower Shield is out of Mana.', 0x11);
    expect(formatObservation(api.observe())).toMatch(/gear out of mana \(its spells are off\): Tower Shield #80008329: ac_use_on a charged mana stone on an empty one, then ac_unequip and ac_equip it/);
    host.appraisalDatas.get(SHIELD)!.int[107] = 288;
    host.appraised.push(SHIELD);
    expect(formatObservation(api.observe())).toMatch(/Tower Shield #80008329 \(mana 288\/1089\)/);
  });

  it('use_on the stone: its new mana, its spells OFF, and the unequip / equip that turns them on', async () => {
    api.pushChat('Your Tower Shield is out of Mana.', 0x11);
    host.useWithTarget = (s, t) => {
      host.sent.push(`usewith ${s.toString(16)} ${t.toString(16)}`);
      setTimeout(() => { host.appraisalDatas.get(SHIELD)!.int[107] = 288; api.pushChat('The Mana Stone gives 288 points of mana to the Tower Shield.', 0x0); }, 300);
      return true;
    };
    const r = await settle(api, host, api.useOnReported(STONE, SHIELD), 20_000);
    expect(r?.message).toMatch(/The Mana Stone gives 288 points of mana to the Tower Shield\./);
    expect(r?.message).toMatch(/Tower Shield now: mana 288\/1,089; its spells are OFF: spell 1486, spell 1468/);
    expect(r?.message).toMatch(/turns them back on only when it is wielded again with mana in it: ac_unequip Tower Shield, then ac_equip it/);
  });

  it('use_on a stone on a wielded item whose spells are on: says so, no advice', async () => {
    host.appraisalDatas.get(SHIELD)!.activeSpellIds = [IMPEN, BANE];
    host.useWithTarget = (s, t) => {
      host.sent.push(`usewith ${s.toString(16)} ${t.toString(16)}`);
      setTimeout(() => { host.appraisalDatas.get(SHIELD)!.int[107] = 900; api.pushChat('The Mana Stone gives 288 points of mana to the Tower Shield.', 0x0); }, 300);
      return true;
    };
    const r = await settle(api, host, api.useOnReported(STONE, SHIELD), 20_000);
    expect(r?.message).toMatch(/Tower Shield now: mana 900\/1,089; its spells are on: spell 1486, spell 1468$/);
  });

  it('inventory shows a worn item\'s mana from its appraisal, OUT at 0', () => {
    host.appraised.push(SHIELD);
    expect(formatInventory(api.inventory())).toMatch(/#80008329 Tower Shield {2}\(Shield, .*mana 0\/1,089 OUT: its spells are off/);
  });
});

describe('6. an attuned item: drop says why, and inventory marks it (Pathwarden Helm, 08:53 / 11:56 / 12:57 UTC)', () => {
  let host: FakeHost;
  let api: AgentApi;
  const HELM = 0x80003126;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.inv = [{ guid: HELM, name: 'Pathwarden Helm', where: 'main pack', itemType: 0x2, burden: 600 }];
  });
  afterEach(() => vi.useRealTimers());

  it('the server\'s refusal ("The Pathwarden Helm can\'t be dropped") is explained, and the next drop is refused before sending', async () => {
    let drops = 0;
    host.drop = () => { drops++; setTimeout(() => api.pushChat('The Pathwarden Helm can\'t be dropped', 0x1a), 200); return true; };
    const r = await settle(api, host, api.drop(HELM), 10_000);
    expect(r?.ok).toBe(false);
    expect(r?.message).toMatch(/^not dropped: Pathwarden Helm: The Pathwarden Helm can't be dropped\n {2}\(it is attuned \(bound to you\): the server refuses dropping, giving or trading it, as retail did; it has no value, so no vendor buys it either/);
    const again = await settle(api, host, api.drop(HELM), 10_000);
    expect(again?.message).toMatch(/^not dropped: Pathwarden Helm: it is attuned/);
    expect(drops).toBe(1);
    // Marked, and no longer junk to clear out.
    expect(api.inventory()[0].attuned).toBe(true);
    expect(filterInventory(api.inventory(), 'junk').items).toEqual([]);
  });

  it('known from its appraisal (Attuned 114, Bonded 33): nothing sent, bonded said too, marked in the list', async () => {
    host.appraised.push(HELM);
    host.appraisalDatas.set(HELM, { int: { 33: 1, 114: 1 }, float: {}, string: {}, bool: {}, did: {}, spells: [] });
    let drops = 0;
    host.drop = () => { drops++; return true; };
    const r = await settle(api, host, api.drop(HELM), 10_000);
    expect(drops).toBe(0);
    expect(r?.message).toMatch(/bonded too: you keep it when you die$/);
    expect(formatInventory(api.inventory())).toMatch(/#80003126 Pathwarden Helm {2}\(.*attuned: can't be dropped, given or traded, bonded: kept when you die/);
  });

  it('a give refused as attuned says why', () => {
    expect(giveRefusalHint('The Pathwarden Helm can\'t be dropped')).toMatch(/^it is attuned \(bound to you\)/);
  });
});
