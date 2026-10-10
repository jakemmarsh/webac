/**
 * AGENT.hosted-mcp-connector — the tab's side of the relay
 * (agent/relayTab.ts) and the client's relay frame parser: calls run on the
 * agent API surface only while the tab has opted in, one at a time; a call
 * past its deadline stops movement and answers an error.
 */
import { describe, expect, it, vi } from 'vitest';
import { TabRelay } from '../packages/renderer/src/agent/relayTab.ts';
import { parseAgentCall } from '../packages/network/src/ClientConnection.ts';

describe('the tab relay', () => {
  it('parses the bridge\'s call frames; anything else is not one', () => {
    expect(parseAgentCall('{"agent":{"id":4,"method":"observe","args":[{"radius":30}],"deadlineMs":5000}}')).toEqual({ id: 4, method: 'observe', args: [{ radius: 30 }], deadlineMs: 5000 });
    expect(parseAgentCall('{"agent":{"method":"observe"}}')).toBeNull();
    expect(parseAgentCall('{"routines":null}')).toBeNull();
  });

  it('the relay state: on/off, the character and screen, and the last unpair (only when there was one)', () => {
    const sent: string[] = [];
    const r = new TabRelay((t) => sent.push(t), () => null);
    r.sendState('Jake', 'world');
    r.on = true;
    r.sendState('Jake', 'world', 1760000000000);
    expect(sent.map((t) => JSON.parse(t))).toEqual([
      { agentState: { relay: 'off', character: 'Jake', screen: 'world' } },
      { agentState: { relay: 'on', character: 'Jake', screen: 'world', revokedBefore: 1760000000000 } },
    ]);
  });

  it('off: refused; on: the surface method runs and its answer goes back; unknown methods are refused', async () => {
    const sent: unknown[] = [];
    const surface = { observe: (o: unknown) => ({ ok: o }), _secret: () => 1 };
    const r = new TabRelay((t) => sent.push(JSON.parse(t)), () => surface);
    await r.handle({ id: 1, method: 'observe', args: [], deadlineMs: 1000 });
    r.on = true;
    await r.handle({ id: 2, method: 'observe', args: [{ radius: 30 }], deadlineMs: 1000 });
    await r.handle({ id: 3, method: 'nosuch', args: [], deadlineMs: 1000 });
    await r.handle({ id: 4, method: '_secret', args: [], deadlineMs: 1000 });
    expect(sent).toEqual([
      { agentResult: { id: 1, ok: false, error: 'Claude is switched off in this tab' } },
      { agentResult: { id: 2, ok: true, result: { ok: { radius: 30 } } } },
      { agentResult: { id: 3, ok: false, error: 'unknown method nosuch' } },
      { agentResult: { id: 4, ok: false, error: 'unknown method _secret' } },
    ]);
    r.sendState('Claude', null);
    expect(sent.at(-1)).toEqual({ agentState: { relay: 'on', character: 'Claude', screen: null } });
  });

  it('acting calls one at a time; a read answers at once; an acting call past its deadline keeps going and answers "still in progress"', async () => {
    vi.useFakeTimers();
    const sent: Array<{ agentResult: { id: number; ok: boolean; error?: string } }> = [];
    let stopped = 0;
    const order: string[] = [];
    const surface = {
      walkTo: () => new Promise((ok) => { order.push('walk start'); setTimeout(() => { order.push('walk end'); ok({ ok: true }); }, 10_000); }),
      observe: () => { order.push('observe'); return {}; },
      stopMoving: () => { stopped++; return {}; },
    };
    const r = new TabRelay((t) => sent.push(JSON.parse(t)), () => surface);
    r.on = true;
    const a = r.handle({ id: 1, method: 'walkTo', args: [], deadlineMs: 2000 });
    const b = r.handle({ id: 2, method: 'observe', args: [], deadlineMs: 2000 });
    const c = r.handle({ id: 3, method: 'walkTo', args: [], deadlineMs: 20_000 });
    await vi.advanceTimersByTimeAsync(0);
    // The observe answered while the walk was still going (Claude's parallel calls no longer queue behind it).
    expect(sent.map((s) => s.agentResult.id)).toEqual([2]);
    await vi.advanceTimersByTimeAsync(2500);
    await a; await b;
    // The walk keeps going past its deadline: "still in progress", ok, nothing stopped.
    expect(sent.map((s) => [s.agentResult.id, s.agentResult.ok])).toEqual([[2, true], [1, true]]);
    expect((sent[1].agentResult as unknown as { result: { message: string } }).result.message).toMatch(/^walkTo is still in progress after 2 s and keeps going: ac_wait types=task-done/);
    expect(stopped).toBe(0);
    // The second acting call waits its turn behind the first (one at a time).
    expect(order).toEqual(['observe', 'walk start', 'walk start']);
    await vi.advanceTimersByTimeAsync(20_000);
    await c;
    expect(order).toEqual(['observe', 'walk start', 'walk start', 'walk end', 'walk end']);
    vi.useRealTimers();
  });
});
