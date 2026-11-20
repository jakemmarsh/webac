/**
 * PERF.long-session-record-caps — the session-long record maps stay bounded in an hours-long
 * macro session (kill, loot, appraise, sell, repeat), and what is still needed survives:
 *  - WorldObjectRecords / NonWorldObjectRecords forget what a deleted container (a rotted corpse)
 *    held, nested packs included, and cap the rest oldest-first;
 *  - the capped map main.ts uses for quiet appraisals and the stored-item stash (setBounded);
 *  - AgentApi waits leave their vital / fellow start marks however they end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CreateObjectData } from '../packages/network/src/index.ts';
import { ItemType } from '../packages/shared/src/index.ts';
import { WorldObjectRecords } from '../packages/renderer/src/network/objectSubjectRouting.ts';
import { NonWorldObjectRecords } from '../packages/renderer/src/world/NonWorldObjectRecords.ts';
import { forgetContainedRecords, setBounded } from '../packages/renderer/src/world/BoundedRecords.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost } from './_harness/agentFake.ts';

const CORPSE = 0x8000a000, PACK_IN_CORPSE = 0x8000a001, GROUND = 0x8000b000, PLAYER = 0x50000001;
const item = (containerId: number, over: Record<string, unknown> = {}) => ({
  weenieClassId: 1, name: 'Loot', value: 10, burden: 5, stackSize: 0, maxStackSize: 0, containerId,
  iconId: 0x06001234, validLocations: 0, itemType: ItemType.Gem, uiEffects: 0, usable: 1, objectDescFlags: 0, ...over,
});
const create = (guid: number, containerId: number): CreateObjectData => ({ ...item(containerId), guid } as unknown as CreateObjectData);

describe('WorldObjectRecords — a deleted corpse takes its contents along', () => {
  it('forgetContainedIn drops the 100 records the corpse held (a nested pack and its contents too) and keeps a ground one', () => {
    const rec = new WorldObjectRecords();
    rec.remember(GROUND, item(0));
    rec.remember(PACK_IN_CORPSE, item(CORPSE, { itemType: ItemType.Container }));
    for (let i = 0; i < 60; i++) rec.remember(0x8000c000 + i, item(CORPSE));
    for (let i = 0; i < 39; i++) rec.remember(0x8000d000 + i, item(PACK_IN_CORPSE));
    expect(rec.size).toBe(101);
    expect(rec.forgetContainedIn(CORPSE)).toHaveLength(100);
    expect(rec.size).toBe(1);
    expect(rec.has(GROUND)).toBe(true);
    expect(rec.has(0x8000c000)).toBe(false);
    expect(rec.has(0x8000d000)).toBe(false);
  });

  it('a corpse still there keeps its contents: an item reopened and taken before it rots is carried', () => {
    const rec = new WorldObjectRecords();
    const OTHER = 0x8000a100;
    rec.remember(0x8000c001, item(CORPSE, { name: 'Pyreal Mote' }));
    rec.remember(0x8000c002, item(OTHER));
    rec.forgetContainedIn(OTHER); // another corpse rotted
    expect(rec.containIn(0x8000c001, PLAYER)).toMatchObject({ name: 'Pyreal Mote', containerId: PLAYER });
  });

  it('10 000 remembers stay at the cap, keeping the newest; a re-remembered one counts as new', () => {
    const rec = new WorldObjectRecords();
    rec.remember(GROUND, item(0));
    for (let i = 0; i < 10_000; i++) {
      rec.remember(0x80100000 + i, item(CORPSE));
      if (i % 1000 === 0) rec.remember(GROUND, item(0)); // seen again: refreshed
    }
    expect(rec.size).toBe(WorldObjectRecords.CAP);
    expect(rec.has(0x80100000 + 9_999)).toBe(true);
    expect(rec.has(0x80100000 + 10_000 - WorldObjectRecords.CAP)).toBe(false); // GROUND took one newer slot
    expect(rec.has(0x80100000 + 10_000 - WorldObjectRecords.CAP + 1)).toBe(true);
    expect(rec.has(0x80100000)).toBe(false);
    expect(rec.has(GROUND)).toBe(true);
  });
});

describe('NonWorldObjectRecords — capped, but what the player carries is never evicted', () => {
  it('evicts the oldest uncarried records and reports them; a carried one stays whatever its age', () => {
    const carried = new Set([0x80200000]);
    const rec = new NonWorldObjectRecords((g) => carried.has(g), 512);
    const evicted: number[] = [];
    for (let i = 0; i < 2000; i++) evicted.push(...rec.remember(create(0x80200000 + i, i === 0 ? PLAYER : CORPSE)));
    expect(rec.size).toBe(512);
    expect(rec.has(0x80200000)).toBe(true);
    expect(rec.has(0x80200001)).toBe(false);
    expect(rec.has(0x80200000 + 1999)).toBe(true);
    expect(evicted).toHaveLength(2000 - 512);
    expect(evicted[0]).toBe(0x80200001);
  });

  it('forgetContainedIn drops a corpse\'s contents but not an item carried now (its containerId can be stale)', () => {
    const carried = new Set<number>();
    const rec = new NonWorldObjectRecords((g) => carried.has(g));
    rec.remember(create(0x8000c001, CORPSE));
    rec.remember(create(0x8000c002, CORPSE));
    rec.remember(create(0x8000c003, PLAYER));
    carried.add(0x8000c002);
    expect(rec.forgetContainedIn(CORPSE)).toEqual([0x8000c001]);
    expect([rec.has(0x8000c001), rec.has(0x8000c002), rec.has(0x8000c003)]).toEqual([false, true, true]);
  });

  it('the default cap holds a session of sales', () => {
    const rec = new NonWorldObjectRecords(() => false);
    for (let i = 0; i < 10_000; i++) rec.carryFromWorld(create(0x80300000 + i, 0), PLAYER);
    expect(rec.size).toBe(NonWorldObjectRecords.CAP);
  });
});

describe('setBounded / forgetContainedRecords — the capped map main.ts keeps quiet appraisals and stored items in', () => {
  it('500 examinations kept, oldest first out; a re-appraisal refreshes the one the UI shows', () => {
    const examined = new Map<number, string>();
    const SELECTED = 0x80400000;
    setBounded(examined, SELECTED, 'old text', 500);
    for (let i = 1; i <= 5000; i++) {
      setBounded(examined, 0x80400000 + i, `text ${i}`, 500);
      if (i % 400 === 0) setBounded(examined, SELECTED, `text of the selected, #${i}`, 500);
    }
    expect(examined.size).toBe(500);
    expect(examined.get(SELECTED)).toBe('text of the selected, #4800');
    expect(examined.has(0x80400000 + 5000)).toBe(true);
    expect(examined.has(0x80400001)).toBe(false);
    expect([...examined.keys()].at(-1)).toBe(0x80400000 + 5000);
  });

  it('stored-item stash: the newest 512 stores / sales are kept, so the latest chest store can still be taken back', () => {
    const stash = new Map<number, { id: number }>();
    for (let i = 0; i < 3000; i++) setBounded(stash, 0x80500000 + i, { id: 0x80500000 + i }, 512);
    expect(stash.size).toBe(512);
    expect(stash.get(0x80500000 + 2999)).toEqual({ id: 0x80500000 + 2999 });
    expect(stash.has(0x80500000)).toBe(false);
  });

  it('a container guid of 0 forgets nothing (ground objects have containerId 0)', () => {
    const m = new Map([[1, { containerId: 0 }], [2, { containerId: 0 }]]);
    expect(forgetContainedRecords(m, 0)).toEqual([]);
    expect(m.size).toBe(2);
  });
});

describe('AgentApi — a wait leaves its start marks however it ends', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.fellows = () => [{ guid: 0x50000099, name: 'Fellow', health: { cur: 100, max: 100 } }] as never;
    api = new AgentApi(host);
  });
  afterEach(() => vi.useRealTimers());
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const marks = () => [(api as any).vitalWaitStart.size, (api as any).fellowWaitStart.size, (api as any).waiters.length];

  it('a waitFor resolved by an event leaves both start-mark maps empty', async () => {
    for (let n = 0; n < 50; n++) {
      const w = api.waitFor({ chatMatch: 'tells you', healthBelow: 0.5, fellowBelow: 0.5 }, 60_000);
      expect(marks()).toEqual([1, 1, 1]);
      api.pushChat(`Jake tells you, "${n}"`, 0x03);
      expect((await w).length).toBeGreaterThan(0);
    }
    expect(marks()).toEqual([0, 0, 0]);
  });

  it('a timed-out wait leaves them too', async () => {
    const w = api.waitFor({ healthBelow: 0.5, fellowBelow: 0.5 }, 1000);
    vi.advanceTimersByTime(1100);
    expect(await w).toEqual([]);
    expect(marks()).toEqual([0, 0, 0]);
  });
});
