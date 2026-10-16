/**
 * BUG.link-dead-no-resume — the page's own 40 s link check (main.ts link
 * tick, endCause link_dead / client_suspended) found an in-world session dead
 * and went straight to retail's Disconnected screen, ending the resume that
 * the connection's own 'disconnected' event would have started (2026-10-16
 * production: a Snowreap world_left with link_dead, then 21 min on the
 * Disconnected screen). handleUnexpectedDrop now resumes first.
 *
 * Driven with the real SessionLifecycle and a scheduleResume built as
 * main.ts's is (nextResumeDelay → the connection's disconnect() → a timer);
 * the connection's deliberate close feeds back the way main.ts's
 * 'disconnected' handler treats it (noteDisconnected, nothing else).
 */
import { describe, it, expect } from 'vitest';
import { SessionLifecycle, RESUME_DELAYS_MS } from '@ac/renderer/session/SessionLifecycle.js';
import { handleUnexpectedDrop } from '../packages/renderer/src/session/UnexpectedDrop.js';

const GUID = 0x50000001;

function rig(opts: { inWorld?: boolean } = {}) {
  const lifecycle = new SessionLifecycle();
  if (opts.inWorld !== false) {
    lifecycle.noteEnterWorldRequested(GUID);
    lifecycle.noteWorldEntered();
  }
  const log: string[] = [];
  const delays: number[] = [];
  /** The dead connection: still open until we close it; its close is deliberate. */
  const conn = {
    open: true,
    disconnect(): void {
      log.push('disconnect');
      if (!this.open) return;
      this.open = false;
      // main.ts 'disconnected' with deliberate: true — bookkeeping only
      // (no report: WorldReporter.left is once per world; no resume, no screen).
      lifecycle.noteDisconnected();
    },
  };
  const scheduleResume = (): boolean => {
    const delay = lifecycle.nextResumeDelay();
    if (delay === null) return false;
    conn.disconnect();
    delays.push(delay);
    log.push('resume');
    return true;
  };
  const drop = () => handleUnexpectedDrop({
    lifecycle,
    reportLeft: () => log.push('world_left'),
    teardownWorld: () => log.push('teardown'),
    scheduleResume,
    raiseServerDied: () => { log.push('server_died'); conn.disconnect(); lifecycle.endResume(); },
  });
  return { lifecycle, log, delays, conn, drop };
}

describe('BUG.link-dead-no-resume — the page link check resumes an in-world drop', () => {
  it('in the world: one report, the world torn down, the dead socket closed, a resume scheduled; no Disconnected screen', () => {
    const r = rig();
    expect(r.drop()).toBe('resuming');
    expect(r.log).toEqual(['world_left', 'teardown', 'disconnect', 'resume']);
    expect(r.delays).toEqual([RESUME_DELAYS_MS[0]]);
    expect(r.conn.open).toBe(false);
    // The deliberate close did not cancel it: the next CharacterList re-enters the same character.
    expect(r.lifecycle.resumingAfterDrop).toBe(true);
    expect(r.lifecycle.pickAutoEnterSlot([{ id: '1' }, { id: String(GUID) }], false)?.id).toBe(String(GUID));
  });

  it('mid-resume (out of the world, attempts left): the next attempt, not the screen', () => {
    const r = rig();
    r.drop();
    r.conn.open = true; // the resume's new connection, found dead before the world
    expect(r.drop()).toBe('resuming');
    expect(r.delays).toEqual([RESUME_DELAYS_MS[0], RESUME_DELAYS_MS[1]]);
  });

  it('budget spent: the Disconnected screen, and the resume ends', () => {
    const r = rig();
    for (let i = 0; i < RESUME_DELAYS_MS.length; i++) { r.conn.open = true; expect(r.drop()).toBe('resuming'); }
    r.conn.open = true;
    expect(r.drop()).toBe('server_died');
    expect(r.log.filter(l => l === 'server_died')).toHaveLength(1);
    expect(r.lifecycle.resumingAfterDrop).toBe(false);
    expect(r.conn.open).toBe(false);
  });

  it('not in the world: straight to the Disconnected screen, nothing resumed or reported here', () => {
    const r = rig({ inWorld: false });
    expect(r.drop()).toBe('server_died');
    expect(r.log).toEqual(['server_died', 'disconnect']);
    expect(r.delays).toEqual([]);
  });

  it('after a deliberate logout: never resumes', () => {
    const r = rig();
    r.lifecycle.noteLoggedOut();
    expect(r.drop()).toBe('server_died');
    expect(r.delays).toEqual([]);
    expect(r.lifecycle.resumingAfterDrop).toBe(false);
  });

  it('a logout while a resume was pending: the screen, not another attempt', () => {
    const r = rig();
    r.drop();
    r.lifecycle.noteLoggedOut();
    r.conn.open = true;
    expect(r.drop()).toBe('server_died');
    expect(r.delays).toHaveLength(1);
  });
});
