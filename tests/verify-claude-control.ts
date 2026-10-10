/**
 * AGENT.hosted-mcp-connector step 4 — the player always wins
 * (agent/claudeControl.ts, docs/hosted-agent-connector.md §5): acting while
 * Claude plays takes over; Claude's acting calls are refused until the player
 * has been idle 60 s or resumes; pause refuses all but status; the history.
 * Through the real TabRelay, as the bridge's calls arrive.
 */
import { describe, expect, it } from 'vitest';
import { CLAUDE_ACTIVE_MS, ClaudeControl, PLAYER_IDLE_RESUME_MS } from '../packages/renderer/src/agent/claudeControl';
import { TabRelay } from '../packages/renderer/src/agent/relayTab';
import { parsePairingCommand } from '../packages/renderer/src/agent/claudePairing';
import { formatStatus } from '../tools/ac-agent/tools';

function setup() {
  let t = 1_000_000;
  const said: string[] = [];
  const did: string[] = [];
  const control = new ClaudeControl({ stopMoving: () => did.push('stop'), pauseRoutine: () => did.push('pause-routine'), say: (s) => said.push(s) }, () => t);
  const sent: Array<{ id: number; ok: boolean; result?: unknown; error?: string }> = [];
  const surface = { observe: () => 'seen', walkTo: () => 'walking', routineStart: () => 'started', routineStop: () => 'stopped', status: () => ({ control: 'x' }) };
  const relay = new TabRelay((text) => sent.push(JSON.parse(text).agentResult), () => surface, control, () => t);
  relay.on = true;
  let id = 0;
  const call = async (method: string) => { await relay.handle({ id: ++id, method, args: [], deadlineMs: 5000 }); return sent[sent.length - 1]; };
  return { control, said, did, call, advance: (ms: number) => { t += ms; } };
}

describe('the player and Claude', () => {
  it('Claude acts; the player acts too: Claude stops, its routine pauses, acting is refused, reading still answers', async () => {
    const { control, said, did, call, advance } = setup();
    expect(await call('routineStart')).toMatchObject({ ok: true, result: 'started' });
    expect(said).toEqual(['Claude is playing this character. Act yourself to take over; /automation pause stops it.']);
    expect(await call('walkTo')).toMatchObject({ ok: true });
    advance(2000);
    control.playerInput();
    expect(control.control).toBe('player');
    expect(did).toEqual(['stop', 'pause-routine']);
    expect(said[1]).toMatch(/^You took control; Claude stopped\. It carries on after you've been idle 60 s, or type \/automation resume\.$/);
    advance(10_000);
    expect(await call('walkTo')).toMatchObject({ ok: false, error: /the player has taken control \(10 s ago\); wait until they have been idle 60 s/ });
    expect(await call('observe')).toMatchObject({ ok: true, result: 'seen' });
    // The player keeps acting: the clock restarts; then idle for 60 s and Claude may act again.
    control.playerInput();
    advance(PLAYER_IDLE_RESUME_MS - 1);
    expect((await call('walkTo')).ok).toBe(false);
    advance(1);
    expect((await call('walkTo')).ok).toBe(true);
    expect(control.control).toBe('claude');
    expect(said).toHaveLength(2); // one announcement, one take-over line
  });

  it('player input while Claude is idle (or never acted) changes nothing; a routine the player started is never paused', async () => {
    const { control, did, call, advance } = setup();
    control.playerInput();
    expect(control.control).toBe('claude');
    await call('walkTo');
    advance(CLAUDE_ACTIVE_MS + 1);
    control.playerInput();
    expect(control.control).toBe('claude');
    advance(1000);
    await call('walkTo');
    control.playerInput();
    expect(control.control).toBe('player');
    expect(did).toEqual(['stop']);
  });

  it('pause refuses everything but status until resume; resume hands back from either state', async () => {
    const { control, call } = setup();
    expect(control.pause()).toBe('Claude is paused: its calls are refused. /automation resume hands back.');
    expect(control.pause()).toMatch(/already paused/);
    expect(await call('observe')).toMatchObject({ ok: false, error: /paused by the player/ });
    expect(await call('status')).toMatchObject({ ok: true });
    expect(control.resume()).toBe('Claude can play again.');
    expect(control.resume()).toBe('Claude already has control.');
    expect((await call('walkTo')).ok).toBe(true);
    control.playerInput();
    expect(control.resume()).toBe('Claude can play again.');
    expect((await call('walkTo')).ok).toBe(true);
  });

  it('history keeps the last 100 calls (no arguments) and the summary says who has control', async () => {
    const { control, call, advance } = setup();
    for (let i = 0; i < 105; i++) await call('observe');
    expect(control.history).toHaveLength(100);
    expect(control.history[99]).toMatchObject({ method: 'observe', ok: true });
    advance(12_000);
    expect(control.summary('farm drudges')).toBe('Claude has control · last call observe 12 s ago · goal: farm drudges');
    expect(control.recent(2)).toHaveLength(2);
    expect(control.recent(1)[0]).toMatch(/^\d\d:\d\d:\d\d observe ok \d+ ms$/);
    control.pause();
    expect(control.summary(null)).toMatch(/^paused · last call/);
  });

  it('the commands and ac_status\'s control lines', () => {
    expect(parsePairingCommand('/automation pause')).toEqual({ kind: 'pause' });
    expect(parsePairingCommand('/Automation RESUME')).toEqual({ kind: 'resume' });
    expect(parsePairingCommand('/automation pause now')).toBeNull();
    expect(formatStatus(null, { screen: 'world', character: 'Jake', characters: [], goal: null, control: 'player' }, null)).toMatch(/control: the player took over/);
    expect(formatStatus(null, { screen: 'world', character: 'Jake', characters: [], goal: null, control: 'paused' }, null)).toMatch(/control: paused by the player/);
    expect(formatStatus(null, { screen: 'world', character: 'Jake', characters: [], goal: null, control: 'claude' }, null)).toBe('screen: world; in the world: Jake');
  });
});
