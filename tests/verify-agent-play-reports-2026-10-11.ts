/**
 * AGENT.play-reports-2026-10-11 — what Claude Arcanist (a mage, end-of-retail local ACE) hit playing through the
 * agent tools, each driven through the real AgentApi on the fake host (tests/_harness/agentFake.ts) or the real
 * tool table: a types=chat,tell wait slept through fellowship lines; observe's radius and filter didn't reach the
 * remembered places (Holtburg's vendors listed 25 km away in Nanto); walk_to promised a relative offset it didn't
 * take; ac_use's walk ran on past the tool's timeout with a fellowship invite open. (Loot and the door timing are
 * in verify-agent-api.ts.)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, compassToYaw, parseOffset } from '../packages/renderer/src/agent/AgentApi.ts';
import { TOOLS, waitFilter } from '../tools/ac-agent/tools.ts';
import { FakeHost, HOLTBURG, run } from './_harness/agentFake.ts';

describe('agent play reports 2026-10-11', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
  });
  afterEach(() => { vi.useRealTimers(); });

  it('ac_wait types=chat,tell wakes on every chat line, a fellowship one included (types=tell alone still means tells)', async () => {
    expect(waitFilter({ types: 'chat,tell' })).toEqual({ types: ['chat'] });
    expect(waitFilter({ types: 'tell,chat,death' })).toEqual({ types: ['chat', 'death'] });
    expect(waitFilter({ types: 'tell' })).toEqual({ chatMatch: '^\\(tell\\) ' });
    api.observe();
    const w = api.wait(waitFilter({ types: 'chat,tell,task-done' }) as Parameters<AgentApi['wait']>[0], 45_000);
    await vi.advanceTimersByTimeAsync(5000);
    api.pushChat('[Fellowship] Claude Bulwark says, "On my way to Nanto"', 0x12);
    const evs = await w;
    expect(evs.map((e) => e.text)).toEqual(['(channel) [Fellowship] Claude Bulwark says, "On my way to Nanto"']);
  });

  it('observe applies its radius and filter to remembered places, and without a radius lists only this region\'s', () => {
    // Seen and gone: a vendor here, an NPC here, and Holtburg's vendor far away on the landscape (another landblock).
    host.add({ guid: 0x80000b01, name: 'Nanto Grocer', objectDescFlags: 0x200, itemType: 0x10, x: 80, y: 120 }); // 100 m off
    host.add({ guid: 0x80000b02, name: 'Town Crier', itemType: 0x10, x: 80, y: 40 }); // 20 m off
    host.add({ guid: 0x80000b03, name: 'Holtburg Grocer', objectDescFlags: 0x200, itemType: 0x10, cell: 0x10100019, x: 10, y: 10 }); // ~40 km off
    run(api, host, 200);
    for (const g of [0x80000b01, 0x80000b02, 0x80000b03]) host.objs.delete(g);
    run(api, host, 200);
    expect(api.observe().remembered.map((o) => o.name)).toEqual(['Town Crier', 'Nanto Grocer']);
    expect(api.observe({ radius: 60 }).remembered.map((o) => o.name)).toEqual(['Town Crier']);
    expect(api.observe({ filter: 'vendor', radius: 300 }).remembered.map((o) => o.name)).toEqual(['Nanto Grocer']);
    expect(api.observe({ filter: 'grocer', radius: 60_000 }).remembered.map((o) => o.name)).toEqual(['Nanto Grocer', 'Holtburg Grocer']);
    // walk_to still finds a far remembered place by name.
    expect(api.resolve('Holtburg Grocer', 'world')).toBe(0x80000b03);
  });

  it('walk_to takes a distance and direction as a player says it: compass, or from your facing', async () => {
    expect(parseOffset('10m north')).toEqual({ dist: 10, bearing: 0 });
    expect(parseOffset('25 m NE')).toEqual({ dist: 25, bearing: 45 });
    expect(parseOffset('5 metres south-west')).toEqual({ dist: 5, bearing: 225 });
    expect(parseOffset('5m ahead')).toEqual({ dist: 5, turn: 0 });
    expect(parseOffset('3 m to the left')).toEqual({ dist: 3, turn: -90 });
    expect(parseOffset('Drudge Skulker')).toBeNull();
    expect(parseOffset('42.1N, 33.6E')).toBeNull();
    const desc = TOOLS.find((t) => t.name === 'ac_walk_to')!.description;
    expect(desc).toMatch(/"10m north"/);
    expect(desc).not.toMatch(/relative offset/);

    // 12 m east from (80, 20).
    let p = api.walkTo('12m east', { within: 1 });
    run(api, host, 10_000);
    expect(await p).toMatchObject({ ok: true });
    expect(host.me.x).toBeGreaterThan(90.5);
    expect(Math.abs(host.me.y - 20)).toBeLessThan(1);
    // 8 m to your left while facing north is west.
    host.me.yaw = compassToYaw(0);
    const x0 = host.me.x;
    p = api.walkTo('8m left', { within: 1 });
    run(api, host, 10_000);
    expect(await p).toMatchObject({ ok: true });
    expect(host.me.x).toBeLessThan(x0 - 6.5);
  });

  it('a cast refused "Out of Range!" fails and says how far the spell reaches for you; ac_spells lists each range', async () => {
    host.spells = () => [{ id: 1427, name: 'Focus Other I', school: 'Creature Enchantment', level: 1, buff: true, range: 6 }];
    host.add({ guid: 0x80000b20, name: 'Claude Bulwark', objectDescFlags: 0x8, itemType: 0x10, x: 80, y: 31 });
    const cast = host.cast;
    host.cast = (id: number, t: number | null) => { setTimeout(() => api.pushChat('Out of Range!'), 300); return cast(id, t); };
    const p = api.cast('Focus Other I', 'Claude Bulwark');
    await vi.advanceTimersByTimeAsync(4000);
    const r = await p;
    expect(r.ok).toBe(false);
    expect(r.message).toBe('casting Focus Other I at Claude Bulwark #80000b20\n  Out of Range!\n  (Focus Other I reaches 6 m for you, longer as your Creature Enchantment ranks grow; Claude Bulwark is 11.0 m away)');
    const { formatSpells } = await import('../packages/renderer/src/agent/format.ts');
    expect(formatSpells(host.spells())).toBe('  1427  Focus Other I  [Creature Enchantment L1]  range 6 m');
  });

  it('ac_use gives up walking to its object inside the tool\'s time, stops the walk, and names an open dialog', async () => {
    // The scrivener is in a building (an interior cell), 250 m off across the landblock: a 60 s run.
    host.me.x = 5; host.me.y = 5;
    host.add({ guid: 0x80000b10, name: 'Journeyman Scrivener of Creature Magic', itemType: 0x10, cell: (HOLTBURG & 0xffff0000) | 0x0105, x: 185, y: 185 });
    host.routeTo = [{ x: 180, y: 180, z: 94 }];
    host.dialogList = [{ text: 'Claude Bulwark has invited you to join a fellowship. Do you accept?', buttons: ['Yes', 'No'] }];
    const p = api.use('Journeyman Scrivener of Creature Magic');
    let r: Awaited<typeof p> | undefined;
    void p.then((x) => { r = x; });
    for (let i = 0; i < 700 && !r; i++) {
      host.t += 100;
      host.physics(100);
      api.tick();
      await vi.advanceTimersByTimeAsync(100);
    }
    expect(r).toBeDefined();
    expect(host.t).toBeLessThan(AgentApi.USE_APPROACH_MS + 2000);
    expect(r!.ok).toBe(false);
    expect(r!.message).toMatch(/^couldn't reach Journeyman Scrivener of Creature Magic: walking to Journeyman Scrivener of Creature Magic took longer than 45 s and stopped [\d.]+ m away; ac_walk_to it first/);
    expect(r!.message).toMatch(/a dialog is open: "Claude Bulwark has invited you to join a fellowship\. Do you accept\?" \[Yes \/ No\] \(ac_dialog answers it\)/);
    // The walk stopped with the call: no task left running, no key held.
    expect(api.observe().me!.task).toBeNull();
    expect([...host.keys]).toEqual([]);
    expect(host.sent.filter((s) => s.startsWith('use'))).toEqual([]);
  });
});
