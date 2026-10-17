/**
 * Stream 2026-10-17: Claude Arcanist died at 18:48:02Z in the Tusker Liberator dungeon (landblock 0x5B47) and lost
 * "1,780 Pyreals, your Studded Leather Greaves, and your Gloves". The supervisor restarted at 18:48:45Z (a new
 * session), so the 18:49Z opening's death tally was empty and nothing said where the corpse was or when it would rot;
 * his own report said the greaves and gloves "need replacing", though they were spares from his pack (his 17:09Z plan
 * listed both as junk to sell, and his 18:49Z `gear` showed Platemail Leggings and Leather Gauntlets worn). He said
 * "Skip my corpse" and the pair went to L60 to L80 Viamontians at L46 to L48; both died at 19:18:37Z and 19:19:13Z.
 * Jake: "they also should be prioritizing getting their corpses and never going without gear, even if they have to
 * replace it".
 *
 * Driven through the real builders: corpses.ts (the opening's corpse facts from the feed), own-time.ts loadOwnTime
 * (the supervisor's read that carries them), prompt.ts readinessBrief / segmentOpening / systemPrompt, gear.ts
 * formatGear, and AgentApi on the fake host (observe's `your corpses:` line, kept across page reloads).
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { itemsText } from '../packages/renderer/src/agent/deathLines.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { formatGear } from '../packages/renderer/src/agent/gear.ts';
import type { AgentItem } from '../packages/renderer/src/agent/types.ts';
import { HOSTED_GUIDE } from '../tools/ac-agent/hostedGuide.ts';
import { corpseBlock, corpseFacts, corpseRotMs, loadCorpses } from '../tools/stream/corpses.ts';
import type { FeedEvent } from '../tools/stream/feed-types.ts';
import { loadOwnTime } from '../tools/stream/own-time.ts';
import { readinessBrief, segmentOpening, systemPrompt } from '../tools/stream/prompt.ts';
import { parseStreamConfig } from '../tools/stream/config.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const T_DEATH = Date.parse('2026-10-17T18:48:02.311Z');
const T_OPEN = Date.parse('2026-10-17T18:49:00.371Z');
const clock = (ms: number): string => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

const status = (t: number, location: string, level = 48): FeedEvent => ({
  v: 1, t, type: 'status', char: 'mage', name: 'Claude Arcanist', level,
  health: { cur: 18, max: 170 }, stamina: { cur: 1, max: 222 }, mana: { cur: 198, max: 335 }, xp: { total: 49289642, toNext: 1727830 }, location, goal: null,
} as FeedEvent);
const chat = (t: number, text: string): FeedEvent => ({ v: 1, t, type: 'chat', char: 'mage', channel: 'system', text } as FeedEvent);

/** The feed's rows around the 18:48Z death, as written then (feed.jsonl lines 256000–256030). */
const tuskerDeath = (): FeedEvent[] => [
  status(T_DEATH - 4400, 'indoors (0x5B470172)'),
  chat(T_DEATH, "You are utterly destroyed by Tusker Liberator's attack!"),
  { v: 1, t: T_DEATH, type: 'death', char: 'mage', text: "You are utterly destroyed by Tusker Liberator's attack!", killer: 'Tusker Liberator' } as FeedEvent,
  chat(T_DEATH + 2040, "You've lost 1,780 Pyreals, your Studded Leather Greaves, and your Gloves!"),
  status(T_DEATH + 10_000, '42.1N, 33.6E'),
];

describe('the opening\'s corpse facts (corpses.ts, from the feed)', () => {
  it('rot time is ACE Corpse.RecalculateDecayTime: max(1 h, level × 5 min)', () => {
    expect(corpseRotMs(48)).toBe(4 * 3600_000);
    expect(corpseRotMs(5)).toBe(3600_000);
    expect(corpseRotMs(80)).toBe(400 * 60_000);
  });

  it('the 18:48Z dungeon death: where (landblock and cell), what is on it, coins destroyed, when it rots', () => {
    const facts = corpseFacts(tuskerDeath(), 'Claude Arcanist', T_OPEN);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({ killer: 'Tusker Liberator', location: 'indoors (0x5B470172)', items: ['Studded Leather Greaves', 'Gloves'], pyreals: 1780, rotsAt: T_DEATH + 4 * 3600_000, openedAt: null });
    const block = corpseBlock(facts, T_OPEN)!;
    expect(block.split('\n')[0]).toMatch(/^Your corpses \(a player corpse with items lasts max\(1 h, level × 5 min\) on ACE/);
    expect(block).toContain(`- corpse from your death at ${clock(T_DEATH)} (Tusker Liberator), indoors (landblock 0x5B47), cell 0x5B470172 (a walk_to target from inside): on it Studded Leather Greaves, Gloves (the 1,780 pyreals you lost are destroyed, not on it); rots at about ${clock(T_DEATH + 4 * 3600_000)}, 3 h 59 min from now`);
  });

  it('outdoors the corpse line\'s spot; ROTTED once past its time; a coins-only death leaves nothing; an opened corpse is said, then dropped', () => {
    const t0 = Date.parse('2026-10-17T15:07:00Z');
    const evs: FeedEvent[] = [
      status(t0 - 3000, '0.4S, 95.7E', 44),
      { v: 1, t: t0, type: 'death', char: 'mage', killer: 'Tusker Redeemer' } as FeedEvent,
      chat(t0 + 2000, "You've lost 187 Pyreals, your Ring, your Aquamarine, and your Chainmail Leggings!"),
      chat(t0 + 2100, 'Your corpse is located at (0.3S, 95.6E).'),
      // Coins only: ACE destroys them (corpse_destroy_pyreals), the corpse is empty and rots in 15 s.
      { v: 1, t: t0 + 600_000, type: 'death', char: 'mage', killer: 'Drudge' } as FeedEvent,
      chat(t0 + 602_000, "You've lost 50 Pyreals!"),
    ];
    const rot = t0 + corpseRotMs(44);
    const live = corpseBlock(corpseFacts(evs, 'Claude Arcanist', t0 + 3600_000), t0 + 3600_000)!;
    expect(live.split('\n')).toHaveLength(2);
    expect(live).toContain('outdoors at 0.3S, 95.6E: on it Ring, Aquamarine, Chainmail Leggings (the 187 pyreals you lost are destroyed, not on it); rots at about');
    const late = corpseBlock(corpseFacts(evs, 'Claude Arcanist', rot + 17 * 60_000), rot + 17 * 60_000)!;
    expect(late).toContain(`ROTTED at ${clock(rot)}, 17 min ago: what was on it is gone, so replace any of it you wore`);
    // Two hours past its rot: no longer mentioned.
    expect(corpseFacts(evs, 'Claude Arcanist', rot + 2 * 3600_000 + 60_000)).toEqual([]);
    // Opened (an ac_loot of your own corpse in that landblock): said for 10 min, then counted as fetched.
    const opened = [...evs, { v: 1, t: t0 + 1200_000, type: 'tool', char: 'mage', tool: 'ac_loot', summary: 'loots Corpse of Claude Arcanist' } as FeedEvent];
    expect(corpseBlock(corpseFacts(opened, 'Claude Arcanist', t0 + 1500_000), t0 + 1500_000)).toContain(`you opened a corpse of yours there at ${clock(t0 + 1200_000)}`);
    expect(corpseFacts(opened, 'Claude Arcanist', t0 + 1200_000 + 11 * 60_000)).toEqual([]);
    // Another character's corpse opened is not yours.
    const theirs = [...evs, { v: 1, t: t0 + 1200_000, type: 'tool', char: 'mage', tool: 'ac_loot', summary: 'loots Corpse of Claude Bulwark' } as FeedEvent];
    expect(corpseFacts(theirs, 'Claude Arcanist', t0 + 1500_000)[0].openedAt).toBeNull();
  });

  it('the supervisor\'s ownTime read (loadOwnTime) carries the block across a restart, and the opening shows it under readiness', () => {
    const dir = mkdtempSync(join(tmpdir(), 'acjs-corpse-'));
    try {
      const feedFile = join(dir, 'feed.jsonl');
      writeFileSync(feedFile, [...tuskerDeath(), { v: 1, t: T_DEATH + 40_000, type: 'session-start', title: 'restart' }].map((e) => JSON.stringify(e)).join('\n') + '\n');
      const block = loadCorpses({ feedFile, profile: 'mage', character: 'Claude Arcanist', nowMs: T_OPEN })!;
      expect(block).toContain('on it Studded Leather Greaves, Gloves');
      // No segments.jsonl here (the own-time half is null): the corpse block alone, as the supervisor calls it.
      const own = loadOwnTime({ streamDir: dir, feedFile, profile: 'mage', character: 'Claude Arcanist', cast: ['Claude Arcanist', 'Claude Bulwark'], nowMs: T_OPEN });
      expect(own).toBe(block);
      // Another profile's feed rows are not this one's corpses.
      expect(loadOwnTime({ streamDir: dir, feedFile, profile: 'soldier', character: 'Claude Bulwark', cast: [], nowMs: T_OPEN })).toBeNull();
      const cfg = parseStreamConfig(JSON.parse(readFileSync('tools/stream/cast.json', 'utf8')));
      const opening = segmentOpening({
        c: cfg.characters[0], partner: 'Claude Bulwark', segment: 1, nowMs: T_OPEN, playMinutes: 75, journal: '', lastReport: null,
        readiness: 'Your readiness right now (`./ac gear`, `./ac character`, `./ac inventory` for the whole picture):\n- gear: armor on every body part', ownTime: own,
      });
      expect(opening).toContain('- gear: armor on every body part\nYour corpses (');
      expect(opening.indexOf('Your corpses')).toBeLessThan(opening.indexOf('Your journal:'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

// EquipMask (ACE EquipMask.cs) and CoverageMask (ACE CoverageMask.cs).
const BREAST = 0x200, GIRTH = 0x400, PAULDRONS = 0x800, BRACERS = 0x1000, LEGGINGS = 0x2000 | 0x4000;
/** Arcanist's paperdoll at 18:49Z (his `gear` then), with the 19:18Z death's bracelets on his wrists. */
const arcanistWorn = (): AgentItem[] => [
  { guid: 0x80003126, name: 'Pathwarden Helm', where: 'equipped', mask: 0x1, coverage: 0x4000 },
  { guid: 0x8000313c, name: 'Baggy Shirt', where: 'equipped', mask: 0x2 | 0x8 | 0x10, coverage: 0x8 | 0x20 | 0x40 },
  { guid: 0x80000879, name: 'Platemail Breastplate', where: 'equipped', mask: BREAST, coverage: 0x400 },
  { guid: 0x80003273, name: 'Trousers', where: 'equipped', mask: 0x4 | 0x40 | 0x80, coverage: 0x10 | 0x2 | 0x4 },
  { guid: 0x80000b86, name: 'Platemail Girth', where: 'equipped', mask: GIRTH, coverage: 0x800 },
  { guid: 0x80000d2c, name: 'Platemail Pauldrons', where: 'equipped', mask: PAULDRONS, coverage: 0x1000 },
  { guid: 0x800083a9, name: 'Leather Bracers', where: 'equipped', mask: BRACERS, coverage: 0x2000 },
  { guid: 0x80006735, name: 'Leather Gauntlets', where: 'equipped', mask: 0x20, coverage: 0x8000 },
  { guid: 0x800008b0, name: 'Platemail Leggings', where: 'equipped', mask: LEGGINGS, coverage: 0x100 | 0x200 },
  { guid: 0x800062f3, name: 'Leather Boots', where: 'equipped', mask: 0x100, coverage: 0x10000 },
  { guid: 0x8000c371, name: 'Heavy Bracelet', where: 'equipped', mask: 0x10000 },
  { guid: 0x8000c68d, name: 'Heavy Bracelet', where: 'equipped', mask: 0x20000 },
  { guid: 0x80004d22, name: 'Ring', where: 'equipped', mask: 0x40000 },
  { guid: 0x8000796b, name: 'Ring', where: 'equipped', mask: 0x80000 },
  { guid: 0x8000b535, name: 'Wand', where: 'equipped', mask: 0x1000000, itemType: 0x8000 },
  { guid: 0x8000e760, name: 'Heavy Bracelet', where: 'main pack', validLocations: 0x30000 },
  { guid: 0x8000be3f, name: 'Steel Toed Boots', where: 'main pack', validLocations: 0x100, coverage: 0x10000 },
];

describe('gear gaps stay loud: by name in the opening and at the top of `gear`', () => {
  it('his 18:49Z gear: armor on every body part (the lost greaves and gloves were spares), the bare neck named', () => {
    const r = readinessBrief({ items: arcanistWorn(), sheet: null, session: null })!;
    expect(r).toContain('\n- gear: armor on every body part\n- gear: no jewelry on: neck\n');
    expect(r).not.toMatch(/nothing worn|clothing only/);
  });

  it('after 19:18Z (both worn bracelets and the pack boots lost): the wrists named; a bare part and a shirt-only chest named', () => {
    const after = arcanistWorn().filter((i) => !(i.name === 'Heavy Bracelet' || i.name === 'Steel Toed Boots'));
    expect(readinessBrief({ items: after, sheet: null, session: null })).toContain('- gear: no jewelry on: neck, wrists\n');
    const stripped = after.filter((i) => i.name !== 'Leather Gauntlets' && i.name !== 'Platemail Breastplate');
    const text = formatGear(stripped);
    expect(text.split('\n')[0]).toBe('gaps: nothing worn: no gloves (hands); clothing only, no armor over it: chest; no jewelry on: neck, wrists');
    const r = readinessBrief({ items: stripped, sheet: null, session: null })!;
    expect(r).toContain('- gear: nothing worn: no gloves (hands)\n- gear: clothing only, no armor over it: chest\n- gear: no jewelry on: neck, wrists');
    expect(r).not.toContain('armor on every body part');
  });

  it('`gear` ends with the corpses line the page gives', () => {
    expect(formatGear(arcanistWorn(), { corpses: 'your corpses: from your death 1 min ago …' }).split('\n').pop()).toBe('your corpses: from your death 1 min ago …');
    expect(itemsText(['Steel Toed Boots', 'Heavy Bracelet', 'Heavy Bracelet', 'Heavy Bracelet'])).toBe('Steel Toed Boots, Heavy Bracelet ×3');
  });
});

describe('observe\'s corpses line (AgentApi on the fake host)', () => {
  let host: FakeHost;
  let wall = 0;
  let store: Map<string, string>;
  const DUNGEON = 0x5b470172;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    store = new Map();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    host = new FakeHost();
    host.me.name = 'Claude Arcanist';
    host.me.level = 48;
    host.me.health = { current: 170, max: 170 };
    wall = T_DEATH - 60_000;
    host.wallClock = () => wall + host.t;
    host.inv = [
      ...arcanistWorn(),
      { guid: 0x80000379, name: 'Studded Leather Greaves', where: 'main pack', validLocations: 0x4000 },
      { guid: 0x80000380, name: 'Gloves', where: 'main pack', validLocations: 0x20 },
    ];
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });

  const die = (api: AgentApi, victim: string, loss: string, drop: string[], corpseLine?: string): void => {
    api.pushChat(victim, 0x15);
    host.me.dead = true;
    host.me.health = { current: 0, max: 170 };
    run(api, host, 200, { physics: false });
    // The corpse takes the dropped items out of your inventory after the death animation (ACE Player_Death.Die).
    for (const n of drop) { const i = host.inv.findIndex((x) => x.name === n); if (i >= 0) host.inv.splice(i, 1); }
    api.pushChat(loss, 0);
    if (corpseLine) api.pushChat(corpseLine, 0);
    run(api, host, 2000, { physics: false });
    host.me.dead = false;
    host.me.health = { current: 170, max: 170 };
    run(api, host, 200, { physics: false });
  };

  it('the 18:48Z death in a dungeon: where, which lost items were worn (none), time left; then in view, then gone when looted', () => {
    host.me.cell = DUNGEON;
    const api = new AgentApi(host);
    expect(formatObservation(api.observe())).not.toMatch(/your corpses/);
    die(api, "You are utterly destroyed by Tusker Liberator's attack!", "You've lost 1,780 Pyreals, your Studded Leather Greaves, and your Gloves!", ['Studded Leather Greaves', 'Gloves']);
    const line = api.observe().corpses!;
    expect(line).toBe('your corpses: from your death 1 min ago (Tusker Liberator) inside landblock 0x5B47, cell 0x5B470172: Studded Leather Greaves, Gloves (all from your pack, none worn); rots in about 4 h');
    expect(formatObservation(api.observe())).toContain(line);
    // The corpse comes into view in that landblock: said; then it leaves while in view (looted empty): GONE.
    host.add({ guid: 0x8000f001, name: 'Corpse of Claude Arcanist', cell: DUNGEON, x: 10, y: 10, objectDescFlags: 0x2000 });
    expect(api.observe().corpses).toMatch(/rots in about 4 h \(in view now\)$/);
    host.objs.delete(0x8000f001);
    run(api, host, 60_000, { physics: false });
    expect(api.observe().corpses).toMatch(/; GONE 1 min ago \(left your view: looted empty, or rotted\)$/);
    expect((api.surface() as Record<string, () => unknown>).corpses()).toBe(api.corpsesLine());
  });

  it('19:18Z outdoors, worn bracelets lost: named as worn, the corpse line\'s spot; kept across a page reload; ROTTED after level × 5 min', () => {
    host.me.cell = 0xa9b40019;
    const api = new AgentApi(host);
    die(api, 'The thunder of Viamontian Footman crushing Claude Arcanist is followed by the deafening silence of your death!',
      "You've lost 890 Pyreals, your Steel Toed Boots, your Heavy Bracelet, your Heavy Bracelet, and your Heavy Bracelet!",
      ['Steel Toed Boots', 'Heavy Bracelet', 'Heavy Bracelet', 'Heavy Bracelet'], 'Your corpse is located at (42.1N, 33.6E).');
    expect(api.observe().corpses).toBe('your corpses: from your death 1 min ago (Viamontian Footman) outdoors at 42.1N, 33.6E (landblock 0xA9B4): Steel Toed Boots, Heavy Bracelet ×3 (worn when you died: Heavy Bracelet ×2; the rest from your pack); rots in about 4 h');
    // The stream reloads the page every segment: a new AgentApi reads the corpse back from browser storage.
    wall += 30 * 60_000;
    const next = new AgentApi(host);
    expect(next.observe().corpses).toMatch(/^your corpses: from your death 30 min ago \(Viamontian Footman\) outdoors at 42\.1N, 33\.6E .*rots in about 3 h 30 min$/);
    // Not in this client after the reload: not "gone" (it was never seen here).
    expect(next.observe().corpses).not.toContain('GONE');
    wall += 4 * 3600_000;
    expect(next.observe().corpses).toMatch(/ROTTED 30 min ago: what was on it is gone for good$/);
    wall += 2 * 3600_000;
    expect(next.observe().corpses).toBeUndefined();
  });

  it('a death that dropped only coins leaves no corpse to fetch (ACE destroys them; the empty corpse rots in 15 s)', () => {
    const api = new AgentApi(host);
    die(api, 'Drudge Skulker beats you to a lifeless pulp!', "You've lost 50 Pyreals!", []);
    expect(api.observe().corpses).toBeUndefined();
  });
});

describe('the rule, in the brief and the guides', () => {
  it('corpse first, together and buffed; if it can\'t be reached or rotted, replace the gear; never hunt with a gear gap', () => {
    const cfg = parseStreamConfig(JSON.parse(readFileSync('tools/stream/cast.json', 'utf8')));
    const sys = systemPrompt(readFileSync('tools/stream/brief.md', 'utf8'), cfg.characters[0], 'Claude Bulwark');
    expect(sys).toContain('**After a death, your corpse comes first:** go back for it together, buffed, before anything else');
    expect(sys).toContain('never hunt with a gear gap');
    expect(sys).toContain('regroup at the lifestone, rebuff and fetch the corpse together');
    expect(HOSTED_GUIDE).toContain('After a death your corpse comes first');
    expect(HOSTED_GUIDE).toContain('never fight with a gear gap');
    expect(readFileSync('.claude/skills/play/SKILL.md', 'utf8')).toContain('never fight with a gear gap');
  });
});
