import { describe, expect, it } from 'vitest';
import { IDLE_LOGOUT_MIN, idleLogoutReason, parseArgs } from '../tools/ac-agent/daemon.ts';
import { AgentApi } from '../packages/renderer/src/agent/AgentApi.ts';
import { FakeHost } from './_harness/agentFake.ts';

// Jake (2026-10-12): "you should always log out if you stop controlling them otherwise they might die to stuff? unless
// ive taken over". The agent daemon logs an agent-started character out after IDLE_LOGOUT_MIN with no agent call,
// nothing Claude started still acting and no human input in its window; never a tab the human logged in (attach).
describe('agent daemon: logging out an idle character', () => {
  const min = 60_000;
  const base = { now: 100 * min, lastCallAt: 100 * min - 16 * min, lastInputAt: 0, acting: false, idleMs: 15 * min, attached: false };

  it('logs out after 15 idle minutes, and says why', () => {
    expect(IDLE_LOGOUT_MIN).toBe(15);
    expect(idleLogoutReason(base)).toMatch(/^idle 16 min .*logging out so the character isn't left standing in the world/);
  });
  it('an agent call, or a human\'s own input in the window, within the 15 minutes keeps it in', () => {
    expect(idleLogoutReason({ ...base, lastCallAt: base.now - 14 * min })).toBeNull();
    expect(idleLogoutReason({ ...base, lastInputAt: base.now - 2 * min })).toBeNull();
  });
  it('a walk, fight, repeat cast or routine Claude started that is still going keeps it in', () => {
    expect(idleLogoutReason({ ...base, acting: true })).toBeNull();
  });
  it('never for an attached tab (the human\'s own login), nor with the idle logout turned off', () => {
    expect(idleLogoutReason({ ...base, attached: true })).toBeNull();
    expect(idleLogoutReason({ ...base, idleMs: 0 })).toBeNull();
  });
  it('--idle-logout-min sets it (0 turns it off); the default is 15', () => {
    expect(parseArgs(['--profile', 'mage']).idleLogoutMs).toBe(15 * min);
    expect(parseArgs(['--profile', 'mage', '--idle-logout-min', '5']).idleLogoutMs).toBe(5 * min);
    expect(parseArgs(['--profile', 'mage', '--idle-logout-min', '0']).idleLogoutMs).toBe(0);
  });
  it('the page says whether a task Claude started is still going, without reading the chat', async () => {
    const host = new FakeHost();
    const api = new AgentApi(host);
    const surface = api.surface() as unknown as { acting: () => { task: string | null; routine: string | null } };
    expect(surface.acting()).toEqual({ task: null, routine: null });
    void api.walkTo('30m north');
    expect(surface.acting().task).toMatch(/^walking/);
    api.stopMoving();
    expect(surface.acting().task).toBeNull();
  });
});
