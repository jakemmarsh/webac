/**
 * BUG.beforeunload-silent-disconnect — production telemetry 2026-11-12 22:05Z
 * (AC1999, build 4f0495fd6): `beforeunload` fired on a page that then stayed.
 * The handler closed the session as our own (deliberate) close, so nothing
 * resumed: the player sat in chargen on a dead socket, FINISH went out into
 * nothing and timed out 20 s later, and the frozen screen sample said
 * chargen/skills for every later event of the page.
 *
 * The page now closes its session on `pagehide` (verify-preworld-outcomes.ts
 * drives that through the real connections and the real reporter), and:
 *  - PageHideClose: a close made on pagehide is held while the page may be
 *    gone for good, and becomes a drop (path 1 of docs/reconnect.md) when the
 *    page comes back from the back/forward cache;
 *  - a send that needs the session finds it dead first (sessionLiveForSend);
 *  - a draft capture that throws no longer swallows the drop (armDropResume);
 *  - the UtilityBelt net says hello again after a bfcache restore.
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionLifecycle } from '../packages/renderer/src/session/SessionLifecycle.js';
import { PageHideClose, armDropResume, handleUnexpectedDrop, sessionLiveForSend } from '../packages/renderer/src/session/UnexpectedDrop.js';
import { installUnloadSessionClose } from '../packages/renderer/src/session/PlayerModuleSave.js';
import { UbNet, bindUbNetToPage, type NetChannel, type NetMessage } from '../packages/renderer/src/agent/ubNet.js';

/** A window stand-in that keeps listeners per type, with removal. */
class FakeWindow {
  private readonly l = new Map<string, Set<(ev: { persisted?: boolean }) => void>>();
  addEventListener(t: string, f: (ev: { persisted?: boolean }) => void): void {
    if (!this.l.has(t)) this.l.set(t, new Set());
    this.l.get(t)!.add(f);
  }
  removeEventListener(t: string, f: (ev: { persisted?: boolean }) => void): void { this.l.get(t)?.delete(f); }
  fire(t: string, ev: { persisted?: boolean } = {}): void { for (const f of [...(this.l.get(t) ?? [])]) f(ev); }
  count(t: string): number { return this.l.get(t)?.size ?? 0; }
}

describe('PageHideClose — a pagehide close is a drop only if the page comes back', () => {
  it('a close that reports at once (AC1999 ends in disconnect()) is held; a page that never comes back runs nothing', () => {
    const p = new PageHideClose();
    const handled: boolean[] = [];
    p.closing();
    p.ended((d) => handled.push(d));
    expect(handled).toEqual([]);
  });

  it('pageshow (persisted) runs the held end as a drop, once', () => {
    const p = new PageHideClose();
    const handled: boolean[] = [];
    p.closing();
    p.ended((d) => handled.push(d));
    p.shown(true);
    expect(handled).toEqual([true]);
    p.shown(true);
    expect(handled).toEqual([true]);
    // The next end is an ordinary one.
    p.ended((d) => handled.push(d));
    expect(handled).toEqual([true, false]);
  });

  it('an end that arrives after pageshow (the network worker replies once the page thaws) is a drop', () => {
    const p = new PageHideClose();
    const handled: boolean[] = [];
    p.closing();
    p.shown(true);
    expect(handled).toEqual([]);
    p.ended((d) => handled.push(d));
    expect(handled).toEqual([true]);
  });

  it('pageshow without persisted (a fresh load) and ends with no pagehide close are ordinary', () => {
    const p = new PageHideClose();
    const handled: boolean[] = [];
    p.shown(false);
    p.ended((d) => handled.push(d));
    p.closing();
    p.shown(false);
    p.ended((d) => handled.push(d));
    expect(handled).toEqual([false]);
  });

  it("the page's next connect forgets a close nothing came of", () => {
    const p = new PageHideClose();
    const handled: boolean[] = [];
    p.closing();
    p.shown(true);
    p.connectAttempt();
    p.ended((d) => handled.push(d));
    expect(handled).toEqual([false]);
  });

  it('installUnloadSessionClose: beforeunload alone does nothing; pagehide marks the close BEFORE disconnecting; pageshow restores the reporter', () => {
    const win = new FakeWindow();
    const order: string[] = [];
    let connected = true;
    installUnloadSessionClose(win, {
      module: { flushChatOptionsSave: () => order.push('flush') },
      connection: { get isConnected() { return connected; }, disconnect: () => { order.push('disconnect'); connected = false; } },
      reporter: { pageUnloading: () => order.push('sample'), pageRestored: () => order.push('restored') },
      after: () => order.push('after'),
      closing: () => order.push('closing'),
      restored: (persisted) => order.push(`shown:${persisted}`),
    });
    win.fire('beforeunload');
    expect(order).toEqual([]);
    win.fire('pagehide', { persisted: true });
    expect(order).toEqual(['sample', 'closing', 'flush', 'disconnect', 'after']);
    order.length = 0;
    win.fire('pageshow', { persisted: true });
    expect(order).toEqual(['restored', 'shown:true']);
    order.length = 0;
    // No live session: the save and close still run, but nothing is marked as ours to resume.
    win.fire('pagehide', { persisted: false });
    expect(order).toEqual(['sample', 'flush', 'disconnect', 'after']);
  });
});

describe('the drop path cannot be swallowed', () => {
  it('a chargen draft capture that throws: no throw out of armDropResume; the drop goes on (char-select resume here)', () => {
    const lc = new SessionLifecycle();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const kind = armDropResume(lc, {
      unexpected: true, wasInWorld: false, enterPending: false, screen: 'char-select',
      keepChargenDraft: () => { throw new Error('capture failed'); },
      selection: () => { throw new Error('selection failed'); },
    });
    expect(kind).toBe('charselect');
    expect(lc.nextResumeDelay()).toBe(2000);
    expect(lc.resumingCharSelect).toBe(true);
    expect(lc.charSelectResumeSelection).toBeUndefined();
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('a capture that throws on chargen with nothing else to resume: null, so the caller shows the Disconnected screen', () => {
    const lc = new SessionLifecycle();
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(armDropResume(lc, {
      unexpected: true, wasInWorld: false, enterPending: false, screen: 'chargen',
      keepChargenDraft: () => { throw new Error('capture failed'); },
    })).toBeNull();
    err.mockRestore();
  });
});

describe('a send that needs the session finds it dead first (sessionLiveForSend)', () => {
  it('connected: the send goes, nothing ends', () => {
    const end = vi.fn();
    expect(sessionLiveForSend({ isConnected: true }, end)).toBe(true);
    expect(end).not.toHaveBeenCalled();
  });

  it('not connected in chargen: the session ends through handleUnexpectedDrop as the chargen resume, never a silent wait', () => {
    const lc = new SessionLifecycle();
    const calls: string[] = [];
    const ok = sessionLiveForSend({ isConnected: false }, () => {
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
    expect(calls).toEqual(['left', 'teardown', 'resume:2000', 'resuming']);
    expect(lc.resumingChargen).toBe(true);
  });

  it('not connected after Entering World was chosen: the enter resume (the same character), else the Disconnected screen', () => {
    const lc = new SessionLifecycle();
    lc.noteEnterWorldRequested(0x50000002);
    const kind = armDropResume(lc, {
      unexpected: true, wasInWorld: false, enterPending: lc.enterWorldPending, screen: 'portal-space', keepChargenDraft: () => false,
    });
    expect(kind).toBe('enter');
    const none = new SessionLifecycle();
    const died: string[] = [];
    sessionLiveForSend({ isConnected: false }, () => {
      died.push(handleUnexpectedDrop({
        lifecycle: none, reportLeft: () => {}, teardownWorld: () => {}, scheduleResume: () => true,
        raiseServerDied: () => died.push('server_died'), armPreworldResume: () => false,
      }));
    });
    expect(died).toEqual(['server_died', 'server_died']);
  });
});

describe('UtilityBelt net across the back/forward cache', () => {
  /** A BroadcastChannel stand-in that records what this tab posts. */
  const channel = (posted: NetMessage[]): NetChannel => ({ post: (m) => posted.push(m), listen: () => {}, close: () => {} });

  it('pagehide says bye; a bfcache restore says hello again (data, hello); a replaced net is left alone; the remover unbinds', () => {
    const posted: NetMessage[] = [];
    const net = new UbNet({ channel: channel(posted), self: () => ({ name: 'Alpha', world: 'Coldeve' }), run: () => {}, report: () => {}, store: null, id: 'alpha' });
    net.start();
    const win = new FakeWindow();
    let current = true;
    const unbind = bindUbNetToPage(win, net, () => current);
    posted.length = 0;
    win.fire('pagehide');
    expect(posted.map((m) => m.kind)).toEqual(['bye']);
    win.fire('pageshow', { persisted: false });
    expect(posted.map((m) => m.kind)).toEqual(['bye']);
    win.fire('pageshow', { persisted: true });
    // The client data with its hello flag: the other tabs answer and list this one again.
    expect(posted.map((m) => m.kind)).toEqual(['bye', 'data']);
    expect((posted[1] as { hello?: boolean }).hello).toBe(true);
    current = false;
    win.fire('pagehide');
    expect(posted.map((m) => m.kind)).toEqual(['bye', 'data']);
    unbind();
    expect(win.count('pagehide') + win.count('pageshow')).toBe(0);
  });
});
