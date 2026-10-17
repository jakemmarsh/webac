/**
 * BUG.ghost-objects, the agent's side (Arcanist + Bulwark near Holtburg,
 * 2026-10-11): the client kept objects the server had stopped mentioning.
 *
 *  - An object the client released (its cell left the 3×3 the server keeps you
 *    updated on: CPhysicsObj::leave_visibility, world/ObjectMaint.ts) is only
 *    where it was last seen: observations never list it, a fellow there has no
 *    distance, and acting on it is refused with the reason.
 *  - A cast the server refuses with a UseDone the retail client shows no text
 *    for (TargetNotAcquired 0x42C, ACE Player_Magic.cs) reports the refusal;
 *    it read "Casting Flame Bolt I" as if it had landed.
 *  - The empty-attack stop counts only combat lines that name the target:
 *    Bulwark's attack on a phantom Mite Sentry cycled heights for a minute
 *    (soldier.log, 30 × AttackDone 0x36) because a Banderling Scout hitting
 *    him in between counted as swings.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const SENTRY = 0x8000e941;
const FELLOW = 0x50000002;

describe('released objects are not presented as there', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    (host as unknown as { fellows: () => unknown[] }).fellows = () => [{ guid: FELLOW, name: 'Claude Bulwark', health: { cur: 40, max: 50 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
    host.add({ guid: SENTRY, name: 'Mite Sentry', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 22 });
    host.add({ guid: FELLOW, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 20 });
  });
  afterEach(() => vi.useRealTimers());

  it('nearby and the fellows line drop them; the same objects in your world are listed', () => {
    let obs = api.observe();
    expect(obs.nearby.map((o) => o.name).sort()).toEqual(['Claude Bulwark', 'Mite Sentry']);
    expect(obs.fellows?.[0].dist).toBeCloseTo(1, 0);
    host.objs.get(SENTRY)!.lost = true;
    host.objs.get(FELLOW)!.lost = true;
    obs = api.observe();
    expect(obs.nearby).toEqual([]);
    // "My client shows you standing 1 m from me … while you're at the lifestone": no distance for a released fellow.
    expect(obs.fellows).toEqual([{ name: 'Claude Bulwark', healthPct: 80 }]);
  });

  it('a released target is flagged in the observation', () => {
    host.target = SENTRY;
    host.objs.get(SENTRY)!.lost = true;
    const obs = api.observe();
    expect(obs.target?.outOfSight).toBe(true);
    expect(formatObservation(obs)).toMatch(/target: .*Mite Sentry.*OUT OF SIGHT: only where it was last seen/);
  });

  it('attack, cast and use refuse a released object by guid; by name it is not found', async () => {
    host.objs.get(SENTRY)!.lost = true;
    host.me.combatMode = 'melee';
    const a = api.attack(SENTRY);
    expect(a.ok).toBe(false);
    expect(a.message).toMatch(/Mite Sentry #8000e941 is out of sight: your client let it go/);
    expect(api.attack('Mite Sentry').ok).toBe(false);
    const c = await api.cast('Flame Bolt I', SENTRY);
    expect(c.ok).toBe(false);
    expect(c.message).toMatch(/out of sight/);
    expect(host.sent.some((s) => s.startsWith('attack') || s.startsWith('cast'))).toBe(false);
  });

  it('attack with the released monster still selected goes for one that is there', () => {
    host.objs.get(SENTRY)!.lost = true;
    host.target = SENTRY;
    host.me.combatMode = 'melee';
    host.add({ guid: 0x8000f6a0, name: 'Banderling Scout', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 23 });
    const r = api.attack(null);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Banderling Scout/);
  });

  it('a cast at the selected released target is refused, not sent', async () => {
    host.objs.get(SENTRY)!.lost = true;
    host.target = SENTRY;
    const r = await api.cast('Flame Bolt I', null);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Flame Bolt I not cast: your target Mite Sentry #[0-9a-f]+ is out of sight: your client let it go/);
    expect(host.sent.some((s) => s.startsWith('cast'))).toBe(false);
  });
});

describe('a cast the server refuses says so (UseDone TargetNotAcquired)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.add({ guid: SENTRY, name: 'Mite Sentry', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
  });
  afterEach(() => vi.useRealTimers());

  it('the words, then UseDone 0x42C: not cast, the refusal and what it means', async () => {
    host.cast = (id, t) => {
      host.sent.push(`cast ${id} ${t?.toString(16)}`);
      setTimeout(() => api.pushChat('You say, "Zojak Quaguz"', 0x11), 300);
      // main.ts: agentUseDoneTap → pushUseDone(code, WeenieError name, weenieErrorText(code)).
      setTimeout(() => api.pushUseDone(0x42c, 'TargetNotAcquired', 'You don\'t have a target selected.'), 1200);
      return true;
    };
    const p = api.cast('Flame Bolt I', 'Mite Sentry');
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(host.sent).toContain(`cast 27 ${SENTRY.toString(16)}`);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Flame Bolt I not cast at Mite Sentry/);
    expect(r.message).toContain('the server refused it: You don\'t have a target selected. (TargetNotAcquired)');
    expect(r.message).toMatch(/the server has no Mite Sentry where you are: it is dead, gone or moved on its side/);
    expect(r.message).toContain('You say, "Zojak Quaguz"');
  });

  it('a refusal with no text is still reported, and ends the wait at once', async () => {
    host.cast = () => { setTimeout(() => api.pushUseDone(0x42c, 'TargetNotAcquired', null), 200); return true; };
    const p = api.cast('Flame Bolt I', 'Mite Sentry');
    await vi.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toContain('the server refused it: TargetNotAcquired (no message shown)');
  });

  it('a refusal the client printed is said once, as the refusal', async () => {
    host.cast = () => {
      setTimeout(() => { api.pushChat('You don\'t have a target selected.', 0x00); api.pushUseDone(0x42c, 'TargetNotAcquired', 'You don\'t have a target selected.'); }, 200);
      return true;
    };
    const p = api.cast('Flame Bolt I', 'Mite Sentry');
    await vi.advanceTimersByTimeAsync(1000);
    const r = await p;
    expect(r.message.match(/You don't have a target selected\./g)).toHaveLength(1);
  });

  it('a landed cast is unchanged: no refusal, ok', async () => {
    host.cast = () => { setTimeout(() => api.pushChat('You scorch Mite Sentry for 12 points with Flame Bolt I.', 0x06), 300); return true; };
    const p = api.cast('Flame Bolt I', 'Mite Sentry');
    await vi.advanceTimersByTimeAsync(3000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(r.message).not.toMatch(/refused/);
  });
});

describe('the empty-attack stop ignores other creatures\' combat lines (Bulwark vs the phantom Mite Sentry)', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    host.me.combatMode = 'melee';
    host.add({ guid: SENTRY, name: 'Mite Sentry', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 21.5 });
  });
  afterEach(() => vi.useRealTimers());

  it('AttackDone 0x36 with no swing, while a Banderling Scout nicks you every 2.3 s: stops after three', () => {
    // soldier.log 4457-4511: TargetedMeleeAttack → AttackDone 0x36 at once, over and over.
    host.attack = (g, p, h) => { host.sent.push(`attack ${g.toString(16)} ${p} ${h}`); setTimeout(() => api.pushAttackDone(), 150); };
    host.attackPending = () => false;
    // soldier.chat.log 00:46:10-00:47:03: the real Scout's swings at him (CombatEnemy 0x15).
    const scout = ['Banderling Scout nicks your lower arm for 3 points of piercing damage!', 'You evaded Banderling Scout!'];
    let n = 0;
    const pelt = setInterval(() => api.pushChat(scout[n++ % 2], 0x15), 700);
    const since = api.observe().seq;
    expect(api.attack('Mite Sentry').ok).toBe(true);
    run(api, host, 10_000, { physics: false });
    clearInterval(pelt);
    const out = api.eventsSince(since).filter((e) => e.type === 'task-done' || e.type === 'target-lost').map((e) => e.text);
    expect(out.some((t) => /Mite Sentry #8000e941: the server won't attack it/.test(t))).toBe(true);
    expect(out.some((t) => /ended 3 attacks on Mite Sentry at once, with no swing/.test(t))).toBe(true);
    // It never got as far as cycling attack heights.
    expect(host.sent.filter((s) => s.startsWith('height'))).toEqual([]);
  });

  it('the target hitting you is a swing: a live Sentry keeps the attack going', () => {
    host.attack = (g) => {
      host.sent.push(`attack ${g.toString(16)}`);
      setTimeout(() => { api.pushChat('Mite Sentry bites your foot for 4 points of piercing damage!', 0x15); api.pushAttackDone(); }, 150);
    };
    host.attackPending = () => false;
    const since = api.observe().seq;
    api.attack('Mite Sentry');
    run(api, host, 6000, { physics: false });
    expect(api.eventsSince(since).some((e) => e.type === 'target-lost')).toBe(false);
  });
});
