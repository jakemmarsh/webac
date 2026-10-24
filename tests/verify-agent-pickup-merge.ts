/**
 * BUG.agent-pickup-merge-misreport — a pick-up (or a move between packs) that the client sends as a StackableMerge
 * onto a stack you already carry is done when that stack grows: the picked item's own guid never reaches the pack
 * (ACE merges it and removes it with InventoryRemoveObject). Live, 20 Practice Arrows out of a chest merged into the
 * pack's stack and pickUp answered "no answer from the server … it is not in your pack yet" (local ACE, 2026-10-24).
 * Drives the real AgentApi against the FakeHost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, type AgentPlacementSent } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

/** Tick until the client has sent `line` (the agent's own waits run first), so the server's answer comes after it. */
async function untilSent(api: AgentApi, host: FakeHost, line: string): Promise<void> {
  for (let t = 0; t < 3000 && !host.sent.includes(line); t += 100) { run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  expect(host.sent).toContain(line);
}

const CHEST_ARROWS = 0x80000331;
const PACK_ARROWS = 0x80000100;

describe('BUG.agent-pickup-merge-misreport: a pick-up that merges onto a stack is a pick-up', () => {
  let host: FakeHost;
  let api: AgentApi;
  let sent: AgentPlacementSent | null;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    sent = null;
    host.add({ guid: CHEST_ARROWS, name: 'Practice Arrow', itemType: 0x100, x: 80.5, y: 20, stack: 20 });
    host.inv.push({ guid: PACK_ARROWS, name: 'Practice Arrow', where: 'main pack', stack: 50 });
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  /** The server's merge: the pack stack grows by `n`, and the source goes when all of it merged. */
  const merge = (n: number, sourceLeft = 0): void => {
    host.inv.find((i) => i.guid === PACK_ARROWS)!.stack = 50 + n;
    if (sourceLeft) host.objs.get(CHEST_ARROWS)!.stack = sourceLeft;
    else host.objs.delete(CHEST_ARROWS);
  };

  it('the client sent a StackableMerge onto the pack stack: ok, and says it merged', async () => {
    host.lastPlacement = (g) => (g === CHEST_ARROWS ? sent : null);
    const pick = host.pickUp;
    host.pickUp = (g) => { sent = { kind: 'merge', targetId: PACK_ARROWS, amount: 20 }; return pick(g); };
    const p = api.pickUp(CHEST_ARROWS);
    await untilSent(api, host, `pickup ${CHEST_ARROWS.toString(16)}`);
    merge(20);
    const r = (await settle(api, host, p, 3000))!;
    expect(r).toEqual({ ok: true, message: 'picked up 20 Practice Arrow: merged into your stack of 50 (now 70)' });
  });

  it('part of it merged (the pack stack nearly full): ok, with what was left behind', async () => {
    host.lastPlacement = () => ({ kind: 'merge', targetId: PACK_ARROWS, amount: 5 });
    const p = api.pickUp(CHEST_ARROWS);
    await untilSent(api, host, `pickup ${CHEST_ARROWS.toString(16)}`);
    merge(5, 15);
    const r = (await settle(api, host, p, 3000))!;
    expect(r).toEqual({ ok: true, message: 'picked up 5 Practice Arrow: merged into your stack of 50 (now 55); 15 left where it lay' });
  });

  it('a host that cannot say what it sent: a stack of the same thing that grew is the merge', async () => {
    const p = api.pickUp(CHEST_ARROWS);
    await untilSent(api, host, `pickup ${CHEST_ARROWS.toString(16)}`);
    merge(20);
    const r = (await settle(api, host, p, 3000))!;
    expect(r?.ok).toBe(true);
    expect(r?.message).toBe('picked up 20 Practice Arrow: merged into your stack of 50 (now 70)');
  });

  it('a whole put still reports the item in the pack', async () => {
    host.lastPlacement = () => ({ kind: 'put', containerId: host.me.guid });
    const p = api.pickUp(CHEST_ARROWS);
    await untilSent(api, host, `pickup ${CHEST_ARROWS.toString(16)}`);
    host.objs.delete(CHEST_ARROWS);
    host.inv.push({ guid: CHEST_ARROWS, name: 'Practice Arrow', where: 'main pack', stack: 20 });
    const r = (await settle(api, host, p, 3000))!;
    expect(r).toEqual({ ok: true, message: "picked up Practice Arrow: it's in your pack now" });
  });

  it('a put sent: another stack of the same name growing is not this pick-up landing', async () => {
    host.lastPlacement = () => ({ kind: 'put', containerId: host.me.guid });
    const p = api.pickUp(CHEST_ARROWS);
    await untilSent(api, host, `pickup ${CHEST_ARROWS.toString(16)}`);
    host.inv.find((i) => i.guid === PACK_ARROWS)!.stack = 51;
    const r = (await settle(api, host, p, 20_000))!;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^no answer from the server about Practice Arrow in \d+ s; it is not in your pack yet/);
  });

  it('a real no-answer (merge sent, nothing changed) still reports the timeout', async () => {
    host.lastPlacement = () => ({ kind: 'merge', targetId: PACK_ARROWS, amount: 20 });
    const p = api.pickUp(CHEST_ARROWS);
    const r = (await settle(api, host, p, 20_000))!;
    expect(r).not.toBeNull();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^no answer from the server about Practice Arrow in 15 s; it is not in your pack yet/);
  });

  it('the merged source is destroyed before the answer is built: the text still names it, not its guid', async () => {
    host.lastPlacement = () => ({ kind: 'merge', targetId: PACK_ARROWS, amount: 20 });
    const p = api.pickUp(CHEST_ARROWS);
    await untilSent(api, host, `pickup ${CHEST_ARROWS.toString(16)}`);
    merge(20); // the source leaves the host entirely (ACE InventoryRemoveObject)
    expect(host.object(CHEST_ARROWS)).toBeNull();
    const r = (await settle(api, host, p, 3000))!;
    expect(r.ok).toBe(true);
    expect(r.message).toContain('Practice Arrow');
    expect(r.message).not.toMatch(/#8000/);
  });

  it('a stack listed only in the open chest\'s window (no world object): named from the window, and what stayed there said', async () => {
    host.objs.delete(CHEST_ARROWS);
    const CHEST = 0x80000330;
    host.container = { guid: CHEST, items: [{ guid: CHEST_ARROWS, name: 'Practice Arrow', stack: 20 }] };
    host.lastPlacement = () => ({ kind: 'merge', targetId: PACK_ARROWS, amount: 5 });
    const p = api.pickUp(CHEST_ARROWS);
    await untilSent(api, host, `pickup ${CHEST_ARROWS.toString(16)}`);
    host.inv.find((i) => i.guid === PACK_ARROWS)!.stack = 55;
    host.container = { guid: CHEST, items: [{ guid: CHEST_ARROWS, name: 'Practice Arrow', stack: 15 }] };
    const r = (await settle(api, host, p, 3000))!;
    expect(r).toEqual({ ok: true, message: 'picked up 5 Practice Arrow: merged into your stack of 50 (now 55); 15 left where it lay' });
  });

  it('a split into the pack (a new stack of the same thing arrives): ok', async () => {
    host.lastPlacement = () => ({ kind: 'split', containerId: host.me.guid, amount: 10 });
    const p = api.pickUp(CHEST_ARROWS);
    await untilSent(api, host, `pickup ${CHEST_ARROWS.toString(16)}`);
    host.objs.get(CHEST_ARROWS)!.stack = 10;
    host.inv.push({ guid: 0x80000400, name: 'Practice Arrow', where: 'main pack', stack: 10 });
    const r = (await settle(api, host, p, 3000))!;
    expect(r).toEqual({ ok: true, message: 'picked up 10 Practice Arrow: a new stack of 10 in your pack; 10 left where it lay' });
  });
});

describe('BUG.agent-pickup-merge-misreport sweep: moveItem onto a pack that merges part of a stack', () => {
  let host: FakeHost;
  let api: AgentApi;
  const SACK = 0x80000500, SACK_ARROWS = 0x80000501;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
    host.inv.push(
      { guid: PACK_ARROWS, name: 'Practice Arrow', where: 'main pack', stack: 20 },
      { guid: SACK, name: 'Sack', where: 'pack slots' },
      { guid: SACK_ARROWS, name: 'Practice Arrow', where: 'Sack', inside: SACK, stack: 245 },
    );
    host.packs = () => [{ slot: 0, guid: host.me.guid, capacity: 102, count: 1 }, { slot: 1, guid: SACK, capacity: 24, count: 1 }];
    host.itemSlots = () => [
      { guid: PACK_ARROWS, name: 'Practice Arrow', packSlot: 0, stack: 20, maxStack: 250, wcid: 300, isPack: false, equipped: false },
      { guid: SACK, name: 'Sack', packSlot: -1, stack: 1, maxStack: 1, wcid: 166, isPack: true, equipped: false },
    ];
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('5 of 20 merge onto the Sack\'s stack of 245: moved, said plainly, not "no answer"', async () => {
    host.placeItem = (g) => { host.sent.push(`place ${g.toString(16)}`); return true; };
    host.lastPlacement = () => ({ kind: 'merge', targetId: SACK_ARROWS, amount: 5 });
    const p = api.moveItem(PACK_ARROWS, 'Sack');
    await untilSent(api, host, `place ${PACK_ARROWS.toString(16)}`);
    host.inv.find((i) => i.guid === SACK_ARROWS)!.stack = 250;
    host.inv.find((i) => i.guid === PACK_ARROWS)!.stack = 15;
    const r = (await settle(api, host, p, 6000))!;
    expect(r).toEqual({ ok: true, message: 'moved 5 Practice Arrow: merged into your stack of 245 (now 250); 15 left in your main pack (your Sack)' });
  });

  it('a merge that nothing came of still fails', async () => {
    host.placeItem = () => true;
    host.lastPlacement = () => ({ kind: 'merge', targetId: SACK_ARROWS, amount: 5 });
    const r = (await settle(api, host, api.moveItem(PACK_ARROWS, 'Sack'), 8000))!;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^not moved: Practice Arrow: no answer from the server/);
  });
});
