/**
 * Agent-tool fixes from the stream players' 2026-10-16 23:40Z reports (segment 22:38–23:39Z, build 95b6edda;
 * progress.md 2026-10-16, "fix8"):
 *  1. `raise skill=Healing` was refused with "takes stat=": skill= is now the same argument.
 *  2. `walk_to target="Healer"` from the Holtburg lifestone found nothing (the Healer's shop is ~290 m off, inside a
 *     building the server hadn't sent): the miss says why; a role word that fits several in view takes the nearest
 *     and names the others.
 *  3. A cast at a fellow 2 s into the caster's own portal read TargetNotAcquired as "dead, gone or moved": it now
 *     says portal space (yours, a teleport a moment ago, or the fellow's Hidden teleport state).
 *  4. `sell items=` and `vendor filter=` were unknown arguments: sell takes a list, vendor a filter.
 * Each drives the shipped tools / AgentApi code (fake host: tests/_harness/agentFake.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, vendorItemMatches } from '../packages/renderer/src/agent/AgentApi.ts';
import type { AgentResult } from '../packages/renderer/src/agent/types.ts';
import { TOOLS, TOOL_CALLER, missingRequired, sellList, unknownArgs, withArgAliases, type ToolCaller } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const tool = (name: string) => TOOLS.find((t) => t.name === name)!;

/** A caller standing in for the page: records each call and answers from `answer`. */
function caller(answer: (method: string, args: unknown[]) => unknown): ToolCaller & { calls: Array<{ method: string; args: unknown[] }> } {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    notice: null,
    async call<T>(method: string, args: unknown[] = []): Promise<T> {
      calls.push({ method, args });
      return answer(method, args) as T;
    },
  };
}

describe('1. raise skill= is stat=', () => {
  it('skill=Healing reaches the page as the stat, and is not refused', async () => {
    const t = tool('ac_raise');
    expect(unknownArgs(t, { skill: 'Healing' })).toBeNull();
    expect(missingRequired(t, { skill: 'Healing' })).toBeNull();
    expect(withArgAliases(t, { skill: 'Healing' })).toEqual({ stat: 'Healing' });
    const c = caller(() => ({ ok: true, message: 'Healing 155 → 156 (1 raise, 44,841 XP)' }));
    const out = await TOOL_CALLER.run(c, () => t.run({ skill: 'Healing' }));
    // The word used rides along, so the page can say when Healing isn't a skill (it is: no note).
    expect(c.calls[0]).toEqual({ method: 'raise', args: ['Healing', 1, 'skill'] });
    expect(out.text).toBe('Healing 155 → 156 (1 raise, 44,841 XP)');
    expect(t.description).toMatch(/skill= works the same/);
  });

  it('stat= still wins when both are given', () => {
    expect(withArgAliases(tool('ac_raise'), { stat: 'Strength', skill: 'Healing' })).toEqual({ stat: 'Strength' });
  });
});

describe('2. walk_to by a name not in view, or a role word that fits several', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => { vi.useFakeTimers(); host = new FakeHost(); api = new AgentApi(host); });
  afterEach(() => vi.useRealTimers());

  it('out on the landscape the miss says an NPC inside a building is sent only once you are at it', async () => {
    const r = await api.walkTo('Healer');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^no object matching "Healer" nearby \(from out here a shopkeeper or other NPC inside a building is not in view/);
    expect(r.message).toMatch(/Walk to the building by its map coordinates/);
  });

  it('an item lookup (appraise) keeps the plain miss: the hint is for walking to someone', async () => {
    const r = await api.appraise('Golden Gromnie');
    expect(r.message).not.toMatch(/inside a building/);
  });

  it('indoors (a dungeon) the miss is the plain one', async () => {
    host.me.cell = 0x01d20117;
    const r = await api.walkTo('Healer');
    expect(r.message).toBe('no object matching "Healer" nearby');
  });

  it('"Healer" takes the nearest "… the Healer" and names the other one', async () => {
    // Vendors (ObjectDescriptionFlags Vendor 0x200), as Holtburg's two healers are.
    host.add({ guid: 0x7a9b4001, name: 'Thelnoth Cort the Healer', itemType: 0x10, objectDescFlags: 0x200, x: 80, y: 30 });
    host.add({ guid: 0x7a9b4002, name: 'Fertroth the Healer', itemType: 0x10, objectDescFlags: 0x200, x: 80, y: 60 });
    const p = api.walkTo('Healer');
    run(api, host, 400);
    expect(api.observe().me?.task).toBe('walking to Thelnoth Cort the Healer (2 in view are named like "Healer"; also Fertroth the Healer #7a9b4002 40 m N: name one or its #id for another)');
    run(api, host, 8000);
    const r = await p;
    expect(r.message).toMatch(/arrived/);
  });

  it('a full name walks with no note', async () => {
    host.add({ guid: 0x7a9b4001, name: 'Thelnoth Cort the Healer', itemType: 0x10, objectDescFlags: 0x200, x: 80, y: 30 });
    host.add({ guid: 0x7a9b4002, name: 'Fertroth the Healer', itemType: 0x10, objectDescFlags: 0x200, x: 80, y: 60 });
    expect(api.namesakesNote('Thelnoth Cort the Healer', 0x7a9b4001)).toBe('');
    expect(api.namesakesNote('Healer', 0x7a9b4001)).toMatch(/also Fertroth the Healer/);
  });
});

describe('3. TargetNotAcquired at a fellow: portal space, not "dead or gone"', () => {
  const FELLOW = 0x50000002;
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.spells = () => [{ id: 1500, name: 'Bludgeoning Protection Other V', school: 'Life', level: 5 }];
    api = new AgentApi(host);
    host.fellows = () => [{ guid: FELLOW, name: 'Claude Bulwark', health: { cur: 40, max: 50 }, stamina: { cur: 1, max: 1 }, mana: { cur: 1, max: 1 } }];
    host.add({ guid: FELLOW, name: 'Claude Bulwark', itemType: 0x10, objectDescFlags: 0x8, x: 81, y: 22 });
    host.cast = () => { setTimeout(() => api.pushUseDone(0x42c, 'TargetNotAcquired', 'You don\'t have a target selected.'), 200); return true; };
  });
  afterEach(() => vi.useRealTimers());

  const castAt = async (): Promise<AgentResult> => {
    const p = api.cast('Bludgeoning Protection Other V', 'Claude Bulwark');
    await vi.advanceTimersByTimeAsync(3000);
    return p;
  };

  it('cast while you are in portal space says so (Arcanist into Mountain Keep, 23:25:39Z)', async () => {
    host.screenName = 'portal-space';
    const r = await castAt();
    expect(r.ok).toBe(false);
    expect(r.message).toContain('(you are in portal space: until you arrive the server finds no one around you. ac_wait types=portal for the arrival, then cast again)');
    expect(r.message).not.toMatch(/dead, gone/);
  });

  it('a moment after your arrival it blames the teleport', async () => {
    host.screenName = 'portal-space';
    run(api, host, 200);
    host.screenName = 'world';
    run(api, host, 1000);
    const r = await castAt();
    expect(r.message).toMatch(/you just teleported: the server had not yet placed Claude Bulwark beside you/);
  });

  it('a fellow the server set Hidden (ACE Player.Teleport) is in portal space', async () => {
    host.objs.get(FELLOW)!.physicsState = 0x4000;
    const r = await castAt();
    expect(r.message).toContain('Claude Bulwark is in portal space (just teleported): cast again once they arrive');
  });

  it('a fellow otherwise: maybe portal space, ask in /f; a monster keeps "dead, gone or moved"', async () => {
    const r = await castAt();
    expect(r.message).toMatch(/your fellow may be in portal space \(just teleported\) or moved on.*Ask in \/f/);
    host.add({ guid: 0x8000e941, name: 'Mite Sentry', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    host.spells = () => [{ id: 27, name: 'Flame Bolt I', school: 'War', level: 1 }];
    const p = api.cast('Flame Bolt I', 'Mite Sentry');
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).message).toMatch(/the server has no Mite Sentry where you are: it is dead, gone or moved/);
  });

  it('a fellow the client no longer holds is refused before sending, as out of view (portal or recall)', async () => {
    host.objs.delete(FELLOW);
    const r = await api.cast('Bludgeoning Protection Other V', FELLOW);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/your fellow Claude Bulwark is out of your view \(in portal space after a portal or recall/);
  });
});

describe('4. sell items= and vendor filter=', () => {
  it('sellList reads commas, semicolons, a JSON list or an array', () => {
    expect(sellList('Studded Leather Basinet, #8000c1d2')).toEqual(['Studded Leather Basinet', '#8000c1d2']);
    expect(sellList('A; B\nC')).toEqual(['A', 'B', 'C']);
    expect(sellList('["Mana Stone", "Cap"]')).toEqual(['Mana Stone', 'Cap']);
    expect(sellList(['x', ' y '])).toEqual(['x', 'y']);
    expect(sellList(undefined)).toEqual([]);
  });

  it('items= sells each, one after another, with a line each', async () => {
    const t = tool('ac_sell');
    expect(unknownArgs(t, { target: 'Shopkeeper Renald the Elder', items: 'Studded Leather Basinet' })).toBeNull();
    expect(missingRequired(t, { items: 'A, B' })).toBeNull();
    const c = caller((_m, args) => (args[0] === 'Cap' ? { ok: false, message: 'Cap was not sold\nThe Cap cannot be sold here.' } : { ok: true, message: `sold ${String(args[0])} for 5368 pyreals` }));
    const out = await TOOL_CALLER.run(c, () => t.run({ items: 'Studded Leather Basinet, Cap' }));
    expect(c.calls).toEqual([{ method: 'sell', args: ['Studded Leather Basinet', null] }, { method: 'sell', args: ['Cap', null] }]);
    expect(out.text).toBe('sold 1 of 2:\n  Studded Leather Basinet: sold Studded Leather Basinet for 5368 pyreals\n  Cap: Cap was not sold\n    The Cap cannot be sold here.');
    expect(out.isError).toBeFalsy();
  });

  it('item= alone is the one sale it was; neither is asked for', async () => {
    const c = caller(() => ({ ok: true, message: 'sold Cap for 10 pyreals' }));
    const t = tool('ac_sell');
    expect((await TOOL_CALLER.run(c, () => t.run({ item: 'Cap', amount: 2 }))).text).toBe('sold Cap for 10 pyreals');
    expect(c.calls[0]).toEqual({ method: 'sell', args: ['Cap', 2] });
    const none = await TOOL_CALLER.run(c, () => t.run({}));
    expect(none.isError).toBe(true);
  });

  it('vendor filter= goes to the page (last, for old pages) and the page lists only the matches', async () => {
    const t = tool('ac_vendor');
    expect(unknownArgs(t, { filter: 'stamina' })).toBeNull();
    const host = new FakeHost();
    const api = new AgentApi(host);
    host.vendorOpen = {
      name: 'Healer', guid: 0x7a9b4003, currency: 'Pyreals',
      items: [
        { guid: 0x8000e018, name: 'Stamina Elixir', price: 233 },
        { guid: 0x8000cf1c, name: 'Gifted Healing Kit', price: 186 },
        { guid: 0x8000e147, name: 'Heal Other II', price: 78, service: true } as { guid: number; name: string; price: number },
        { guid: 0x8000dfdb, name: 'Trade Note (100)', price: 115 },
      ],
    };
    const c = caller((m, args) => (m === 'vendor' ? api.vendorView(args[0] as string | null) : null));
    const out = await TOOL_CALLER.run(c, () => t.run({ filter: 'stamina' }));
    expect(c.calls[0]).toEqual({ method: 'vendor', args: ['stamina'] });
    const lines = out.text.split('\n');
    expect(lines[0]).toMatch(/^Healer sells \(only those matching "stamina": 1 of 4\) \(Pyreals/);
    expect(lines.slice(1)).toEqual(['  #8000e018 Stamina Elixir  233']);
    expect(api.vendorView('service').message).toMatch(/Heal Other II {2}78 {2}\(service/);
    expect(api.vendorView('service').message).not.toMatch(/Stamina Elixir/);
    expect(api.vendorView('notes').message).toMatch(/Trade Note \(100\)/);
    expect(api.vendorView('scroll').message).toMatch(/^Healer sells nothing matching "scroll" \(4 items in all/);
    expect(api.vendorView(null).message.split('\n')).toHaveLength(6);
    // With target=, the filter rides after the vendor.
    const c2 = caller(() => ({ ok: true, message: 'x' }));
    await TOOL_CALLER.run(c2, () => t.run({ target: 'Healer', filter: 'kit' }));
    expect(c2.calls[0]).toEqual({ method: 'vendorAt', args: ['Healer', 'kit'] });
  });

  it('vendorItemMatches: kinds, then the name', () => {
    expect(vendorItemMatches({ name: 'Stamina Elixir' }, 'potion')).toBe(true);
    expect(vendorItemMatches({ name: 'Mana Draught' }, 'potions')).toBe(true);
    expect(vendorItemMatches({ name: 'Adept Healing Kit' }, 'kit')).toBe(true);
    expect(vendorItemMatches({ name: 'Scroll of Revitalize Other' }, 'scroll')).toBe(true);
    expect(vendorItemMatches({ name: 'Revitalize Other I', service: true }, 'scroll')).toBe(false);
    expect(vendorItemMatches({ name: 'Health Draught' }, 'health')).toBe(true);
    expect(vendorItemMatches({ name: 'Health Draught' }, 'mana')).toBe(false);
  });
});
