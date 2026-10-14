/**
 * AGENT.play-reports-2026-10-10 — bugs four agents hit playing through the
 * agent tools (end-of-retail local ACE, 2026-10-10), each driven through the
 * real AgentApi on the fake host (tests/_harness/agentFake.ts):
 *   drop by name took the worn pair; parallel drops were refused without the
 *   reason; remembered places read "last seen 0s ago" after a reload; item
 *   names from chat ("Pine Lugian Hammer") matched nothing; chat_match waits
 *   woke on unrelated events and missed a tell from just before; a letter's
 *   text never came back from ac_use; a cast at a dead target went to self.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, bestNameMatch, nameMatchScore } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObject, seenAgoText } from '../packages/renderer/src/agent/format.ts';
import { INCOMING_TELL, waitFilter } from '../tools/ac-agent/tools.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const REFUSAL = 'You can only move or use one item at a time';

describe('agent play reports 2026-10-10', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  /** A client that, like main.ts's sendGameAction, allows one inventory request at a time and says why not. */
  function oneAtATime(answerMs = 600): { dropped: number[] } {
    let pending = 0;
    const dropped: number[] = [];
    host.busy = () => pending !== 0;
    host.drop = (g: number) => {
      if (pending) { api.pushChat(REFUSAL, 0x1a); return false; }
      pending = g;
      setTimeout(() => { host.inv = host.inv.filter((i) => i.guid !== g); dropped.push(g); pending = 0; }, answerMs);
      return true;
    };
    return { dropped };
  }

  it('drop by name takes the spare in the pack, not the pair you wear (item 1)', async () => {
    host.inv = [
      { guid: 0x80007ab2, name: 'Chainmail Leggings', where: 'equipped' },
      { guid: 0x8000bfce, name: 'Chainmail Leggings', where: 'main pack' },
    ];
    const { dropped } = oneAtATime();
    const p = api.drop('Chainmail Leggings');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await p).toMatchObject({ ok: true, message: 'dropped Chainmail Leggings' });
    expect(dropped).toEqual([0x8000bfce]);
    // With only the worn pair left, a drop by name takes it off and drops it, as a drag from the paperdoll does.
    const q = api.drop('chainmail leggings');
    await vi.advanceTimersByTimeAsync(1000);
    expect((await q).message).toBe('dropped Chainmail Leggings (it was worn: taken off and dropped)');
    expect(dropped).toEqual([0x8000bfce, 0x80007ab2]);
  });

  it('drops made together go out one after another, and a refusal says why (item 2)', async () => {
    host.inv = [1, 2, 3].map((n) => ({ guid: 0x80000100 + n, name: `Rusty Dagger ${n}`, where: 'main pack' }));
    const { dropped } = oneAtATime();
    const all = Promise.all([api.drop(0x80000101), api.drop(0x80000102), api.drop(0x80000103)]);
    await vi.advanceTimersByTimeAsync(5000);
    const rs = await all;
    expect(rs.map((r) => r.ok)).toEqual([true, true, true]);
    expect(dropped).toEqual([0x80000101, 0x80000102, 0x80000103]);
    // When the client still refuses (an attack in progress), the reason comes back.
    host.inv = [{ guid: 0x80000104, name: 'Bone', where: 'main pack' }];
    host.busy = () => false;
    host.drop = () => { api.pushChat('You cannot move or use an item while attacking', 0x1a); return false; };
    const r = await api.drop('Bone');
    expect(r).toEqual({ ok: false, message: 'not dropped: Bone: refused (You cannot move or use an item while attacking)' });
    // The server refusing (an undroppable item) never reads as "dropped" (live, 2026-10-10: "dropped Pathwarden Token: … can't be dropped").
    host.inv = [{ guid: 0x80000105, name: 'Pathwarden Token', where: 'main pack' }];
    host.drop = () => { setTimeout(() => api.pushChat("The Pathwarden Token can't be dropped", 0x1a), 300); return true; };
    const t = api.drop('Pathwarden Token');
    await vi.advanceTimersByTimeAsync(1000);
    expect(await t).toEqual({ ok: false, message: "not dropped: Pathwarden Token: The Pathwarden Token can't be dropped" });
  });

  it('names match the way players say them: with the material, any word order, plurals (item 6)', () => {
    expect(nameMatchScore('Lugian Hammer', 'Lugian Hammer')).toBe(5);
    expect(nameMatchScore('hammer', 'Lugian Hammer')).toBe(4);
    expect(nameMatchScore('Pine Lugian Hammer', 'Lugian Hammer')).toBe(3);
    expect(nameMatchScore('hammer lugian', 'Lugian Hammer')).toBe(2);
    expect(nameMatchScore('Lugian Hammers', 'Lugian Hammer')).toBe(3);
    expect(nameMatchScore('arrows', 'Arrow')).toBe(2);
    // A one-word name is not found inside any longer phrase ("Pine" is not "Pine Lugian Hammer").
    expect(nameMatchScore('Pine Lugian Hammer', 'Pine')).toBe(0);
    expect(nameMatchScore('Drudge Skulker', 'Mosswart')).toBe(0);
    expect(bestNameMatch('hammer', [{ n: 'Hammer Shaft' }, { n: 'Hammer' }], (x) => x.n)?.item.n).toBe('Hammer');
  });

  it('appraise finds a carried item by the name the give line used (item 6)', async () => {
    host.inv = [{ guid: 0x80000c01, name: 'Lugian Hammer', where: 'main pack' }];
    host.appraisals.set(0x80000c01, 'Lugian Hammer\nValue: 40');
    const p = api.appraise('Pine Lugian Hammer');
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toMatchObject({ ok: true, message: 'Lugian Hammer\nValue: 40' });
    expect(host.appraised).toEqual([0x80000c01]);
    // Not anywhere: the message says where it looked.
    expect((await api.appraise('Golden Gromnie')).message).toBe('no object matching "Golden Gromnie" nearby or in your inventory');
  });

  it('a better world match beats a weak inventory one; a tie goes to the inventory', () => {
    host.inv = [{ guid: 0x80000d01, name: 'Drudge Charm', where: 'main pack' }];
    host.add({ guid: 0x80000d02, name: 'Drudge', itemType: 0x10, objectDescFlags: 0x10, x: 82, y: 22 });
    expect(api.resolve('Drudge')).toBe(0x80000d02);
    expect(api.resolve('Drudge Charm')).toBe(0x80000d01);
  });

  it('remembered places keep their age across a page reload (item 4)', () => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    let wall = 1_760_000_000_000;
    host.wallClock = () => wall;
    host.add({ guid: 0x80000e01, name: 'Portal to Holtburg', objectDescFlags: 0x40000, x: 80, y: 60 });
    run(api, host, 200);
    host.objs.get(0x80000e01)!.lost = true; // out of range: released first, deleted 25 s later (world/ObjectMaint.ts)
    run(api, host, 200);
    host.objs.delete(0x80000e01);
    run(api, host, 200);
    expect(api.observe().remembered[0]).toMatchObject({ name: 'Portal to Holtburg', seenAgo: 0 });
    // The page reloads 10 minutes later: a new API, a page clock back at 0, the same browser storage.
    wall += 600_000;
    const host2 = new FakeHost();
    host2.wallClock = () => wall;
    const api2 = new AgentApi(host2);
    run(api2, host2, 100);
    const r = api2.observe().remembered;
    expect(r.map((o) => o.name)).toEqual(['Portal to Holtburg']);
    expect(r[0].seenAgo).toBe(600);
    expect(formatObject(r[0])).toContain('last seen 10m ago');
    expect([seenAgoText(45), seenAgoText(600), seenAgoText(5 * 3600), seenAgoText(3 * 86400)]).toEqual(['45s', '10m', '5h', '3d']);
  });

  it('a place saved before the wall clock (page ms only) shows no age rather than "0s ago"', () => {
    const store = new Map<string, string>([['acAgent.places.Claude Test', JSON.stringify([[0x80000e02, { name: 'Sentry', kind: 'npc', cell: 0xa9b40019, x: 80, y: 90, z: 94, t: 123456 }]])]]);
    vi.stubGlobal('localStorage', { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); } });
    run(api, host, 100);
    const [sentry] = api.observe().remembered;
    expect(sentry.name).toBe('Sentry');
    expect(sentry.seenAgo).toBeUndefined();
    expect(formatObject(sentry)).not.toContain('last seen');
  });

  it('a chat_match wait wakes only on a matching line, not on a monster coming into view (item 7)', async () => {
    run(api, host, 100);
    const w = api.wait({ chatMatch: 'Bulwark' }, 40_000);
    host.add({ guid: 0x80000f01, name: 'Drudge Skulker', itemType: 0x10, objectDescFlags: 0x10, x: 90, y: 30 });
    run(api, host, 200);
    api.pushChat('Claude Arcanist says, "ready?"', 0x02);
    let done = false;
    void w.then(() => { done = true; });
    await vi.advanceTimersByTimeAsync(100);
    expect(done).toBe(false);
    api.pushChat('Bulwark tells you, "on my way"', 0x03);
    expect((await w).map((e) => e.text)).toEqual(['(tell) Bulwark tells you, "on my way"']);
  });

  it('a wait sees what arrived since the last look, and a since_seq from before a reload is ignored (item 7)', async () => {
    api.observe();
    api.pushChat('Bulwark tells you, "meet at the lifestone"', 0x03);
    // The tell came in between the observe and the wait: the wait returns it at once.
    expect((await api.wait({ chatMatch: 'Bulwark' }, 1000)).map((e) => e.text)).toEqual(['(tell) Bulwark tells you, "meet at the lifestone"']);
    // Seen now: the next wait waits for a new one.
    const next = api.wait({ chatMatch: 'Bulwark' }, 1000);
    await vi.advanceTimersByTimeAsync(1100);
    expect(await next).toEqual([]);
    // since_seq 5000 is from the page before a reload (events restarted): the last look counts instead.
    api.pushChat('Bulwark tells you, "here"', 0x03);
    expect((await api.wait({ chatMatch: 'Bulwark', sinceSeq: 5000 }, 1000)).map((e) => e.text)).toEqual(['(tell) Bulwark tells you, "here"']);
  });

  it('ac_wait types=tell waits for tells; other types and chat_match pass through (item 7)', () => {
    expect(waitFilter({ types: 'tell' })).toEqual({ chatMatch: INCOMING_TELL });
    // tell + chat_match is OR (stream rehearsal 2, 2026-10-13): any tell to you, or a line matching chat_match.
    const both = waitFilter({ types: 'tell,death', chat_match: 'Bulwark' });
    expect(both.types).toEqual(['death']);
    const re = new RegExp(both.chatMatch!, 'i');
    expect(re.test('(tell) Bulwark tells you, "hi"')).toBe(true);
    expect(re.test('(tell) Alcott tells you, "hi"')).toBe(true);
    expect(re.test('(channel) [Fellowship] Claude Bulwark says, "pulling"')).toBe(true);
    expect(re.test('(tell) You tell Bulwark, "hi"')).toBe(false);
    expect(waitFilter({ types: 'chat, target-died', since_seq: '42' })).toEqual({ types: ['chat', 'target-died'], sinceSeq: 42 });
    expect(new RegExp(waitFilter({ types: 'tell' }).chatMatch!, 'i').test('(tell) Bulwark tells you, "hi"')).toBe(true);
    expect(new RegExp(waitFilter({ types: 'tell' }).chatMatch!, 'i').test('(say) Bulwark says, "tell me"')).toBe(false);
  });

  it('using a letter returns its text, every page, asking for the pages the server has not sent (item 8)', async () => {
    host.inv = [{ guid: 0x80000a01, name: 'Letter From Home', where: 'main pack' }];
    const pages: Array<{ author: string; text: string | null }> = [{ author: 'Mother', text: null }, { author: 'Mother', text: null }];
    let open = false;
    const asked: number[] = [];
    host.use = (g: number) => {
      host.sent.push(`use ${g.toString(16)}`);
      setTimeout(() => { open = true; }, 200); // BookDataResponse: no page text
      setTimeout(() => { pages[0].text = 'Dear child,\nwe miss you.'; }, 500); // the page the book opened on
      return true;
    };
    host.book = () => (open ? { guid: 0x80000a01, title: 'Letter From Home', pages } : null);
    host.bookPage = (i: number) => { asked.push(i); setTimeout(() => { pages[i].text = 'Write soon. Love, Mother'; }, 300); return true; };
    const p = api.use('Letter From Home');
    await vi.advanceTimersByTimeAsync(8000);
    const r = await p;
    expect(asked).toEqual([1]);
    expect(r.message).toBe([
      'used Letter From Home:',
      '  Letter From Home reads (2 pages; ac_close name=Book when done):',
      '  [page 1, by Mother] Dear child, / we miss you.',
      '  [page 2, by Mother] Write soon. Love, Mother',
    ].join('\n'));
  });

  it('a cast at a target that is gone is refused, never turned on yourself (item 9)', async () => {
    host.spells = () => [{ id: 0x5c, name: 'Lightning Streak II', school: 'War', level: 2 }];
    host.add({ guid: 0x80000b01, name: 'Drudge Slinker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    host.objs.delete(0x80000b01); // it died and its object left before the cast
    expect(await api.cast('Lightning Streak II', 0x80000b01)).toEqual({ ok: false, message: 'Lightning Streak II not cast: target gone (#80000b01 is dead or out of view)' });
    // The selected target is dying (its death animation): refused too.
    host.add({ guid: 0x80000b02, name: 'Drudge Sneaker', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    host.target = 0x80000b02;
    host.dying.add(0x80000b02);
    expect(await api.cast('Lightning Streak II', null)).toMatchObject({ ok: false, message: 'Lightning Streak II not cast: your target Drudge Sneaker is dead (pick another target)' });
    // It dies while an earlier cast still winds down.
    host.add({ guid: 0x80000b03, name: 'Drudge Robber', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 30 });
    let busy = true;
    host.busy = () => busy;
    const c = api.cast('Lightning Streak II', 'Drudge Robber');
    setTimeout(() => { host.objs.delete(0x80000b03); busy = false; }, 600);
    await vi.advanceTimersByTimeAsync(1000);
    expect((await c).message).toBe('Lightning Streak II not cast: target gone (#80000b03 is dead or out of view)');
    expect(host.sent.filter((s) => s.startsWith('cast'))).toEqual([]);
  });

  it('equip waits its turn and reports the server\'s refusal line', async () => {
    host.inv = [{ guid: 0x80000c11, name: 'Leather Cap', where: 'main pack' }];
    host.wield = () => { api.pushChat('You are not experienced enough to use this item.', 0x1a); return true; };
    const p = api.equip('Leather Cap');
    await vi.advanceTimersByTimeAsync(500);
    expect(await p).toEqual({ ok: false, message: 'not equipped: Leather Cap: You are not experienced enough to use this item.' });
    host.inv = [{ guid: 0x80000c11, name: 'Leather Cap', where: 'equipped' }];
    expect((await api.equip('Leather Cap')).message).toBe('Leather Cap is already equipped');
  });
});
