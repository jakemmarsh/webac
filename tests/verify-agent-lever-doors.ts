/**
 * Doors a lever opens (AgentApi walkTo / use / observe). A door whose ItemUseable is No (ACE weenie 2180
 * "doordungeonactivated", Usable 1) opens only through its ActivationTarget links (a Lever "leverboxswitch", a
 * Pressure Plate): retail's ItemHolder::UseObject refuses a Use of it client-side, "You can't open or close this
 * Door that way" (input/UseObject.ts). Skeleton dungeon, landblock 0x0145, 2026-10-14: Bulwark's walks used door
 * 0x70145013 about sixty times in an hour and tried a key on it. docs/agent-play.md, "Doors a lever opens".
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { formatObservation } from '../packages/renderer/src/agent/format.ts';
import { decideUseObject, USEABLE_NO } from '../packages/renderer/src/input/UseObject.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const inBand = (v: number, c: number, half: number): boolean => Math.abs(v - c) < half;
/** A 7 m box round (80, 40) with a doorway in the west wall (x 76.5) and one in the east wall (x 83.5). */
function box(host: FakeHost, open: { west: () => boolean; east: () => boolean }): void {
  host.wall = (x, y) => {
    const onWall = (inBand(x, 76.5, 0.4) || inBand(x, 83.5, 0.4)) && y > 36.1 && y < 43.9 || (inBand(y, 36.5, 0.4) || inBand(y, 43.5, 0.4)) && x > 76.1 && x < 83.9;
    const west = inBand(x, 76.5, 0.5) && y > 39.4 && y < 40.6;
    const east = inBand(x, 83.5, 0.5) && y > 39.4 && y < 40.6;
    return onWall && !(west && open.west()) && !(east && open.east());
  };
}

describe('doors a lever opens', () => {
  let host: FakeHost;
  let api: AgentApi;
  let lines: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    lines = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { lines.push(String(m)); });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it('retail refuses the Use of such a door in the client (the line the agent reads)', () => {
    const d = decideUseObject(
      { guid: 0x70145013, name: 'Door', containerId: 0, wielderId: 0, bitfield: 0x1004, itemType: 0x80, useability: USEABLE_NO, itemsCapacity: 0, containersCapacity: 0, combatUse: 0, validLocations: 0, location: 0, ownedByPlayer: false, isPlayer: false },
      { playerGuid: 0x50000001, groundObject: 0, allowSelection: true, skipDetermine: false, selectedGuid: 0, attackable: false, peaceMode: true, confirmVolatileRare: false, selectionCompatible: false },
    );
    expect(d).toEqual({ kind: 'message', text: "You can't open or close this Door that way" });
    expect(AgentApi.DOOR_NOT_BY_HAND.test(d.kind === 'message' ? d.text : '')).toBe(true);
    // The 1999 client's literal ends "that way." (reference/ac1999 modules.csv): the same match.
    expect(AgentApi.DOOR_NOT_BY_HAND.test("You can't open or close this Door that way.")).toBe(true);
  });

  it('observe marks every door open or closed, and one a lever opens as such', () => {
    host.add({ guid: 0x70145013, name: 'Door', objectDescFlags: 0x1000, physicsState: 0, useability: USEABLE_NO, x: 80, y: 26 });
    host.add({ guid: 0x70145014, name: 'Door', objectDescFlags: 0x1000, physicsState: 0x4, x: 84, y: 20 });
    const text = formatObservation(api.observe());
    expect(text).toMatch(/#70145013  Door  \[door\]  .*  closed  opened by a lever or switch, not by hand/);
    expect(text).toMatch(/#70145014  Door  \[door\]  .*  open/);
    expect(text).not.toMatch(/#70145014 .*not by hand/);
  });

  it('a walk never uses a shut lever door in its doorway: it routes round it, and says so', async () => {
    let eastOpen = false;
    box(host, { west: () => false, east: () => eastOpen });
    host.me.x = 70; host.me.y = 40;
    const lever = host.add({ guid: 0x70145013, name: 'Door', objectDescFlags: 0x1000, physicsState: 0, useability: USEABLE_NO, x: 75.8, y: 40 });
    const eastDoor = host.add({ guid: 0x8000004a, name: 'Door', objectDescFlags: 0x1000, physicsState: 0, x: 84.2, y: 40 });
    host.add({ guid: 0x8000004b, name: 'Skeleton Warrior', itemType: 0x10, cell: 0xa9b40105, x: 80, y: 40 });
    host.route = ((_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }, opts?: { closed?: Array<{ x: number; y: number; z: number }> }) => {
      const westShut = opts?.closed?.some((c) => Math.hypot(c.x - 76.5, c.y - 40) <= 2.5);
      return westShut ? [{ x: 85, y: 40, z: 94 }, { x: 83.5, y: 40, z: 94 }, to] : [{ x: 76.5, y: 40, z: 94 }, to];
    }) as typeof host.route;
    const use = host.use;
    host.use = (g: number) => { if (g === eastDoor.guid) { eastOpen = true; eastDoor.physicsState = 0x4; } return use(g); };
    const p = api.walkTo('Skeleton Warrior', { within: 1.5 });
    run(api, host, 120_000);
    const r = await p;
    expect(r.ok).toBe(true);
    expect(host.sent).not.toContain(`use ${lever.guid.toString(16)}`);
    expect(host.sent).toContain(`use ${eastDoor.guid.toString(16)}`);
    expect(lines.some((l) => /Door #70145013 shut, and it won't open by hand \(a lever or switch opens it\); routing round it/.test(l))).toBe(true);
    expect(r.message).toMatch(/went round Door #70145013: it is shut and won't open by hand/);
  });

  it('with no other way, the walk stops without using the door or a key on it, and names the levers by it', async () => {
    box(host, { west: () => false, east: () => false });
    host.me.x = 70; host.me.y = 40;
    const door = host.add({ guid: 0x70145013, name: 'Door', objectDescFlags: 0x1000, physicsState: 0, useability: USEABLE_NO, x: 75.8, y: 40 });
    host.add({ guid: 0x70145012, name: 'Lever', itemType: 0x80, useability: 0x30, x: 72, y: 32 });
    host.add({ guid: 0x7014500e, name: 'Pressure Plate', itemType: 0x80, useability: USEABLE_NO, x: 66, y: 40 });
    host.add({ guid: 0x70145099, name: 'Lever', itemType: 0x80, x: 150, y: 40 }); // 74 m off the door: not its lever
    host.add({ guid: 0x8000004b, name: 'Skeleton Warrior', itemType: 0x10, cell: 0xa9b40105, x: 80, y: 40 });
    host.inv.push({ guid: 0x80000050, name: 'Academy Library Key', where: 'pack' });
    host.route = ((_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }, opts?: { closed?: unknown[] }) =>
      (opts?.closed?.length ? null : [{ x: 76.5, y: 40, z: 94 }, to])) as typeof host.route;
    const p = api.walkTo('Skeleton Warrior', { within: 1.5 });
    run(api, host, 120_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(host.sent.filter((s) => s.startsWith('use'))).toEqual([]);
    expect(r.message).toMatch(/Door #70145013 won't open by hand \("You can't open or close this Door that way"\): something else opens it/);
    expect(r.message).toMatch(/nearby: Lever #70145012 \d+ m [NSEW]+, Pressure Plate #7014500e \d+ m [NSEW]+ \(step on it\)\)/);
    expect(r.message).not.toMatch(/70145099/);
    expect(r.message).not.toMatch(/locked, or it needs a key/);

    // A partner pulls the lever: the door stands open (ACE Door.Open sets Ethereal). The walk goes through, never using it.
    door.physicsState = 0x4;
    host.wall = () => false;
    host.route = ((_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }, opts?: { closed?: unknown[] }) =>
      (opts?.closed?.length ? null : [{ x: 76.5, y: 40, z: 94 }, to])) as typeof host.route;
    const p2 = api.walkTo('Skeleton Warrior', { within: 1.5 });
    run(api, host, 60_000);
    const r2 = await p2;
    expect(r2.ok).toBe(true);
    expect(host.sent.filter((s) => s.startsWith('use'))).toEqual([]);
    expect(r2.message).not.toMatch(/won't open by hand/);
  });

  it('a door whose Use got the client\'s refusal is given up at once, never keyed, and never tried again by later walks', async () => {
    box(host, { west: () => false, east: () => false });
    host.me.x = 70; host.me.y = 40;
    // No useability sent (the host can't say): only the refusal line tells.
    const door = host.add({ guid: 0x70145013, name: 'Door', objectDescFlags: 0x1000, physicsState: 0, x: 75.8, y: 40 });
    host.add({ guid: 0x70145012, name: 'Lever', itemType: 0x80, x: 72, y: 32 });
    host.add({ guid: 0x8000004b, name: 'Skeleton Warrior', itemType: 0x10, cell: 0xa9b40105, x: 80, y: 40 });
    host.inv.push({ guid: 0x80000050, name: 'Academy Library Key', where: 'pack' });
    host.routeTo = [{ x: 76.5, y: 40, z: 94 }];
    const use = host.use;
    host.use = (g: number) => { if (g === door.guid) api.pushChat("You can't open or close this Door that way", 0x1a); return use(g); };
    const p = api.walkTo('Skeleton Warrior', { within: 1.5 });
    run(api, host, 120_000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(host.sent.filter((s) => s === `use ${door.guid.toString(16)}`)).toHaveLength(1);
    expect(host.sent.some((s) => s.startsWith('usewith'))).toBe(false);
    expect(lines.some((l) => /Door #70145013 won't open by hand \(a lever or switch opens it\); routing round it/.test(l))).toBe(true);
    expect(r.message).toMatch(/won't open by hand.*nearby: Lever #70145012/);
    // Remembered: observe marks it, and the next walk doesn't use it.
    expect(formatObservation(api.observe())).toMatch(/#70145013  Door .*opened by a lever or switch, not by hand/);
    const p2 = api.walkTo('Skeleton Warrior', { within: 1.5 });
    run(api, host, 120_000);
    await p2;
    expect(host.sent.filter((s) => s === `use ${door.guid.toString(16)}`)).toHaveLength(1);
  });

  it('ac_use on such a door answers at once, with no walk and nothing sent', async () => {
    host.add({ guid: 0x70145013, name: 'Door', objectDescFlags: 0x1000, physicsState: 0, useability: USEABLE_NO, x: 80, y: 40 });
    host.add({ guid: 0x70145012, name: 'Lever', itemType: 0x80, x: 84, y: 40 });
    const r = await api.use(0x70145013);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/^Door #70145013 won't open by hand .*nearby: Lever #70145012 .*It is closed now/);
    expect(host.sent).toEqual([]);
    expect(host.keys.size).toBe(0);
  });

  it('ac_use on a lever reports the door near you that swung open', async () => {
    const door = host.add({ guid: 0x70145013, name: 'Door', objectDescFlags: 0x1000, physicsState: 0, useability: USEABLE_NO, x: 80, y: 28 });
    host.add({ guid: 0x70145012, name: 'Lever', itemType: 0x80, x: 81, y: 21 });
    host.use = (g: number) => {
      host.sent.push(`use ${g.toString(16)}`);
      // ACE Switch.OnActivate: the lever's motion, then its ActivationTarget door's ActOnUse opens it.
      if (g === 0x70145012) setTimeout(() => { door.physicsState = 0x4; }, 1500);
      return true;
    };
    const p = api.use(0x70145012);
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(r.message).toMatch(/^used Lever:\n {2}Door #70145013 \d+ m N swung open \(the door this opens: it won't open by hand\)/);
  });

  it('sweep: loot stops at a container\'s refusal instead of using it again and waiting out 20 s (ACE Chest "is locked")', async () => {
    host.add({ guid: 0x80000910, name: 'Chest', itemType: 0x200, x: 81, y: 21 });
    host.use = (g: number) => { host.sent.push(`use ${g.toString(16)}`); api.pushChat('The Chest is locked', 0x1a); return true; };
    const p = api.loot('Chest', null);
    run(api, host, 4000);
    const r = await p;
    expect(r).toEqual({ ok: false, message: 'Chest won\'t open: The Chest is locked' });
    expect(host.sent.filter((x) => x === 'use 80000910')).toHaveLength(1);
  });
});
