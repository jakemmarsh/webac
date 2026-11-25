/**
 * BUG.hidden-tab-close-read-as-drop — production 2026-11-24 (Sundering, end of
 * retail, build 02a5adb04d5a, Edge 158 on Windows; traces d4526bad28ea6d86 and
 * 2112eb37188ae4d9): a tab hidden 16-27 min at character select, its network
 * worker frozen (bridge browserQuietMs 28 s / 115 s, the server still talking).
 * The browser then closed the socket itself (bridge session_close
 * peerCloseCode=1001 "going away"; the page's close event said 1006), the page
 * reported a pre-world `dropped` (socket_closed 1006) and started the
 * char-select resume, and 1.6-2.0 s later pagehide sent `page_left` with
 * screen "resuming". The browser was unloading the page; the client read it as
 * a network drop: a pointless resume and a false `dropped` finding.
 *
 * Fix (inside path 1 of docs/reconnect.md, PageHideClose): a socket close
 * under a hidden page is held for HIDDEN_CLOSE_HOLD_MS; a pagehide inside it
 * wins (nothing resumes, nothing reports a drop); the page turning visible, a
 * send that needs the session, or the window running out hand it on as the
 * drop it is (inverse direction: a real drop on a hidden tab still resumes).
 */
import { describe, expect, it, vi } from 'vitest';
import { SessionLifecycle } from '../packages/renderer/src/session/SessionLifecycle.js';
import { PageHideClose, armDropResume, type HiddenCloseEnv } from '../packages/renderer/src/session/UnexpectedDrop.js';
import { installUnloadSessionClose } from '../packages/renderer/src/session/PlayerModuleSave.js';
import { HIDDEN_CLOSE_HOLD_MS, RESUME_DELAYS_MS } from '../packages/renderer/src/session/RetryPolicy.js';

/** A page's visibility, clock and timers, driven by the test. */
class FakePage implements HiddenCloseEnv {
  isHidden = true;
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private nextId = 1;
  hidden(): boolean { return this.isHidden; }
  now(): number { return this.t; }
  setTimeout(fn: () => void, ms: number): unknown { const id = this.nextId++; this.timers.set(id, { at: this.t + ms, fn }); return id; }
  clearTimeout(id: unknown): void { this.timers.delete(id as number); }
  get pending(): number { return this.timers.size; }
  advance(ms: number): void {
    this.t += ms;
    for (const [id, tm] of [...this.timers]) if (tm.at <= this.t) { this.timers.delete(id); tm.fn(); }
  }
}

/** A window stand-in for installUnloadSessionClose. */
class FakeWindow {
  private readonly l = new Map<string, Array<(ev: { persisted?: boolean }) => void>>();
  addEventListener(t: string, f: (ev: { persisted?: boolean }) => void): void { (this.l.get(t) ?? this.l.set(t, []).get(t)!).push(f); }
  fire(t: string, ev: { persisted?: boolean } = {}): void { for (const f of this.l.get(t) ?? []) f(ev); }
}

/**
 * main.ts's wiring in small: the connection's 'disconnected' → PageHideClose.ended
 * (socketDrop for an unexpected socket close) → onSessionEnded, which reports
 * `dropped` and arms the char-select resume (armDropResume, the real one); pagehide →
 * installUnloadSessionClose (the real one) with `leaving` → page_left.
 */
function page(env: FakePage) {
  const p = new PageHideClose(env);
  const lc = new SessionLifecycle();
  const events: string[] = [];
  let screen = 'char-select';
  const win = new FakeWindow();
  installUnloadSessionClose(win, {
    module: { flushChatOptionsSave: () => {} },
    connection: { isConnected: false, disconnect: () => {} }, // the socket already closed
    reporter: { pageUnloading: () => events.push(`page_left:${screen}`), pageRestored: () => events.push('restored') },
    closing: () => p.closing(),
    leaving: () => p.leaving(),
    restored: (persisted) => p.shown(persisted),
  });
  const socketClosed = (): void => p.ended((pageHideDrop) => {
    events.push('dropped');
    const kind = armDropResume(lc, {
      unexpected: true, wasInWorld: false, enterPending: false, screen,
      keepChargenDraft: () => false, selection: () => 'Char',
    });
    if (kind) { events.push(`resume:${kind}${pageHideDrop ? ':pagehide' : ''}`); screen = 'resuming'; }
  }, { socketDrop: true });
  return { p, lc, events, win, socketClosed };
}

describe('a socket closed under a hidden page, then pagehide (the production sequence)', () => {
  it('nothing resumes and no drop is reported; page_left reads the real screen', () => {
    const env = new FakePage();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { lc, events, win, socketClosed } = page(env);
    socketClosed();
    expect(events).toEqual([]);
    env.advance(1953); // trace d4526bad: pagehide 1953 ms after the close (2112eb37: 1644 ms)
    win.fire('pagehide', { persisted: false });
    expect(events).toEqual(['page_left:char-select']);
    env.advance(60_000); // the hold's timer was cancelled: nothing more, ever
    expect(events).toEqual(['page_left:char-select']);
    expect(lc.nextResumeDelay()).toBeNull(); // nothing armed to resume
    expect(log).toHaveBeenCalledWith(expect.stringContaining('1953 ms before pagehide'));
    log.mockRestore();
  });

  it('a page that comes back from the back/forward cache after that runs the held close as the drop it was', () => {
    const env = new FakePage();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { lc, events, win, socketClosed } = page(env);
    socketClosed();
    env.advance(1000);
    win.fire('pagehide', { persisted: true });
    env.isHidden = false;
    win.fire('pageshow', { persisted: true });
    expect(events).toEqual(['page_left:char-select', 'restored', 'dropped', 'resume:charselect']);
    expect(lc.nextResumeDelay()).toBe(RESUME_DELAYS_MS[0]);
    expect(lc.resumingCharSelect).toBe(true);
    vi.restoreAllMocks();
  });
});

describe('inverse: a real network drop on a hidden tab still resumes', () => {
  it('the tab stays hidden: the drop runs when the hold runs out', () => {
    const env = new FakePage();
    const { lc, events, socketClosed } = page(env);
    socketClosed();
    env.advance(HIDDEN_CLOSE_HOLD_MS - 1);
    expect(events).toEqual([]);
    env.advance(1);
    expect(events).toEqual(['dropped', 'resume:charselect']);
    expect(lc.nextResumeDelay()).toBe(RESUME_DELAYS_MS[0]);
    expect(env.pending).toBe(0);
  });

  it('the player comes back first: the drop runs at once, and the timer does not run it again', () => {
    const env = new FakePage();
    const { p, events, socketClosed } = page(env);
    socketClosed();
    env.advance(800);
    env.isHidden = false;
    p.visible();
    expect(events).toEqual(['dropped', 'resume:charselect']);
    env.advance(HIDDEN_CLOSE_HOLD_MS);
    expect(events).toEqual(['dropped', 'resume:charselect']);
    expect(env.pending).toBe(0);
  });

  it('a send that needs the session during the hold (main.ts endDeadSession) releases the held close once', () => {
    const env = new FakePage();
    const { p, events, socketClosed } = page(env);
    socketClosed();
    expect(p.holdingHiddenDrop).toBe(true);
    expect(p.release()).toBe(true); // the send's own dead-session path then stands down
    expect(events).toEqual(['dropped', 'resume:charselect']);
    expect(p.release()).toBe(false); // nothing held: endDeadSession goes on as before
    env.advance(HIDDEN_CLOSE_HOLD_MS);
    expect(events).toEqual(['dropped', 'resume:charselect']);
  });

  it('a pagehide after the hold ran out changes nothing: the resume already stands', () => {
    const env = new FakePage();
    const { events, win, socketClosed } = page(env);
    socketClosed();
    env.advance(HIDDEN_CLOSE_HOLD_MS);
    win.fire('pagehide', { persisted: false });
    expect(events).toEqual(['dropped', 'resume:charselect', 'page_left:resuming']);
  });
});

describe('what is never held', () => {
  it('a visible page: a socket close is the drop at once (a visible tab closing runs pagehide before its sockets close)', () => {
    const env = new FakePage();
    env.isHidden = false;
    const { events, socketClosed } = page(env);
    socketClosed();
    expect(events).toEqual(['dropped', 'resume:charselect']);
    expect(env.pending).toBe(0);
  });

  it('an end that is not an unexpected socket close (server_silent, client_suspended, our own close) on a hidden page', () => {
    const env = new FakePage();
    const p = new PageHideClose(env);
    const got: boolean[] = [];
    p.ended((d) => got.push(d));
    p.ended((d) => got.push(d), { socketDrop: false });
    expect(got).toEqual([false, false]);
    expect(env.pending).toBe(0);
  });

  it('a page whose visibility cannot be read is treated as visible (never held)', () => {
    const env = new FakePage();
    env.hidden = () => { throw new Error('no document'); };
    const p = new PageHideClose(env);
    const got: boolean[] = [];
    p.ended((d) => got.push(d), { socketDrop: true });
    expect(got).toEqual([false]);
  });

  it("a later end while one is held (another socket's) is handled at once; the held one keeps its place", () => {
    const env = new FakePage();
    const p = new PageHideClose(env);
    const got: string[] = [];
    p.ended(() => got.push('first'), { socketDrop: true });
    p.ended(() => got.push('second'));
    expect(got).toEqual(['second']);
    env.advance(HIDDEN_CLOSE_HOLD_MS);
    expect(got).toEqual(['second', 'first']);
  });

  it("the page's next connect forgets a held close (and its timer)", () => {
    const env = new FakePage();
    const p = new PageHideClose(env);
    const got: boolean[] = [];
    p.ended((d) => got.push(d), { socketDrop: true });
    p.connectAttempt();
    expect(env.pending).toBe(0);
    env.advance(HIDDEN_CLOSE_HOLD_MS);
    p.visible();
    expect(got).toEqual([]);
  });
});

describe('installUnloadSessionClose: leaving runs first on every pagehide, live session or not', () => {
  it('orders leaving before the reporter and the close, and runs without a live session', () => {
    const win = new FakeWindow();
    const order: string[] = [];
    let connected = true;
    installUnloadSessionClose(win, {
      module: { flushChatOptionsSave: () => order.push('flush') },
      connection: { get isConnected() { return connected; }, disconnect: () => { order.push('disconnect'); connected = false; } },
      reporter: { pageUnloading: () => order.push('sample') },
      closing: () => order.push('closing'),
      leaving: () => order.push('leaving'),
    });
    win.fire('pagehide');
    expect(order).toEqual(['leaving', 'sample', 'closing', 'flush', 'disconnect']);
    order.length = 0;
    win.fire('pagehide');
    expect(order).toEqual(['leaving', 'sample', 'flush', 'disconnect']);
  });

  it('a leaving that throws never blocks the save', () => {
    const win = new FakeWindow();
    const order: string[] = [];
    installUnloadSessionClose(win, {
      module: { flushChatOptionsSave: () => order.push('flush') },
      connection: { isConnected: false, disconnect: () => order.push('disconnect') },
      leaving: () => { throw new Error('boom'); },
    });
    win.fire('pagehide');
    expect(order).toEqual(['flush', 'disconnect']);
  });
});
