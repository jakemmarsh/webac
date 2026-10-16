/**
 * Mountain Keep (0x01D2) and Holtburg, 2026-10-16 20:52–21:53Z, end-of-retail local ACE, build 9b0c6bb6. Stream players
 * Claude Bulwark (soldier) and Claude Arcanist (mage) reported (stream/reports/{soldier-2026-10-16T21-53-39-242Z,
 * mage-2026-10-16T21-53-17-544Z}-seg1.md; transcripts stream/sessions/{soldier,mage}-2026-10-16-seg1.jsonl; page logs
 * soldier.log / mage.log). The portal, fellows-line, appraise and page-memory fixes have their tests beside the code
 * they touch (verify-agent-portal-avoid, verify-agent-aggro-avoid, verify-bug-examine-pack-item-suppressed /
 * verify-core10f-…-vendor-seed, verify-agent-page-storage); here:
 *   5. walk_to a monster the client has let go: "out of sight: your client let it go … Go back there and look again"
 *      (Arcanist 21:28:37Z #8000d0ef, Bulwark 21:44:54Z #8000d13d), with the Dread a moment ago 20 m off.
 *   6. walk_to … within=4 "arrived (5.0 m away)" with a wall still between the caster and the Dread: line=true.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost, run } from './_harness/agentFake.ts';

const DREAD = 0x8000d13d;

async function settle<T>(api: AgentApi, host: FakeHost, p: Promise<T>, ms: number, each?: () => void): Promise<T | null> {
  let out: T | null = null;
  let done = false;
  void p.then((x) => { out = x; done = true; });
  for (let t = 0; t < ms && !done; t += 100) { each?.(); run(api, host, 100); await Promise.resolve(); await Promise.resolve(); }
  return out;
}

describe('stream reports 2026-10-16 21:53Z', () => {
  let host: FakeHost;
  let api: AgentApi;
  beforeEach(() => {
    vi.useFakeTimers();
    host = new FakeHost();
    host.me.level = 37;
    api = new AgentApi(host);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  describe('5. walk_to a monster the client let go: to where it was last seen', () => {
    const dreadSeenThenLost = (): void => {
      host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40, level: 60 });
      run(api, host, 600, { physics: false }); // in sight: sampled
      const o = host.object(DREAD)!;
      o.lost = true; // out of the rooms in sight of yours
    };

    it('walks to its last spot, saying so, and says it is in sight again when it is', async () => {
      dreadSeenThenLost();
      const p = api.walkTo(DREAD, { within: 3 });
      const r = await settle(api, host, p, 20_000, () => {
        // Back in sight once you are near where it stood.
        if (Math.hypot(host.me.x - 80, host.me.y - 40) < 6) host.object(DREAD)!.lost = false;
      });
      expect(r?.message).toMatch(/^Dread Mu-miyah #8000d13d is out of sight \(your client let it go\); going to where it was last seen: 20 m N of you, \d+ s ago\narrived/);
      expect(r?.message).toMatch(/Dread Mu-miyah #8000d13d is in sight now: \d+ m N/);
    });

    it('by name too, when none of that name is in sight', async () => {
      dreadSeenThenLost();
      const r = await settle(api, host, api.walkTo('Dread Mu-miyah', { within: 3 }), 20_000);
      expect(r?.message).toMatch(/^Dread Mu-miyah #8000d13d is out of sight .*going to where it was last seen[\s\S]*isn't in sight from here: it moved on \(or died\)$/);
    });

    it('not one seen over a minute ago: no walk to a stale spot', async () => {
      dreadSeenThenLost();
      run(api, host, 61_000, { physics: false });
      const r = await api.walkTo(DREAD);
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(/out of sight: your client let it go/);
      expect(r.message).not.toMatch(/going to where it was last seen/);
    });
  });

  describe('6. walk_to line=true: arrived only with an open line of fire', () => {
    const dread = (): void => { host.add({ guid: DREAD, name: 'Dread Mu-miyah', itemType: 0x10, objectDescFlags: 0x10, x: 80, y: 40, level: 60 }); run(api, host, 300, { physics: false }); };
    /** A wall across the line until the body is within `open` m of the Dread. */
    const wallUntil = (open: number): void => {
      host.lineOfFire = () => {
        const d = Math.hypot(host.me.x - 80, host.me.y - 40);
        return { dist: d, blockedAt: d > open ? 1.2 : null, ...(d > open ? { blocker: 'a wall' } : {}) };
      };
    };

    it('within it but walled off: closes in until the line opens, and says so', async () => {
      dread(); wallUntil(3);
      const r = await settle(api, host, api.walkTo(DREAD, { within: 4, line: true, stopOnAggro: false, avoidMonsters: false }), 20_000);
      expect(r?.ok).toBe(true);
      expect(r?.message).toMatch(/^arrived \(\d\.\d m away\); the line of fire to it is open \(closed in 1 time round the wall for it\)/);
      expect(Math.hypot(host.me.x - 80, host.me.y - 40)).toBeLessThanOrEqual(3);
    });

    it('a line that never opens: stops beside it, saying the line is still shut', async () => {
      dread(); wallUntil(0);
      const r = await settle(api, host, api.walkTo(DREAD, { within: 4, line: true, stopOnAggro: false, avoidMonsters: false }), 20_000);
      expect(r?.message).toMatch(/no open line to it from here \(a wall 1\.2 m along the line.*closed in \d times looking for an open line; beside it now\)/);
      expect(Math.hypot(host.me.x - 80, host.me.y - 40)).toBeLessThan(2);
    });

    it('without line=true: the arrival by a monster says the line is shut, and how to ask for one (the 21:53Z case)', async () => {
      dread(); wallUntil(3);
      const r = await settle(api, host, api.walkTo(DREAD, { within: 4, stopOnAggro: false, avoidMonsters: false }), 20_000);
      expect(r?.message).toMatch(/^arrived \(4\.\d m away\); no open line to it from here .*\(walk_to … line=true keeps going until the line is open\)/);
    });

    it('the tool takes line=true through to the walk', async () => {
      const { TOOL_BY_NAME } = await import('../tools/ac-agent/tools.ts');
      const tool = TOOL_BY_NAME.get('ac_walk_to')!;
      expect(Object.keys(tool.props)).toContain('line');
    });
  });
});
