/**
 * Stream day 2026-10-14 (Jake: "as they run to destinations they make no effort to avoid mobs and dont stop until
 * they're actually hit which might be once they're mobbed"; "the mage's threshold for healing seems too low").
 *
 * - 19:44 UTC, Dryreach: Arcanist's walk_to ran on while two Shadows and a Shadow Child closed from behind; the first
 *   word was a 23-point crit, 85 → 28 HP in four seconds, dead at 19:44:27. Bulwark, 3 m away on a follow, woke only
 *   when he was hit himself (attackers-up), after she was dead.
 * - 19:29 UTC, Al-Arqas: out of the Bone Lair into five Mud Golems. Bulwark read "none are attacking" and spent XP
 *   while they killed the mage 2 m from him ("I was counting skill points while the mud ate you").
 *
 * What the client knows and now tells: a creature's server MoveToObject / TurnToObject carries its target (ACE
 * Creature_Navigation.MoveTo / TurnTo, Monster_Navigation chasing its AttackTarget), and its place moving toward you.
 * observe marks "COMING AT YOU", a fellow's line names the monsters at them, ac_wait wakes on aggro / fellow-aggro /
 * fellow-low, walk_to and follow answer when a monster starts coming at you, walk_to keeps clear of monsters near
 * the way (and goes past when no way keeps clear), a walk to a fellow with monsters on them keeps going through the
 * hits, and vitals-low / cast repeat default to 60%. Driven through the real AgentApi on the fake host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { AgentApi, type AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { TOOLS, TOOL_CALLER, waitFilter, type ToolCaller } from '../tools/ac-agent/tools.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { FakeHost, run } from './_harness/agentFake.ts';
import { cliCalls } from '../tools/stream/feed.ts';
import { playerToolNames, systemPrompt } from '../tools/stream/prompt.ts';
import { parseStreamConfig } from '../tools/stream/config.ts';

const SHADOW = 0x8000b6e1;
const CHILD = 0x8000b64f;
const GOLEM = 0x8000b17c;
const ARCANIST = 0x50000002;

/** Run the page's ticks until the promise settles (or `ms` pass); `each` runs before every 100 ms tick. */
async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('monsters coming at you, and at your fellows', () => {
  let host: FakeHost;
  let api: AgentApi;
  let surface: Record<string, (...a: unknown[]) => Promise<AgentResult>>;
  const monster = (guid: number, name: string, x: number, y: number, extra: Partial<AgentHostObject> = {}): AgentHostObject =>
    host.add({ guid, name, itemType: 0x10, objectDescFlags: 0x10, x, y, ...extra });
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.me.level = 20;
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    surface = api.surface() as unknown as typeof surface;
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  describe('observe and ac_wait', () => {
    it('a monster whose server MoveTo is aimed at you is COMING AT YOU, and wakes aggro with its level and distance', async () => {
      const shadow = monster(SHADOW, 'Shadow', 80, 50, { level: 26 });
      run(api, host, 500, { physics: false });
      expect(formatObservation(api.observe())).not.toMatch(/COMING AT YOU/);
      const w = api.wait({ types: ['aggro'] }, 5000);
      shadow.seeks = { guid: host.me.guid, kind: 'move' };
      run(api, host, 300, { physics: false });
      const evs = await w;
      expect(evs[0].text).toBe('Shadow #8000b6e1 (level 26) is coming at you, 30 m N (running at you)');
      expect(evs[0].guid).toBe(SHADOW);
      expect(formatObservation(api.observe())).toMatch(/#8000b6e1 {2}Shadow {2}\[monster L26\] {2}30\.0m ahead \(N\) {2}COMING AT YOU \(running at you\)/);
    });

    it('a TurnToObject at you reads "turned to face you"; one turned to someone else is not coming at you', async () => {
      monster(SHADOW, 'Shadow', 80, 50, { level: 26, seeks: { guid: 0x50000099, kind: 'turn' } });
      monster(CHILD, 'Shadow Child', 70, 30, { level: 12, seeks: { guid: host.me.guid, kind: 'turn' } });
      run(api, host, 500, { physics: false });
      const lines = formatObservation(api.observe());
      expect(lines).toMatch(/Shadow Child .*COMING AT YOU \(turned to face you\)/);
      expect(lines).not.toMatch(/#8000b6e1 .*COMING AT YOU/);
    });

    it('a monster closing on you by its own movement (no MoveTo the client knows) is noticed; one walking home is not', async () => {
      const shadow = monster(SHADOW, 'Shadow', 80, 56);
      const home = monster(CHILD, 'Shadow Child', 60, 56, { seeks: { guid: 0, kind: 'position' } });
      const w = api.wait({ types: ['aggro'] }, 10_000);
      for (let i = 0; i < 30; i++) { shadow.y -= 0.2; home.y -= 0.2; run(api, host, 100, { physics: false }); }
      const evs = await w;
      expect(evs).toHaveLength(1);
      expect(evs[0].text).toMatch(/^Shadow #8000b6e1 \(level not known yet\) is coming at you, 3\d m N \(closing, \d m nearer in [23] s\)$/);
      // Its level is looked up (a quiet examine, as observe's are) so the next look names it.
      expect(host.appraiseCalls).toContainEqual({ guid: SHADOW, quiet: true });
    });

    it('one already hitting you is not a new aggro (attackers-up says that), and a monster is announced once', async () => {
      const shadow = monster(SHADOW, 'Shadow', 81, 21, { seeks: { guid: host.me.guid, kind: 'move' } });
      api.pushChat('Shadow slashes your lower arm for 23 points of slashing damage!', 0x15);
      run(api, host, 600, { physics: false });
      expect(api.eventsSince().filter((e) => e.type === 'aggro')).toEqual([]);
      shadow.x = 80; shadow.y = 45; // stops hitting, comes again: still the same chase, no second line
      run(api, host, 2000, { physics: false });
      expect(api.eventsSince().filter((e) => e.type === 'aggro')).toHaveLength(0);
    });

    it('a fellow with monsters on them: their observe line names them, and fellow-aggro wakes with where they are', async () => {
      const vitals = { cur: 60, max: 85 };
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 40 });
      run(api, host, 300, { physics: false });
      const w = api.wait({ types: ['fellow-aggro'] }, 5000);
      monster(GOLEM, 'Mud Golem', 81, 41, { level: 8, seeks: { guid: ARCANIST, kind: 'stick' } });
      run(api, host, 300, { physics: false });
      const evs = await w;
      expect(evs[0].text).toBe('Mud Golem #8000b17c (level 8) is on your fellow Claude Arcanist (on them); Claude Arcanist is 20 m N of you, 71% health');
      expect(formatObservation(api.observe())).toMatch(/fellows: Claude Arcanist 71% HP, 20 m N, MONSTERS AT THEM: Mud Golem L8 on them/);
    });

    it("a fellow's threats are on their storey and near them: not a monster a floor over them, nor one far off (Mountain Keep, 2026-10-16)", async () => {
      const vitals = { cur: 60, max: 85 };
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 40, z: 94 });
      run(api, host, 300, { physics: false });
      const w = api.wait({ types: ['fellow-aggro'] }, 5000);
      // A Dread 6 m up, 2 m across, stuck "running at" her through the floor; one on her floor 30 m off; one at her.
      monster(SHADOW, 'Dread Mu-miyah', 82, 40, { level: 60, z: 100, seeks: { guid: ARCANIST, kind: 'move' } });
      monster(CHILD, 'Dread Mu-miyah', 80, 70, { level: 60, z: 94, seeks: { guid: ARCANIST, kind: 'move' } });
      monster(GOLEM, 'Mud Golem', 81, 41, { level: 8, z: 94.5, seeks: { guid: ARCANIST, kind: 'stick' } });
      run(api, host, 300, { physics: false });
      const evs = await w;
      expect(evs.map((e) => e.text).join('\n')).not.toMatch(/Dread/);
      const line = formatObservation(api.observe()).split('\n').find((l) => l.startsWith('fellows:'))!;
      expect(line).toMatch(/MONSTERS AT THEM: Mud Golem L8 on them$/);
      // On her floor and near, the Dread counts.
      const dread = host.object(SHADOW)!;
      dread.z = 94; dread.x = 80; dread.y = 50;
      run(api, host, 300, { physics: false });
      expect(formatObservation(api.observe())).toMatch(/MONSTERS AT THEM: Mud Golem L8 on them, Dread Mu-miyah L60 running at them 10 m off/);
    });

    it('fellow-low wakes at 60% by default, at a fellow_below mark per wait, and on a single big drop', async () => {
      const v = { cur: 85, max: 85 };
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: { ...v }, stamina: v, mana: v }];
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 30 });
      run(api, host, 300, { physics: false });
      // A mark of 70% (a fragile caster): wakes at 65%, before the default would.
      v.cur = 70; // 82%: steps under a quarter each (a single big drop wakes it whatever the mark)
      run(api, host, 300, { physics: false });
      let w = api.wait({ types: ['fellow-low'], fellowBelow: 0.7 }, 5000);
      v.cur = 55; // 65%
      run(api, host, 300, { physics: false });
      expect((await w)[0].text).toBe("Claude Arcanist's health 55/85 (65%), below your 70% mark; they are 10 m N of you");
      w = api.wait({ types: ['fellow-low'] }, 5000);
      v.cur = 50; // 59%
      run(api, host, 300, { physics: false });
      expect((await w)[0].text).toBe("Claude Arcanist's health 50/85 (59%), below 60%; they are 10 m N of you");
      w = api.wait({ types: ['fellow-low'] }, 5000);
      v.cur = 20;
      run(api, host, 300, { physics: false });
      expect((await w)[0].text).toBe("Claude Arcanist's health fell 50 → 20 of 85 at once (−35%); they are 10 m N of you");
    });

    it('ac_wait passes fellow_below (fraction or percent) and wakes on fellow-low with it', () => {
      expect(waitFilter({ types: 'task-done,fellow-aggro', fellow_below: 70 })).toEqual({ types: ['task-done', 'fellow-aggro', 'fellow-low'], fellowBelow: 0.7 });
      expect(waitFilter({ types: 'aggro', fellow_below: 0.65 })).toEqual({ types: ['aggro', 'fellow-low'], fellowBelow: 0.65 });
    });
  });

  describe('a monster that cannot reach you stops re-raising aggro (Tumerok Cave, 2026-10-16)', () => {
    // Stream 02:41–03:09 UTC: Shore Armoredillos behind the cave's walls re-raised "running at you" every minute or two
    // from the same 11–14 m (ACE re-sends a MoveToObject it can't path), and at 03:04 Arcanist dropped aggro from his
    // waits: "The wall-stuck dillos keep setting off aggro alerts, so I'll wait on chat and vitals only".
    const DILLO = 0x8000dd45;
    /** One server chase that gets nowhere: MoveToObject at you for a second, then nothing for 11 s (no move, no aim). */
    const chase = (d: AgentHostObject): void => {
      d.seeks = { guid: host.me.guid, kind: 'move' };
      run(api, host, 1000, { physics: false });
      d.seeks = undefined;
      run(api, host, 11_000, { physics: false });
    };
    let seen = 0;
    /** The aggro lines since the last call. */
    const aggros = (): string[] => {
      const evs = api.eventsSince(seen);
      if (evs.length) seen = evs[evs.length - 1].seq;
      return evs.filter((e) => e.type === 'aggro').map((e) => e.text);
    };
    beforeEach(() => { seen = 0; });

    it('raises it, says once that it is getting no closer (naming the wall), then stays quiet however often it re-aims', () => {
      host.lineOfFire = () => ({ dist: 12, blockedAt: 4, blocker: 'a wall' });
      const d = monster(DILLO, 'Shore Armoredillo', 80, 32, { level: 30 });
      run(api, host, 500, { physics: false });
      for (let i = 0; i < 10; i++) chase(d);
      const said = aggros();
      expect(said.filter((t) => / is coming at you/.test(t))).toEqual([
        'Shore Armoredillo #8000dd45 (level 30) is coming at you, 12 m N (running at you)',
        'Shore Armoredillo #8000dd45 (level 30) is coming at you, 12 m N (running at you)',
      ]);
      expect(said.filter((t) => /keeps facing you/.test(t))).toEqual([
        "Shore Armoredillo #8000dd45 (level 30) keeps facing you, 12 m N (running at you), but it hasn't come closer in 24 s (no line of fire: a wall in the way): stuck, or it can't path round to you. No more aggro for it until it closes in or attacks.",
      ]);
      expect(said).toHaveLength(3);
      // observe still marks it, and says how long it has come no nearer.
      d.seeks = { guid: host.me.guid, kind: 'move' };
      run(api, host, 300, { physics: false });
      expect(formatObservation(api.observe())).toMatch(/Shore Armoredillo .*COMING AT YOU \(running at you, no closer in \d+ s\)/);
    });

    it('you walking up to it is not it closing in; it coming 3 m nearer raises aggro at once', () => {
      const d = monster(DILLO, 'Shore Armoredillo', 80, 40, { level: 30 });
      run(api, host, 500, { physics: false });
      for (let i = 0; i < 4; i++) chase(d);
      expect(aggros()).toHaveLength(3);
      host.me.y = 26; // you go 6 m nearer it; it hasn't moved
      for (let i = 0; i < 3; i++) chase(d);
      expect(aggros()).toEqual([]);
      // It comes on: the line is there within a sample of it being 3 m nearer (14 m → 11 m), not after a forget window.
      d.seeks = { guid: host.me.guid, kind: 'move' };
      for (let i = 0; i < 3; i++) { d.y -= 1; run(api, host, 250, { physics: false }); }
      expect(aggros()).toEqual(['Shore Armoredillo #8000dd45 (level 30) is coming at you, 11 m N (running at you)']);
      for (let i = 0; i < 4; i++) { d.y -= 1; run(api, host, 250, { physics: false }); }
      expect(aggros()).toEqual([]); // the same chase, once
    });

    it('a held one is no reason to stop a walk', async () => {
      const d = monster(DILLO, 'Shore Armoredillo', 100, 20, { level: 30 });
      run(api, host, 500, { physics: false });
      for (let i = 0; i < 4; i++) chase(d);
      host.add({ guid: 0x80000070, name: 'Near Post', x: 80, y: 45 });
      let n = 0;
      const r = await settle(api, host, surface.walkTo('Near Post'), 20_000, () => { if (++n === 5) d.seeks = { guid: host.me.guid, kind: 'move' }; });
      expect(r).toMatchObject({ ok: true });
    });

    it('fellow-aggro is held the same way for a monster that never gets nearer your fellow', () => {
      const vitals = { cur: 85, max: 85 };
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 40 });
      const d = monster(DILLO, 'Shore Armoredillo', 80, 52, { level: 30 });
      run(api, host, 500, { physics: false });
      for (let i = 0; i < 8; i++) {
        d.seeks = { guid: ARCANIST, kind: 'move' };
        run(api, host, 1000, { physics: false });
        d.seeks = undefined;
        run(api, host, 11_000, { physics: false });
      }
      const said = api.eventsSince().filter((e) => e.type === 'fellow-aggro').map((e) => e.text);
      expect(said).toHaveLength(3);
      expect(said[2]).toBe("Shore Armoredillo #8000dd45 (level 30) keeps facing your fellow Claude Arcanist, 12 m from them (running at them), but it hasn't come closer to them in 24 s: stuck, or it can't path round to them. No more fellow-aggro for it until it closes in on them.");
    });
  });

  describe('walk_to and follow answer when a monster starts coming at you', () => {
    it('stops metres short, naming it, its level, distance and how, with the keys up', async () => {
      host.add({ guid: 0x80000070, name: 'Far Post', x: 80, y: 120 });
      const p = surface.walkTo('Far Post');
      let n = 0;
      const shadow = monster(SHADOW, 'Shadow', 110, 60, { level: 26 });
      const r = await settle(api, host, p, 20_000, () => { if (++n === 10) shadow.seeks = { guid: host.me.guid, kind: 'move' }; });
      expect(r).toMatchObject({ ok: false, aggro: true });
      expect(r!.message).toMatch(/^stopped [0-9.]+ m short: Shadow #8000b6e1 \(level 26\) is coming at you, \d+ m (E|NE|SE) \(running at you\)\. Fight it \(ac_attack \/ ac_cast\), get away from it .*stop_on_aggro=false\)\.$/);
      expect([...host.keys]).toEqual([]);
    });

    it('stop_on_aggro=false walks on; so does flee=true; one already coming when you set off does not stop it', async () => {
      host.add({ guid: 0x80000070, name: 'Near Post', x: 80, y: 45 });
      const shadow = monster(SHADOW, 'Shadow', 100, 40, { level: 26 });
      const coming = (): void => { shadow.seeks = { guid: host.me.guid, kind: 'move' }; };
      for (const o of [{ stopOnAggro: false }, { flee: true }]) {
        host.me.y = 20; shadow.seeks = undefined;
        run(api, host, 500, { physics: false });
        let n = 0;
        const r = await settle(api, host, surface.walkTo('Near Post', o), 20_000, () => { if (++n === 5) coming(); });
        expect(r).toMatchObject({ ok: true });
      }
      host.me.y = 20; coming();
      run(api, host, 600, { physics: false });
      expect(await settle(api, host, surface.walkTo('Near Post'), 20_000)).toMatchObject({ ok: true });
    });

    it('a follow answers the same way (ac_follow stop_on_aggro defaults on)', async () => {
      const v = { cur: 85, max: 85 };
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: v, stamina: v, mana: v }];
      const arc = host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 60 });
      const shadow = monster(SHADOW, 'Shadow', 50, 40, { level: 26 });
      let n = 0;
      const r = await settle(api, host, surface.follow('Claude Arcanist', { durationMs: 30_000 }), 30_000, () => {
        arc.y += 0.3;
        if (++n === 20) shadow.seeks = { guid: host.me.guid, kind: 'move' };
      });
      expect(r!.message).toMatch(/^stopped [0-9.]+ m short: Shadow #8000b6e1 \(level 26\) is coming at you/);
    });

    it('the routines\' own walks (api.walkTo without the tool) are unchanged: they fight their own way on', async () => {
      host.add({ guid: 0x80000070, name: 'Near Post', x: 80, y: 45 });
      const shadow = monster(SHADOW, 'Shadow', 110, 60, { level: 26 });
      let n = 0;
      const r = await settle(api, host, api.walkTo('Near Post', { within: 2 }), 20_000, () => { if (++n === 5) shadow.seeks = { guid: host.me.guid, kind: 'move' }; });
      expect(r).toMatchObject({ ok: true });
    });
  });

  describe('walk_to keeps clear of monsters near the way', () => {
    it('goes round a monster on the straight line, at least 10 m off it, and says so', async () => {
      host.wall = () => false; // open ground: the probe is the fake's
      host.add({ guid: 0x80000070, name: 'Far Post', x: 80, y: 70 });
      monster(SHADOW, 'Shadow', 80, 45, { level: 12 });
      let closest = Infinity;
      const r = await settle(api, host, surface.walkTo('Far Post'), 60_000, () => { closest = Math.min(closest, Math.hypot(host.me.x - 80, host.me.y - 45)); });
      expect(r).toMatchObject({ ok: true });
      expect(closest).toBeGreaterThan(9.4);
      expect(r!.message).toMatch(/went round Shadow L12, keeping 10\+ m clear \(avoid_monsters=false walks straight\)/);
    });

    it('a monster well above your level is kept 15 m off', async () => {
      host.wall = () => false;
      host.add({ guid: 0x80000070, name: 'Far Post', x: 80, y: 80 });
      monster(SHADOW, 'Shadow', 80, 50, { level: 40 });
      let closest = Infinity;
      const r = await settle(api, host, surface.walkTo('Far Post'), 60_000, () => { closest = Math.min(closest, Math.hypot(host.me.x - 80, host.me.y - 50)); });
      expect(r).toMatchObject({ ok: true });
      expect(closest).toBeGreaterThan(14.4);
    });

    it('avoid_monsters=false, flee and a routine walk go straight past it', async () => {
      host.wall = () => false;
      host.add({ guid: 0x80000070, name: 'Far Post', x: 80, y: 70 });
      monster(SHADOW, 'Shadow', 80, 45, { level: 12 });
      for (const go of [() => surface.walkTo('Far Post', { avoidMonsters: false }), () => surface.walkTo('Far Post', { flee: true }), () => api.walkTo('Far Post')]) {
        host.me.x = 80; host.me.y = 20;
        let closest = Infinity;
        const r = await settle(api, host, go(), 60_000, () => { closest = Math.min(closest, Math.hypot(host.me.x - 80, host.me.y - 45)); });
        expect(r).toMatchObject({ ok: true });
        expect(closest).toBeLessThan(1.5);
        expect(r!.message).not.toMatch(/went round/);
      }
    });

    it('not in a dungeon: its corridors keep no one 10 m clear, so the walk goes its way', async () => {
      host.wall = () => false;
      const CELL = 0x01e00121;
      host.me.cell = CELL; host.me.x = 80; host.me.y = 20; host.me.z = 0;
      host.add({ guid: 0x80000070, name: 'Far Post', cell: CELL, x: 80, y: 70, z: 0 });
      monster(SHADOW, 'Shadow', 80, 45, { level: 12, cell: CELL, z: 0 });
      let closest = Infinity;
      const r = await settle(api, host, surface.walkTo('Far Post'), 60_000, () => { closest = Math.min(closest, Math.hypot(host.me.x - 80, host.me.y - 45)); });
      expect(r).toMatchObject({ ok: true });
      expect(closest).toBeLessThan(1.5);
      expect(r!.message).not.toMatch(/went round|kept clear/);
    });

    it('when no way keeps clear (a corridor it stands in), the walk goes past it and says so: never a failure', async () => {
      host.wall = (x) => x < 76 || x > 84;
      host.add({ guid: 0x80000070, name: 'Far Post', x: 80, y: 70 });
      monster(SHADOW, 'Shadow', 80, 45, { level: 12 });
      const r = await settle(api, host, surface.walkTo('Far Post'), 90_000);
      expect(r).toMatchObject({ ok: true });
      expect(r!.message).toMatch(/no way on kept clear of Shadow L12: the walk went past them \(the only way it found\)/);
    });

    it('a destination beside a monster (its corpse, a fellow fighting it) is still reached', async () => {
      host.wall = () => false;
      host.add({ guid: 0x80000070, name: 'Corpse of Drudge', x: 80, y: 45 });
      monster(SHADOW, 'Shadow', 82, 46, { level: 12 });
      const r = await settle(api, host, surface.walkTo('Corpse of Drudge'), 60_000);
      expect(r).toMatchObject({ ok: true });
      expect(Math.hypot(host.me.x - 80, host.me.y - 45)).toBeLessThan(2.5);
    });
  });

  describe('getting to a fellow who is mobbed (Bulwark and the Mud Golems, 2026-10-14)', () => {
    it('a walk to a fellow with monsters on them keeps going through hits and new aggro, and says it was hit', async () => {
      const v = { cur: 40, max: 85 };
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: v, stamina: v, mana: v }];
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 60 });
      monster(GOLEM, 'Mud Golem', 81, 61, { level: 8, seeks: { guid: ARCANIST, kind: 'stick' } });
      const other = monster(0x8000b5ba, 'Mud Golem', 95, 45, { level: 8 });
      run(api, host, 300, { physics: false });
      let n = 0;
      const r = await settle(api, host, surface.walkTo('Claude Arcanist'), 30_000, () => {
        n++;
        if (n === 5) other.seeks = { guid: host.me.guid, kind: 'move' };
        if (n === 8) api.pushChat('Mud Golem bashes your upper leg for 18 points of bludgeoning damage!', 0x15);
      });
      expect(r).toMatchObject({ ok: true });
      expect(r!.message).toMatch(/^arrived/);
      expect(r!.message).toMatch(/hit on the way \(Mud Golem bashes your upper leg/);
    });

    it('the same walk to a fellow nobody is on still stops at the first hit', async () => {
      const v = { cur: 85, max: 85 };
      host.fellows = () => [{ guid: ARCANIST, name: 'Claude Arcanist', health: v, stamina: v, mana: v }];
      host.add({ guid: ARCANIST, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 60 });
      monster(GOLEM, 'Mud Golem', 81, 30, { level: 8 }); // ahead, so the way on doesn't lead away from it
      let n = 0;
      const r = await settle(api, host, surface.walkTo('Claude Arcanist', { avoidMonsters: false }), 30_000, () => { if (++n === 8) api.pushChat('Mud Golem bashes your upper leg for 18 points of bludgeoning damage!', 0x15); });
      expect(r).toMatchObject({ ok: false, attacked: true });
    });
  });

  describe('healing marks: 60% defaults (Arcanist has ~85 HP: two or three hits from dead at half)', () => {
    it('cast repeat stops below 60% by default', async () => {
      monster(SHADOW, 'Drudge Skulker', 80, 30, { level: 5 });
      host.me.health = { current: 29, max: 50 }; // 58%
      const out = await settle(api, host, api.cast('Flame Bolt I', 'Drudge Skulker', { repeat: true }), 10_000);
      expect(out!.message).toMatch(/stopped: your health is 29\/50 \(58%\), below the 60% you set \(until_health\)/);
    });

    it('the tools say so: ac_wait vitals_below default 0.6 and fellow_below; ac_cast until_health default 0.6', () => {
      const wait = TOOLS.find((t) => t.name === 'ac_wait')!;
      expect(JSON.stringify(wait.props)).toMatch(/Default 0\.6\..*Heal early: a fragile caster at about 70%, a tank at about 60%/);
      expect(Object.keys(wait.props)).toContain('fellow_below');
      const cast = TOOLS.find((t) => t.name === 'ac_cast')!;
      expect(JSON.stringify(cast.props)).toMatch(/default 0\.6; 0 never stops for health/);
      const walk = TOOLS.find((t) => t.name === 'ac_walk_to')!;
      expect(Object.keys(walk.props)).toEqual(expect.arrayContaining(['stop_on_aggro', 'avoid_monsters']));
    });

    it('ac_walk_to passes stop_on_aggro=false and avoid_monsters=false to the page; ac_follow stop_on_aggro=false', async () => {
      const seen: Array<[string, unknown[]]> = [];
      const caller: ToolCaller = { call: async <T>(m: string, args: unknown[] = []) => { seen.push([m, args]); return { ok: true, message: 'ok' } as unknown as T; } } as ToolCaller;
      await TOOL_CALLER.run(caller, () => TOOLS.find((t) => t.name === 'ac_walk_to')!.run({ target: '10m north', stop_on_aggro: false, avoid_monsters: 'false' }));
      await TOOL_CALLER.run(caller, () => TOOLS.find((t) => t.name === 'ac_follow')!.run({ target: 'Claude Arcanist', stop_on_aggro: false }));
      expect(seen[0]).toEqual(['walkTo', ['10m north', { within: undefined, stopOnAggro: false, avoidMonsters: false }]]);
      expect(seen[1][1][1]).toMatchObject({ stopOnAggro: false });
    });
  });

  describe('the stream brief as a player gets it', () => {
    const cast = parseStreamConfig(JSON.parse(readFileSync(join(__dirname, '..', 'tools', 'stream', 'cast.json'), 'utf8')));
    const sys = systemPrompt(readFileSync(join(__dirname, '..', 'tools', 'stream', 'brief.md'), 'utf8'), cast.characters[0], 'Claude Bulwark', playerToolNames(TOOLS.map((t) => t.name)));
    it('heal early: a fragile caster at about 70%, the tank at about 60%, not at half; a leave rule a caster can survive', () => {
      expect(sys).toMatch(/a fragile caster heals at about 70% and the tank is healed at about 60%, between pulls and before the next one, never waiting for half/);
      expect(sys).not.toMatch(/heals Bulwark below 50%/);
      expect(sys).toMatch(/"\/f RUN" when the caster is below about 50% health \(the tank below about 35%\)/);
    });
    it('its fight wait, run as the player runs it, wakes on a monster coming at you', async () => {
      const cmd = /`(\.\/ac wait types=task-done[^`]*chat_match[^`]*)`/.exec(sys)![1];
      const filter = waitFilter(cliCalls(cmd)[0].args) as Parameters<AgentApi['wait']>[0];
      expect(filter?.types).toEqual(expect.arrayContaining(['aggro', 'fellow-low']));
      const shadow = monster(SHADOW, 'Shadow', 80, 50, { level: 26 });
      run(api, host, 300, { physics: false });
      api.observe();
      const w = api.wait(filter, 5000);
      shadow.seeks = { guid: host.me.guid, kind: 'move' };
      run(api, host, 300, { physics: false });
      expect((await w).map((e) => e.type)).toEqual(['aggro']);
    });
  });
});

