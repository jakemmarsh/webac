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

  it('one call at a time, in order; a call past its deadline stops movement and answers an error', async () => {
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
    await vi.advanceTimersByTimeAsync(2500);
    await a; await b;
    expect(sent.map((s) => [s.agentResult.id, s.agentResult.ok])).toEqual([[1, false], [2, true]]);
    expect(sent[0].agentResult.error).toMatch(/took longer than 2 s and was stopped/);
    expect(stopped).toBe(1);
    expect(order).toEqual(['walk start', 'observe']);
    vi.useRealTimers();
  });
});
