/**
 * BUG.preworld-link-dead-finish — the page's link check (CPlayerSystem::UseTime
 * @ 00563110, DISCONNECT_TIME 40 s) ran only from entering the world, so a
 * chargen session whose server went silent (2026-11-24, The Tower: a hidden
 * tab's net tick stopped 163 s, ACE dropped the session, the socket stayed
 * open) was never noticed, and FINISH, guarded only by the socket, waited out
 * its 20 s into a refusal instead of the chargen resume.
 *
 * These drive the real modules: LinkCheck (one check, started per live
 * session, idempotent, one verdict), deadSessionCause / sessionLiveForSend
 * (a silent open socket is dead for a send), and the drop handling a pre-world
 * verdict goes through (handleUnexpectedDrop + armDropResume: chargen keeps
 * the draft, character select keeps the list). The same check over each
 * era's real connection is pinned in verify-hidden-tab-session-drop.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { LinkSample } from '@ac/network';
import { LinkCheck, LINK_CHECK_TICK_MS, deadSessionCause, type LinkDeadCause } from '../packages/renderer/src/session/LinkCheck.js';
import { armDropResume, handleUnexpectedDrop, sessionLiveForSend } from '../packages/renderer/src/session/UnexpectedDrop.js';
import { SessionLifecycle } from '../packages/renderer/src/session/SessionLifecycle.js';

const live = (secs: number): LinkSample => ({ connected: true, secondsSinceLastPacket: secs, stall: null });

function check(samples: () => LinkSample) {
  const shown: LinkSample[] = [];
  const dead: LinkDeadCause[] = [];
  const lc = new LinkCheck({ sample: samples, show: (s) => shown.push(s), dead: (c) => dead.push(c) });
  return { lc, shown, dead };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('LinkCheck: one check per live session', () => {
  it('start() twice (character list, then entering the world) runs one interval', () => {
    let n = 0;
    const { lc, shown } = check(() => { n++; return live(1); });
    lc.start();
    lc.start();
    expect(lc.running).toBe(true);
    vi.advanceTimersByTime(LINK_CHECK_TICK_MS * 4);
    expect(n).toBe(4);
    expect(shown).toHaveLength(4);
    lc.stop();
    expect(lc.running).toBe(false);
    vi.advanceTimersByTime(LINK_CHECK_TICK_MS * 4);
    expect(n).toBe(4);
    lc.stop(); // idempotent
  });

  it('a session that keeps talking (ACE TimeSync / echo replies, the 1999 keepalive) is never ended', () => {
    let quiet = 0;
    const { lc, dead } = check(() => live(quiet));
    lc.start();
    for (let i = 0; i < 600; i++) { quiet = (i % 20) * 0.25; vi.advanceTimersByTime(LINK_CHECK_TICK_MS); }
    expect(dead).toEqual([]);
    expect(lc.running).toBe(true);
  });

  it('40 s exactly is alive; past it the session is dead once (link_dead), and the check stops', () => {
    let quiet = 40;
    const { lc, dead } = check(() => live(quiet));
    lc.start();
    vi.advanceTimersByTime(LINK_CHECK_TICK_MS);
    expect(dead).toEqual([]);
    quiet = 40.25;
    vi.advanceTimersByTime(LINK_CHECK_TICK_MS * 10);
    expect(dead).toEqual(['link_dead']);
    expect(lc.running).toBe(false);
    // The next session's character list starts it again.
    quiet = 1;
    lc.start();
    vi.advanceTimersByTime(LINK_CHECK_TICK_MS * 4);
    expect(dead).toEqual(['link_dead']);
  });

  it('our own thread stopped across the silence: client_suspended (the resume waits for a visible tab)', () => {
    const { lc, dead } = check(() => ({ connected: true, secondsSinceLastPacket: 105, stall: { agoMs: 2000, lengthMs: 162_959, answered: false } }));
    lc.start();
    vi.advanceTimersByTime(LINK_CHECK_TICK_MS);
    expect(dead).toEqual(['client_suspended']);
  });

  it('a sample that is not connected (closed socket, handshake) is never this check\'s verdict', () => {
    const { lc, dead } = check(() => ({ connected: false, secondsSinceLastPacket: 0 }));
    lc.start();
    vi.advanceTimersByTime(LINK_CHECK_TICK_MS * 400);
    expect(dead).toEqual([]);
  });
});

describe('deadSessionCause / sessionLiveForSend: a silent open socket is dead for a send', () => {
  const conn = (isConnected: boolean, sample: LinkSample) => ({ isConnected, getLinkStatus: () => sample });

  it('live, closed, silent, suspended, handshake', () => {
    expect(deadSessionCause(conn(true, live(3)))).toBeNull();
    expect(deadSessionCause(conn(false, { connected: false, secondsSinceLastPacket: 0 }))).toBe('link_dead');
    // The production FINISH: the socket open, rxAgo ≈ 105 s.
    expect(deadSessionCause(conn(true, live(105)))).toBe('link_dead');
    expect(deadSessionCause(conn(true, { connected: true, secondsSinceLastPacket: 105, stall: { agoMs: 3000, lengthMs: 162_959, answered: false } }))).toBe('client_suspended');
    // An open socket still in its handshake has no link to judge (the connection's own limits apply).
    expect(deadSessionCause(conn(true, { connected: false, secondsSinceLastPacket: 0 }))).toBeNull();
  });

  it('FINISH into a silent chargen session: the chargen resume keeps the draft, no 20 s wait', () => {
    const lc = new SessionLifecycle();
    const calls: string[] = [];
    const ok = sessionLiveForSend(conn(true, live(105)), (cause) => {
      calls.push(cause);
      calls.push(handleUnexpectedDrop({
        lifecycle: lc,
        reportLeft: () => calls.push('left'),
        teardownWorld: () => calls.push('teardown'),
        scheduleResume: () => { calls.push(`resume:${lc.nextResumeDelay()}`); return true; },
        raiseServerDied: () => calls.push('server_died'),
        armPreworldResume: () => armDropResume(lc, {
          unexpected: true, wasInWorld: false, enterPending: false, screen: 'chargen',
          keepChargenDraft: () => { lc.beginChargenResume(); return true; },
        }) !== null,
      }));
    });
    expect(ok).toBe(false);
    expect(calls).toEqual(['link_dead', 'left', 'teardown', 'resume:2000', 'resuming']);
    expect(lc.resumingChargen).toBe(true);
  });

  it('the link check at character select: the character-select resume (list and selection kept)', () => {
    const lc = new SessionLifecycle();
    const verdicts: string[] = [];
    const linkCheck = new LinkCheck({
      sample: () => live(41),
      show: () => {},
      dead: () => {
        verdicts.push(handleUnexpectedDrop({
          lifecycle: lc, reportLeft: () => {}, teardownWorld: () => {},
          scheduleResume: () => lc.nextResumeDelay() !== null, raiseServerDied: () => verdicts.push('server_died'),
          armPreworldResume: () => armDropResume(lc, {
            unexpected: true, wasInWorld: false, enterPending: false, screen: 'char-select',
            keepChargenDraft: () => false, selection: () => '1342177287',
          }) !== null,
        }));
      },
    });
    linkCheck.start();
    vi.advanceTimersByTime(LINK_CHECK_TICK_MS * 8);
    expect(verdicts).toEqual(['resuming']);
    expect(lc.resumingCharSelect).toBe(true);
    expect(lc.charSelectResumeSelection).toBe('1342177287');
    expect(linkCheck.running).toBe(false);
  });

  it('a live session sends: nothing ends', () => {
    const end = vi.fn();
    expect(sessionLiveForSend(conn(true, live(2)), end)).toBe(true);
    expect(end).not.toHaveBeenCalled();
  });
});
