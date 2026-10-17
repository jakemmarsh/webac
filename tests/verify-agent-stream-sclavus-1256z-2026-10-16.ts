/**
 * Agent-tool fixes from the stream players' 2026-10-16 12:56Z reports (end-of-retail local ACE, the Sclavus / Grievver
 * camps ~36.9N 29.1E, landblock 0xA3AD, segment 11:55–12:56Z, build ed7114f3; reports stream/reports/*2026-10-16T12-56*,
 * transcripts stream/sessions/{mage,soldier}-2026-10-16-seg1.jsonl, page logs mage.log / soldier.log, chat logs):
 *  1. `attack target=#800051ad` mid-attack "didn't switch": it did (TargetedMeleeAttack 0x800051ad at 12:41:52.9, swings
 *     landing from 12:41:54); the wait after it handed over the kill's event from 0.5 s BEFORE the order, "you are not
 *     attacking it". A delivered target-died note now says when you have attacked that monster since.
 *  2. A 0-damage nick stopped a walk_to stop_on_aggro=false 168 m short; nicks from a trivial foe or a lone attacker no
 *     longer stop it, real damage still does.
 *  3. stay_with ended "hasn't moved for 12 s" while the partner fought or finished a kill: a fellow fighting (weapon
 *     out beside a monster, their movement aimed at one, monsters on them) or just done fighting is waited for.
 *  4. walk_to a fellow ran 3.6–4.3 m past them: the last metres to a player are walked.
 *  5. Armor Self VI (power 250) was offered as a buff to a Life Magic of ~217: buffs you can't land are left for a lower
 *     level or marked with their odds, and the spell list shows the odds.
 *  6. A cast at a target that died first exited the CLI with code 1: targetGone results are not errors.
 *  7. Equipping Shoes over Leather Boots timed out with the main pack full: the auto-wield retries when the blocker
 *     lands in the side pack its dequip chose (retail RecvNotice_ServerSaysMoveItem).
 *  8. ac_attack next=true chains to the next monster on you (or a fellow) after a kill.
 * Each drives the shipped code (AgentApi against the fake host tests/_harness/agentFake.ts, format.ts, tools.ts, the
 * shared AutoWield helper).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatSpells } from '../packages/renderer/src/agent/format.ts';
import type { AgentSpell } from '../packages/renderer/src/agent/types.ts';
import { TOOL_BY_NAME, result } from '../tools/ac-agent/tools.ts';
import { parseCliArgs } from '../tools/ac-agent/cli.ts';
import { autoWieldRetryDue } from '../packages/shared/src/inventory/AutoWield.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const BULWARK = 0x50000002;
const vitals = { cur: 40, max: 50 };

/** Run the page's ticks every 100 ms until the promise settles (or `ms` pass); `each` runs before every tick. */
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

let host: FakeHost;
let api: AgentApi;
let traces: string[];
beforeEach(() => {
  vi.useFakeTimers();
  host = new FakeHost();
  api = new AgentApi(host);
  traces = [];
  vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.join(' ')); });
  host.attackPending = () => false;
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('1. a target-died note read after you attacked that monster says so', () => {
  const A = 0x80005869, B = 0x800051ad;
  beforeEach(() => {
    host.me.combatMode = 'melee';
    host.add({ guid: A, name: 'Essa Sclavus', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22 });
    host.add({ guid: B, name: 'Essa Sclavus', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 20 });
  });

  it('the kill lands, then ac_attack #51ad: the next wait says "you have attacked it since", not "not attacking it"', async () => {
    const since = api.observe().seq;
    expect(api.attack(A).ok).toBe(true);
    run(api, host, 1000, { physics: false });
    api.pushChat('Essa Sclavus nicks your chest for 0 points of piercing damage!', 0x15);
    host.dying.add(A);
    run(api, host, 300, { physics: false });
    // As the event stood when it was pushed:
    expect(api.eventsSince(since).find((e) => e.type === 'target-died')?.text).toMatch(/but you are not attacking it: ac_attack target=#800051ad/);
    // The switch 0.5 s later, then the wait.
    expect(api.attack(B).ok).toBe(true);
    const evs = await api.waitFor({ types: ['target-died'], sinceSeq: since }, 0);
    expect(evs[0].text).toBe('Essa Sclavus #80005869 died; Essa Sclavus #800051ad is on you (1× in 10 s); you have attacked it since (ac_attack after this kill)');
  });

  it('read with no attack since, the note stands', async () => {
    const since = api.observe().seq;
    api.attack(A);
    run(api, host, 1000, { physics: false });
    api.pushChat('Essa Sclavus nicks your chest for 0 points of piercing damage!', 0x15);
    host.dying.add(A);
    run(api, host, 300, { physics: false });
    const evs = await api.waitFor({ types: ['target-died'], sinceSeq: since }, 0);
    expect(evs[0].text).toMatch(/but you are not attacking it: ac_attack target=#800051ad to fight it$/);
  });
});

describe('2. hits that do no harm don\'t stop a walk; real damage does', () => {
  const ESSA = 0x8000520e;
  beforeEach(() => {
    host.me.level = 33;
    host.me.health = { current: 172, max: 172 };
    // Ahead on the way (north): walking on doesn't lead away from it, so only the hit rule decides.
    host.add({ guid: ESSA, name: 'Essa Sclavus', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22, level: 30 });
  });
  const hitAt = (t: number, line: string): (() => void) => { let done = false; return () => { if (!done && host.t >= t) { done = true; api.pushChat(line, 0x15); } }; };

  it('"Critical hit! Essa Sclavus nicks your head for 0 points" mid-walk: walks on and says so (was "stopped 167.9 m short")', async () => {
    const r = await settle(api, host, api.walkTo('30m north', { stopOnAggro: false }), 30_000, hitAt(1000, 'Critical hit! Essa Sclavus nicks your head for 0 points of piercing damage!'));
    expect(r).toMatchObject({ ok: true });
    expect(r!.message).toMatch(/walked on through a hit for 0 damage in all \(Essa Sclavus: no harm, or a nick\)/);
  });

  it('an evade ("You evaded Mite Scamp!") walks on, whatever stop_on_aggro', async () => {
    const r = await settle(api, host, api.walkTo('30m north', { stopOnAggro: true }), 30_000, hitAt(1000, 'You evaded Essa Sclavus!'));
    expect(r).toMatchObject({ ok: true });
  });

  it('a 4-point nick from the only creature on you walks on with stop_on_aggro=false, and stops with it on', async () => {
    const nick = 'Essa Sclavus nicks your foot for 4 points of piercing damage!';
    const off = await settle(api, host, api.walkTo('30m north', { stopOnAggro: false }), 30_000, hitAt(1000, nick));
    expect(off).toMatchObject({ ok: true });
    host.me.x = 80; host.me.y = 20;
    const on = await settle(api, host, api.walkTo('30m north', { stopOnAggro: true }), 30_000, hitAt(host.t + 1000, nick));
    expect(on).toMatchObject({ ok: false, attacked: true });
    expect(on!.message).toMatch(/stopped .* short: you're under attack \(Essa Sclavus nicks your foot for 4 points/);
  });

  it('real damage (20 of 172) stops it as before', async () => {
    const r = await settle(api, host, api.walkTo('30m north', { stopOnAggro: false }), 30_000, hitAt(1000, 'Essa Sclavus stabs your chest for 20 points of piercing damage!'));
    expect(r).toMatchObject({ ok: false, attacked: true });
  });

  it('nicks add up: past 10% of your health in all, the next one stops it', async () => {
    let n = 0;
    const each = (): void => { if (host.t >= 1000 && host.t % 500 === 0 && n < 6) { n++; api.pushChat('Essa Sclavus nicks your foot for 7 points of piercing damage!', 0x15); } };
    const r = await settle(api, host, api.walkTo('60m north', { stopOnAggro: false }), 60_000, each);
    expect(r).toMatchObject({ ok: false, attacked: true });
    expect(n).toBeGreaterThanOrEqual(3); // 7 + 7 = 14 ≤ 17.2 walked through; the third (21 in all) stops it
  });

  it('hitDamage reads retail\'s lines', () => {
    expect(AgentApi.hitDamage('Critical hit! Essa Sclavus nicks your head for 0 points of piercing damage!')).toBe(0);
    expect(AgentApi.hitDamage('Reckless! Sata Sclavus nicks your foot for 1 point of piercing damage!')).toBe(1);
    expect(AgentApi.hitDamage('You evaded Essa Sclavus!')).toBe(0);
    expect(AgentApi.hitDamage('(combat) Scrawed Grievver hits your head for 1,204 points of slashing damage!')).toBe(1204);
    expect(AgentApi.hitDamage('Essa Sclavus casts something')).toBeNull();
  });
});

describe('3. stay_with waits for a fellow who is fighting or finishing a kill', () => {
  const ESSA = 0x80005f4b;
  beforeEach(() => {
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 18 });
    host.fellows = () => [{ guid: BULWARK, name: 'Claude Bulwark', health: vitals, stamina: vitals, mana: vitals }];
  });

  it('he stands 40 s swinging (weapon out, an Essa beside him), kills it, stands 5 s, then comes: the walk waits and goes on', async () => {
    let killedAt: number | null = null;
    const him = (): void => {
      const b = host.objs.get(BULWARK)!;
      if (host.t < 40_000) {
        if (!host.objs.has(ESSA)) host.add({ guid: ESSA, name: 'Essa Sclavus', itemType: 0x10, objectDescFlags: 0x10, x: b.x + 1.5, y: b.y, level: 30 });
        b.combatStance = true;
        return;
      }
      if (killedAt === null) { killedAt = host.t; host.objs.delete(ESSA); }
      if (host.t - killedAt < 5000) return; // finishing: loot, a look round
      b.combatStance = undefined;
      b.y += 0.5;
    };
    const r = await settle(api, host, api.walkTo('60m north', { stayWith: 'Claude Bulwark', timeoutMs: 600_000 }), 200_000, him);
    const log = traces.filter((t) => /walk:/.test(t)).join('\n');
    expect(r, log).toMatchObject({ ok: true });
    expect(r!.message).not.toMatch(/hasn't moved/);
    expect(log).toMatch(/Claude Bulwark is fighting; waiting on/);
  });

  it('his movement aimed at a monster (the server walking him to his melee target) is attacking', async () => {
    host.add({ guid: ESSA, name: 'Essa Sclavus', itemType: 0x10, objectDescFlags: 0x10, x: 60, y: -10, level: 30 });
    const him = (): void => { if (host.t < 30_000) host.objs.get(BULWARK)!.seeks = { guid: ESSA, kind: 'turn' }; else { host.objs.get(BULWARK)!.seeks = undefined; host.objs.get(BULWARK)!.y += 0.5; } };
    const r = await settle(api, host, api.walkTo('60m north', { stayWith: 'Claude Bulwark', timeoutMs: 600_000 }), 200_000, him);
    const log = traces.filter((t) => /walk:/.test(t)).join('\n');
    expect(r, log).toMatchObject({ ok: true });
    expect(log).toMatch(/Claude Bulwark is attacking; waiting on/);
  });

  it('simply idle (no weapon out, nothing near him): still "hasn\'t moved for 12 s"', async () => {
    const r = await settle(api, host, api.walkTo('60m north', { stayWith: 'Claude Bulwark', timeoutMs: 600_000 }), 60_000);
    expect(r!.message).toMatch(/hasn't moved for 1\d s/);
  });

  it('weapon out with nothing alive near him is idle too', async () => {
    host.objs.get(BULWARK)!.combatStance = true;
    const r = await settle(api, host, api.walkTo('60m north', { stayWith: 'Claude Bulwark', timeoutMs: 600_000 }), 60_000);
    expect(r!.message).toMatch(/hasn't moved for 1\d s/);
  });
});

describe('4. walk_to a fellow walks the last metres and stops on them', () => {
  it('the last 3 m past the arrival distance at a walk (Shift), the run before it', async () => {
    host.add({ guid: BULWARK, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 40 });
    const seen: Array<{ d: number; shift: boolean }> = [];
    const r = await settle(api, host, api.walkTo(BULWARK), 30_000, () => {
      if (host.keys.has('KeyW')) seen.push({ d: Math.hypot(host.me.x - 80, host.me.y - 40), shift: host.keys.has('ShiftLeft') });
    });
    expect(r).toMatchObject({ ok: true });
    expect(r!.message).not.toMatch(/run past/);
    expect(seen.filter((s) => s.d > 6).every((s) => !s.shift)).toBe(true);
    expect(seen.filter((s) => s.d < 4.5).every((s) => s.shift)).toBe(true);
  });

  it('a walk to map coordinates or a monster keeps running to the end', async () => {
    const seen: boolean[] = [];
    await settle(api, host, api.walkTo('20m north'), 30_000, () => { if (host.keys.has('KeyW')) seen.push(host.keys.has('ShiftLeft')); });
    expect(seen.some((s) => s)).toBe(false);
  });
});

describe('5. buffs you can\'t land aren\'t offered as castable', () => {
  const life = (id: number, name: string, level: number, power: number): AgentSpell => ({ id, name, school: 'Life', level, power, buff: true, self: true });
  beforeEach(() => {
    host.skills.set(33, { base: 200, buffed: 217 }); // Life Magic
    host.spells = () => [life(24, 'Armor Self I', 1, 1), life(1309, 'Armor Self III', 3, 100), life(1312, 'Armor Self VI', 6, 250), life(2, 'Impregnability Self VI', 6, 250)];
  });

  it('missing buffs: Armor Self III (castable) over Armor Self VI; a family with nothing castable is marked with its odds', () => {
    const o = api.observe();
    expect(o.buffsMissing).toContain('Armor Self III');
    expect(o.buffsMissing).not.toContain('Armor Self VI');
    expect(o.buffsMissing).toContain('Impregnability Self VI (only 9% to cast: your skill is too low)');
    // Castable ones first.
    expect(o.buffsMissing![0]).toBe('Armor Self III');
  });

  it('the spell list shows the odds of the gamble ones only', () => {
    const list = api.spells('Armor');
    expect(list.find((s) => s.id === 1312)).toMatchObject({ castChance: 0.09, schoolSkill: 217 });
    const text = formatSpells(list);
    expect(text).toMatch(/1312 {2}Armor Self VI {2}\[Life L6\] {2}9% to cast \(your skill 217 vs difficulty 250\)/);
    expect(text).toMatch(/1309 {2}Armor Self III {2}\[Life L3\]$/m);
  });

  it('no skill known: the list is as before', () => {
    host.skills.clear();
    expect(api.spells('Armor').every((s) => s.castChance === undefined)).toBe(true);
    expect(api.observe().buffsMissing).toContain('Armor Self VI');
  });
});

describe('6. a cast or attack at a target that died first is not an error', () => {
  const GONE = 0x80005e81, ESSA = 0x800060b8;
  beforeEach(() => {
    host.spells = () => [{ id: 1, name: 'Whirling Blade IV', school: 'War', level: 4, power: 150, projectile: true }];
    host.add({ guid: ESSA, name: 'Essa Sclavus', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
  });

  it('cast repeat at a guid gone from view: targetGone, and the tool answers no error (CLI exit 0)', async () => {
    const r = await api.cast('Whirling Blade IV', GONE, { repeat: true });
    expect(r).toMatchObject({ ok: false, targetGone: true });
    // Said as what happened, not a "0 times" tally (stream reports 2026-10-17 10:12Z).
    expect(r.message).toMatch(/^Whirling Blade IV not cast: #80005e81 is gone from view \(it died out of sight, fled, or you moved away\), before your first cast at it \(no cast made; pick the next target\)/);
    expect(result(r).isError).toBe(false);
  });

  it('a single cast at a dying target, and an attack at one: targetGone too', async () => {
    host.dying.add(ESSA);
    const c = await api.cast('Whirling Blade IV', ESSA);
    expect(c).toMatchObject({ ok: false, targetGone: true });
    expect(result(c).isError).toBe(false);
    const a = api.attack(ESSA);
    expect(a).toMatchObject({ ok: false, targetGone: true });
    expect(result(a).isError).toBe(false);
  });

  it('a real failure stays an error', async () => {
    const r = await api.cast('Lightning Bolt VII', ESSA);
    expect(r.ok).toBe(false);
    expect(result(r).isError).toBe(true);
  });
});

describe('7. auto-wield retries when the blocker lands in the side pack its dequip chose', () => {
  const BOOTS = 0x80010364, SHOES = 0x80005b2c, ME = 0x50000001, SACK = 0x8000338e;
  it('main pack full: Leather Boots → the Sack; their landing there wields the Shoes (was: only the main pack)', () => {
    const pending = { itemId: SHOES, blockingId: BOOTS, containerId: SACK };
    expect(autoWieldRetryDue(pending, BOOTS, SACK)).toBe(true);
    expect(autoWieldRetryDue(pending, BOOTS, ME)).toBe(false); // somewhere it wasn't sent
    expect(autoWieldRetryDue(pending, 0x80000001, SACK)).toBe(false); // another item's move
    expect(autoWieldRetryDue(null, BOOTS, SACK)).toBe(false);
  });
  it('the usual case, the main pack, still retries', () => {
    expect(autoWieldRetryDue({ itemId: SHOES, blockingId: BOOTS, containerId: ME }, BOOTS, ME)).toBe(true);
  });
});

describe('8. ac_attack next=true chains to the next monster on you', () => {
  const A = 0x8000601c, B = 0x80005f4b, C = 0x800060b8;
  beforeEach(() => {
    host.me.combatMode = 'melee';
    host.add({ guid: A, name: 'Essa Sclavus', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21 });
    host.add({ guid: B, name: 'Sata Sclavus', itemType: 0x10, objectDescFlags: 0x10, x: 81, y: 20 });
  });
  const sentAt = (g: number): string[] => host.sent.filter((x) => x.startsWith(`attack ${g.toString(16)}`));

  it('the CLI takes next=true and the tool passes it on', () => {
    const tool = TOOL_BY_NAME.get('ac_attack')!;
    expect(parseCliArgs(tool, ['target=#8000601c', 'next=true'])).toMatchObject({ next: true });
    expect(tool.props.next).toBeDefined();
  });

  it('after the kill the attack goes on to the Sata hitting you, and the target-died event names it', async () => {
    const since = api.observe().seq;
    const r = api.attack(A, { next: true });
    expect(r.message).toMatch(/next=true: when it dies, the next monster on you/);
    run(api, host, 1000, { physics: false });
    api.pushChat('Sata Sclavus nicks your foot for 0 points of piercing damage!', 0x15);
    host.dying.add(A);
    run(api, host, 200, { physics: false });
    await Promise.resolve(); await Promise.resolve();
    run(api, host, 1500, { physics: false });
    const died = api.eventsSince(since).find((e) => e.type === 'target-died');
    expect(died?.text).toBe('Essa Sclavus #8000601c died; next=true: attacking Sata Sclavus #80005f4b now (on you, 1× in 10 s)');
    expect(sentAt(B).length).toBeGreaterThan(0);
  });

  it('nothing else on anyone: the chain says it stops', async () => {
    const since = api.observe().seq;
    api.attack(A, { next: true });
    run(api, host, 1000, { physics: false });
    host.dying.add(A);
    run(api, host, 500, { physics: false });
    expect(api.eventsSince(since).find((e) => e.type === 'target-died')?.text).toBe('Essa Sclavus #8000601c died; next=true: nothing else is on you or a fellow, so the attacks stop here');
  });

  it('a monster on a fellow is next when none is on you', async () => {
    host.add({ guid: BULWARK, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 90, y: 20 });
    host.fellows = () => [{ guid: BULWARK, name: 'Claude Arcanist', health: vitals, stamina: vitals, mana: vitals }];
    host.add({ guid: C, name: 'Essa Sclavus', itemType: 0x10, objectDescFlags: 0x10, x: 91, y: 20, seeks: { guid: BULWARK, kind: 'stick' } });
    host.objs.get(B)!.x = 200; // the Sata far off, on no one
    const since = api.observe().seq;
    api.attack(A, { next: true });
    run(api, host, 1000, { physics: false });
    host.dying.add(A);
    run(api, host, 200, { physics: false });
    await Promise.resolve(); await Promise.resolve();
    expect(api.eventsSince(since).find((e) => e.type === 'target-died')?.text).toMatch(/next=true: attacking Essa Sclavus #800060b8 now \(on Claude Arcanist, 11 m from you\)/);
  });

  it('default (no next): the kill only says who is on you; no swing goes at it', () => {
    api.attack(A);
    run(api, host, 1000, { physics: false });
    api.pushChat('Sata Sclavus nicks your foot for 0 points of piercing damage!', 0x15);
    host.dying.add(A);
    run(api, host, 1500, { physics: false });
    expect(sentAt(B)).toEqual([]);
  });

  it('an order of yours in between wins: a plain attack ends the chain', () => {
    api.attack(A, { next: true });
    run(api, host, 500, { physics: false });
    api.attack(A); // re-issued without next
    run(api, host, 500, { physics: false });
    api.pushChat('Sata Sclavus nicks your foot for 0 points of piercing damage!', 0x15);
    host.dying.add(A);
    run(api, host, 1500, { physics: false });
    expect(sentAt(B)).toEqual([]);
  });
});
