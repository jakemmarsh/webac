/**
 * Stream movement reports, end of retail (local ACE), segment 10:00–11:01Z 2026-10-16, build 4ad7ef9b (Claude Arcanist /
 * Claude Bulwark; reports stream/reports/*2026-10-16T11-01*.md, page traces mage.log / soldier.log), on the fake host.
 * The real Holtburg scriveners' building is in verify-agent-scriveners-door.ts (DAT-gated).
 *
 * 1. Stuck in the Holtburg scriveners (0xA9B30102): the walk matched doors to doorways in 2D and Used the balcony door
 *    3 m overhead six times (each Use swings an ACE door the other way), called it "locked" after two silent Uses (ACE
 *    always says "The door is locked!"), and planned through the Scrivener of War Magic standing by the doorway (the
 *    probe leaves creatures out). Now: doors on another storey are not the doorway's, a silent door on ACE is not locked,
 *    and NPCs standing on your storey are kept clear of like walls.
 * 2. Bulwark (L33)'s follows stopped for L8 monsters on the way to town: a monster under half your level no longer stops
 *    a walk / follow (unless it hits you) or is kept clear of outdoors; a newcomer of unknown level is examined first.
 * 3. walk_to target=0xA9B20114 from the street said "no object in view": a cell id of any landblock is a target now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi, type AgentHostObject } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('stream movement reports, 2026-10-16 11:01Z (fake host)', () => {
  let host: FakeHost;
  let api: AgentApi;
  let traces: string[];
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    api = new AgentApi(host);
    traces = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { traces.push(a.join(' ')); });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  describe('1. doors and NPCs in a building', () => {
    /** A 7 m room round the goal with one open doorway in its west wall at (76.5, 40); the body starts outside it. */
    const room = (): void => {
      const band = (v: number, c: number, half: number) => Math.abs(v - c) < half;
      host.wall = (x, y) => {
        const onWall = (band(x, 76.5, 0.4) || band(x, 83.5, 0.4)) && y > 36.1 && y < 43.9 || (band(y, 36.5, 0.4) || band(y, 43.5, 0.4)) && x > 76.1 && x < 83.9;
        return onWall && !(band(x, 76.5, 0.5) && y > 39.4 && y < 40.6);
      };
      host.me.x = 70; host.me.y = 40;
      host.route = ((_fc: number, _f: unknown, _tc: number, to: { x: number; y: number; z: number }) => [{ x: 76.5, y: 40, z: 94 }, to]) as typeof host.route;
      host.add({ guid: 0x8000004f, name: 'Renald the Eldest', itemType: 0x10, cell: 0xa9b40105, x: 80, y: 40 });
    };

    it('never Uses a shut door a storey up from the doorway (the scriveners\' balcony door #7a9b3006, z 119 over 116)', async () => {
      room();
      // The balcony door, in the doorway's line but 3 m overhead: shut (not Ethereal).
      host.add({ guid: 0x7a9b3006, name: 'Door', objectDescFlags: 0x1000, physicsState: 0, x: 75.8, y: 40, z: 97 });
      const r = await settle(api, host, api.walkTo('Renald the Eldest', { within: 1.5 }), 60_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(host.sent.filter((s) => s.startsWith('use'))).toEqual([]);
      expect(traces.filter((l) => /closed door|Door #7a9b3006/.test(l))).toEqual([]);
    });

    it('the same door on your storey is still opened first, once', async () => {
      room();
      let open = false;
      const door = host.add({ guid: 0x7a9b3005, name: 'Door', objectDescFlags: 0x1000, physicsState: 0, x: 75.8, y: 40, z: 94 });
      const wall = host.wall!;
      host.wall = (x, y) => wall(x, y) || (!open && Math.abs(x - 76.5) < 0.5 && y > 39.4 && y < 40.6);
      const use = host.use;
      host.use = (g: number) => { if (g === door.guid) { open = !open; door.physicsState = open ? 0x4 : 0; } return use(g); };
      const r = await settle(api, host, api.walkTo('Renald the Eldest', { within: 1.5 }), 60_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(host.sent.filter((s) => s.startsWith('use'))).toEqual(['use 7a9b3005']);
    });

    it('on ACE a door that stays shut without "The door is locked!" is not called locked, and no key is tried on it', async () => {
      room();
      // A door that ignores every Use (busy, or not answering), with a key in the pack.
      host.add({ guid: 0x7a9b3005, name: 'Door', objectDescFlags: 0x1000, physicsState: 0, x: 75.8, y: 40, z: 94 });
      const wall = host.wall!;
      host.wall = (x, y) => wall(x, y) || (Math.abs(x - 76.5) < 0.5 && y > 39.4 && y < 40.6);
      host.inv.push({ guid: 0x80000050, name: 'Vault Key', where: 'pack' });
      host.fallFamily = 'ace';
      const r = await settle(api, host, api.walkTo('Renald the Eldest', { within: 1.5, timeoutMs: 60_000 }), 400_000);
      expect(r).toMatchObject({ ok: false });
      expect(host.sent.some((s) => s.startsWith('usewith'))).toBe(false);
      expect(traces.filter((l) => /is locked; using/.test(l))).toEqual([]);
    });

    it('walks round an NPC standing on the straight way instead of into it (the Scrivener of War Magic by the doorway)', async () => {
      host.wall = () => false; // open floor: the probe is the fake's, and it leaves creatures out as the live one does
      host.objectReach = (g) => (g === 0x7a9b3018 ? 0.48 : 0);
      host.add({ guid: 0x7a9b3018, name: 'Scrivener of War Magic', itemType: 0x10, objectDescFlags: 0x200, x: 80, y: 30 });
      host.add({ guid: 0x80000070, name: 'Post', x: 80, y: 40 });
      let closest = Infinity;
      const r = await settle(api, host, api.walkTo('Post', { within: 1 }), 30_000, () => { closest = Math.min(closest, Math.hypot(host.me.x - 80, host.me.y - 30)); });
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(closest).toBeGreaterThan(0.85);
    });

    it('an NPC a storey up is no obstacle, and the NPC walked to is not kept clear of', async () => {
      host.wall = () => false;
      host.objectReach = () => 0.48;
      host.add({ guid: 0x7a9b3017, name: 'Scrivener of Creature Magic', itemType: 0x10, objectDescFlags: 0x200, x: 80, y: 30, z: 97 });
      host.add({ guid: 0x80000070, name: 'Post', x: 80, y: 40 });
      let closest = Infinity;
      const r = await settle(api, host, api.walkTo('Post', { within: 1 }), 30_000, () => { closest = Math.min(closest, Math.hypot(host.me.x - 80, host.me.y - 30)); });
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(closest).toBeLessThan(0.5); // straight on under it
      host.me.x = 80; host.me.y = 20;
      host.add({ guid: 0x7a9b3018, name: 'Scrivener of War Magic', itemType: 0x10, objectDescFlags: 0x200, x: 80, y: 30 });
      const r2 = await settle(api, host, api.walkTo('Scrivener of War Magic', { within: 1 }), 30_000);
      expect(r2, traces.join('\n')).toMatchObject({ ok: true });
    });
  });

  describe('2. monsters under half your level don\'t stop a walk', () => {
    const monster = (guid: number, name: string, x: number, y: number, extra: Partial<AgentHostObject> = {}): AgentHostObject =>
      host.add({ guid, name, itemType: 0x10, objectDescFlags: 0x10, x, y, ...extra });
    beforeEach(() => { host.me.level = 33; });

    it('an L8 Banderling Scout coming at an L33 walks on; an L20 stops it', async () => {
      host.add({ guid: 0x80000070, name: 'Far Post', x: 80, y: 120 });
      const scout = monster(0x8000400a, 'Banderling Scout', 110, 60, { level: 8 });
      let n = 0;
      const r = await settle(api, host, api.walkTo('Far Post', { stopOnAggro: true }), 60_000, () => { if (++n === 10) scout.seeks = { guid: host.me.guid, kind: 'move' }; });
      expect(r, traces.join('\n')).toMatchObject({ ok: true });

      host.me.x = 80; host.me.y = 20;
      const captain = monster(0x80002d80, 'Skeleton Captain', 110, 60, { level: 20 });
      n = 0;
      const r2 = await settle(api, host, api.walkTo('Far Post', { stopOnAggro: true }), 60_000, () => { if (++n === 10) captain.seeks = { guid: host.me.guid, kind: 'move' }; });
      expect(r2).toMatchObject({ ok: false, aggro: true });
      expect(r2!.message).toMatch(/Skeleton Captain #80002d80 \(level 20\) is coming at you/);
    });

    it('a newcomer of unknown level is examined first: its level (L8) answers, and the follow goes on', async () => {
      const v = { cur: 85, max: 85 };
      const ARC = 0x50000002;
      host.fellows = () => [{ guid: ARC, name: 'Claude Arcanist', health: v, stamina: v, mana: v }];
      const arc = host.add({ guid: ARC, name: 'Claude Arcanist', itemType: 0x10, objectDescFlags: 0x8, x: 80, y: 60 });
      const monouga = monster(0x80004100, 'Monouga', 50, 40);
      let n = 0;
      const r = await settle(api, host, api.follow(ARC, { durationMs: 20_000, stopOnAggro: true }), 25_000, () => {
        arc.y += 0.3;
        if (++n === 20) monouga.seeks = { guid: host.me.guid, kind: 'move' };
        // The examine's answer (ACE IdentifyObjectResponse carries Level) a few ticks after it was asked.
        if (host.appraised.includes(monouga.guid) && n > 24) monouga.level = 8;
      });
      expect(host.appraised).toContain(monouga.guid);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(r!.message).toMatch(/^followed Claude Arcanist/);
    });

    it('one of unknown level that never answers stops it after the wait; one of a kind seen at L8 does not', async () => {
      host.add({ guid: 0x80000070, name: 'Far Post', x: 80, y: 120 });
      const unknown = monster(0x80004101, 'Shadow', 110, 60);
      let n = 0;
      const r = await settle(api, host, api.walkTo('Far Post', { stopOnAggro: true }), 60_000, () => { if (++n === 10) unknown.seeks = { guid: host.me.guid, kind: 'move' }; });
      expect(r).toMatchObject({ ok: false, aggro: true });
      expect(r!.message).toMatch(/Shadow #80004101 \(level not known yet\) is coming at you/);

      // A Monouga seen at L8 before (another of the name, examined): the next one coming is known to be trash.
      host.objs.delete(unknown.guid);
      host.me.x = 80; host.me.y = 20;
      monster(0x80004102, 'Monouga', 140, 20, { level: 8 });
      api.observe();
      const next = monster(0x80004103, 'Monouga', 110, 60);
      n = 0;
      const r2 = await settle(api, host, api.walkTo('Far Post', { stopOnAggro: true }), 60_000, () => { if (++n === 10) next.seeks = { guid: host.me.guid, kind: 'move' }; });
      expect(r2, traces.join('\n')).toMatchObject({ ok: true });
    });

    it('an L8 hitting you still stops it (the hit is the stop)', async () => {
      host.add({ guid: 0x80000070, name: 'Far Post', x: 80, y: 120 });
      monster(0x8000400a, 'Banderling Scout', 81, 25, { level: 8, seeks: { guid: 0x50000001, kind: 'stick' } });
      let n = 0;
      const r = await settle(api, host, api.walkTo('Far Post', { stopOnAggro: true }), 30_000, () => { if (++n === 5) api.pushChat('Banderling Scout hits your upper leg for 3 points of bludgeoning damage!', 0x15); });
      expect(r).toMatchObject({ ok: false, attacked: true });
    });

    it('outdoors the walk does not go round an L8 (keep-clear is for real threats)', async () => {
      host.wall = () => false;
      host.add({ guid: 0x80000070, name: 'Far Post', x: 80, y: 70 });
      monster(0x8000400a, 'Banderling Scout', 80, 45, { level: 8 });
      let closest = Infinity;
      const r = await settle(api, host, api.walkTo('Far Post', { avoidMonsters: true }), 60_000, () => { closest = Math.min(closest, Math.hypot(host.me.x - 80, host.me.y - 45)); });
      expect(r).toMatchObject({ ok: true });
      expect(closest).toBeLessThan(2);
      expect(r!.message).not.toMatch(/went round/);
      expect(traces.filter((l) => /keeping clear of/.test(l))).toEqual([]);
    });
  });

  describe('3. a cell id of another landblock', () => {
    // The fake player stands outdoors in Holtburg 0xA9B40019 at (80, 20); 0xA9B30105 is the scriveners' front hall,
    // one landblock south: (180.2, 78.6, z 116) in 0xA9B3's frame = 192 m further south.
    const HALL = 0xa9b30105;
    it('walks from the street to a room of the next landblock (it said "no object in view")', async () => {
      host.wall = () => false;
      host.me.x = 170; host.me.y = 10;
      host.cellPoint = (c) => (c === HALL ? { x: 180.2, y: 178.6, z: 94 } : null);
      const r = await settle(api, host, api.walkTo('0xA9B30105', { within: 1 }), 120_000);
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(host.me.y).toBeLessThan(0); // into 0xA9B3 (its frame starts 192 m south)
    });

    it('a landblock not loaded yet: walks toward its middle, and on to the cell once it loads', async () => {
      host.wall = () => false;
      host.me.x = 96; host.me.y = 10;
      let loaded = false;
      host.cellPoint = (c) => (loaded && c === HALL ? { x: 100, y: 150, z: 94 } : null);
      const p = api.walkTo(HALL, { within: 1 });
      const r = await settle(api, host, p, 120_000, () => { if (host.me.y < -10) loaded = true; });
      expect(r, traces.join('\n')).toMatchObject({ ok: true });
      expect(traces.some((l) => /not loaded yet; walking to its middle/.test(l))).toBe(true);
      expect(Math.hypot(host.me.x - 100, host.me.y - (150 - 192))).toBeLessThan(1.5);
    });

    it('one that never loads ends at its landblock with the honest reason', async () => {
      host.wall = () => false;
      host.me.x = 96; host.me.y = 10;
      host.cellPoint = () => null;
      const r = await settle(api, host, api.walkTo(HALL, { within: 1 }), 120_000);
      expect(r).toMatchObject({ ok: false });
      expect(r!.message).toMatch(/^walking to cell 0xA9B30105: walked to its landblock \(0xA9B3, here\), but the client hasn't loaded that cell/);
    });

    it('a dungeon\'s cell names the portal that took you there before', async () => {
      host.cellPoint = (c) => ((c >>> 16) === 0x0185 ? { x: 50, y: 50, z: 0 } : null);
      host.cellSealed = (c) => (c >>> 16) === 0x0185 && (c & 0xffff) >= 0x100;
      const portal = host.add({ guid: 0x7a9b4060, name: 'Portal to Mu-miyah Tomb', itemType: 0x10000, objectDescFlags: 0x40000, x: 81, y: 21 });
      // Unknown first: none you took went there.
      expect(await api.walkTo(0x01850148)).toMatchObject({ ok: false, message: expect.stringMatching(/inside a dungeon \(go in by its portal first; which portal leads there is not known/) });
      // Step into the portal: portal space, then arrival in 0x0185.
      run(api, host, 200, { physics: false });
      host.screenName = 'portal-space';
      run(api, host, 200, { physics: false });
      host.me.cell = 0x01850100; host.me.x = 10; host.me.y = 10; host.me.z = 0;
      host.screenName = 'world';
      run(api, host, 200, { physics: false });
      // Back out on the street (a recall), the dungeon's cell is walked to through that portal.
      host.me.cell = 0xa9b40019; host.me.x = 70; host.me.y = 20; host.me.z = 94;
      run(api, host, 200, { physics: false });
      const r = await api.walkTo(0x01850148);
      expect(r).toMatchObject({ ok: false, message: expect.stringMatching(new RegExp(`inside a dungeon \\(go in by its portal first: Portal to Mu-miyah Tomb #${portal.guid.toString(16)} \\(11 m E of you\\) took you there before: ac_use it\\)`)) });
    });
  });
});

