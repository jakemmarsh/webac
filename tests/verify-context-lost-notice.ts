/**
 * BUG.webgl-lost-no-notice — a lost game context the browser never gives back
 * gets the boot notice plate with Reload (ui/ContextLostNotice.ts), and the
 * world telemetry says the notice showed and whether Reload was pressed.
 *
 * Drives the real module on a happy-dom canvas with real webglcontextlost /
 * webglcontextrestored events and a fake clock; the telemetry through the real
 * WorldReporter and the bridge's sanitizer.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { loadDomWindow } from './_harness/dom.js';
import {
  ContextLostNotice, CONTEXT_LOST_NOTICE_GRACE_MS, CONTEXT_LOST_NOTICE_ID, contextLostNoticeText,
} from '../packages/renderer/src/ui/ContextLostNotice.js';
import { WorldReporter, type WorldEvent } from '../packages/renderer/src/telemetry/WorldReporter.js';
import { sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1280, innerHeight: 720 });
const doc = domWindow.document as Document;

/** A fake clock for the notice's timers. */
function clock() {
  let now = 0;
  let nextId = 1;
  const timers = new Map<number, { at: number; f: () => void }>();
  return {
    setTimeout: (f: () => void, ms: number) => { const id = nextId++; timers.set(id, { at: now + ms, f }); return id; },
    clearTimeout: (id: unknown) => { timers.delete(id as number); },
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].f();
      }
      now = end;
    },
    get pending() { return timers.size; },
  };
}

let visibility: 'visible' | 'hidden' = 'visible';
Object.defineProperty(doc, 'visibilityState', { configurable: true, get: () => visibility });
const setVisibility = (v: 'visible' | 'hidden'): void => { visibility = v; doc.dispatchEvent(new domWindow.Event('visibilitychange')); };

interface Rig {
  canvas: HTMLCanvasElement;
  notice: ContextLostNotice;
  c: ReturnType<typeof clock>;
  reloads: number;
  shown: number;
  reloadPressed: number;
}

function rig(inWorld = true): Rig {
  const canvas = doc.createElement('canvas') as HTMLCanvasElement;
  canvas.id = 'game-canvas';
  doc.body.appendChild(canvas);
  const c = clock();
  const r: Partial<Rig> = { canvas, c, reloads: 0, shown: 0, reloadPressed: 0 };
  r.notice = new ContextLostNotice(canvas, {
    doc, inWorld: () => inWorld,
    onShown: () => { r.shown!++; }, onReload: () => { r.reloadPressed!++; }, reload: () => { r.reloads!++; },
    setTimeout: c.setTimeout, clearTimeout: c.clearTimeout,
  });
  return r as Rig;
}
const lose = (g: Rig): void => { g.canvas.dispatchEvent(new domWindow.Event('webglcontextlost')); };
const restore = (g: Rig): void => { g.canvas.dispatchEvent(new domWindow.Event('webglcontextrestored')); };
const plate = (): HTMLElement | null => doc.getElementById(CONTEXT_LOST_NOTICE_ID);

let live: Rig[] = [];
const make = (inWorld = true): Rig => { const g = rig(inWorld); live.push(g); return g; };
afterEach(() => {
  for (const g of live) g.notice.dispose();
  live = [];
  visibility = 'visible';
  doc.body.innerHTML = '';
});

describe('BUG.webgl-lost-no-notice — the lost-graphics notice', () => {
  it('a loss the browser restores in 1 s never shows it', () => {
    const g = make();
    lose(g);
    g.c.advance(1000);
    restore(g);
    g.c.advance(60_000);
    expect(plate()).toBeNull();
    expect(g.shown).toBe(0);
    expect(g.c.pending).toBe(0);
  });

  it('a loss still unrestored after the grace shows the plate with Reload, in the world\'s words', () => {
    expect(CONTEXT_LOST_NOTICE_GRACE_MS).toBe(10_000);
    const g = make(true);
    lose(g);
    g.c.advance(CONTEXT_LOST_NOTICE_GRACE_MS - 1);
    expect(plate()).toBeNull();
    g.c.advance(1);
    const p = plate()!;
    expect(p).not.toBeNull();
    expect(g.notice.shown).toBe(true);
    expect(g.shown).toBe(1);
    const text = p.textContent ?? '';
    for (const line of contextLostNoticeText(true)) expect(text).toContain(line);
    expect(text).toContain('You are still connected');
    expect(text).toContain('You will need to log in again.');
    const btn = p.querySelector('button.context-lost-reload') as HTMLButtonElement;
    expect(btn.textContent).toBe('Reload');
    // Over the world, not a wall: only the plate takes the mouse.
    expect(p.style.pointerEvents).toBe('none');
    expect((p.querySelector('.boot-notice-plate') as HTMLElement).style.pointerEvents).toBe('auto');
    btn.click();
    expect(g.reloadPressed).toBe(1);
    expect(g.reloads).toBe(1);
  });

  it('pre-world: the same plate without the connection line', () => {
    const g = make(false);
    lose(g);
    g.c.advance(CONTEXT_LOST_NOTICE_GRACE_MS);
    const text = plate()!.textContent ?? '';
    expect(text).toContain('The browser reset its graphics');
    expect(text).not.toContain('still connected');
    expect(text).toContain('Press Reload to bring the graphics back.');
  });

  it('does not take the focus from the chat box (the next Enter must not reload)', () => {
    const input = doc.createElement('input');
    doc.body.appendChild(input);
    input.focus();
    const g = make();
    lose(g);
    g.c.advance(CONTEXT_LOST_NOTICE_GRACE_MS);
    expect(plate()).not.toBeNull();
    expect(doc.activeElement).toBe(input);
  });

  it('a hidden page defers it; the grace starts over once the page is visible', () => {
    const g = make();
    setVisibility('hidden');
    lose(g);
    g.c.advance(5 * 60_000);
    expect(plate()).toBeNull();
    setVisibility('visible');
    g.c.advance(CONTEXT_LOST_NOTICE_GRACE_MS - 1);
    expect(plate()).toBeNull();
    g.c.advance(1);
    expect(plate()).not.toBeNull();
  });

  it('hiding the page during the grace cancels it (the 2026-11-21 tabs were hidden ~1.5 s)', () => {
    const g = make();
    lose(g);
    g.c.advance(5000);
    setVisibility('hidden');
    g.c.advance(1500);
    setVisibility('visible');
    g.c.advance(CONTEXT_LOST_NOTICE_GRACE_MS - 1);
    expect(plate()).toBeNull();
    g.c.advance(1);
    expect(plate()).not.toBeNull();
  });

  it('a later webglcontextrestored takes it away, and a second loss can show it again', () => {
    const g = make();
    lose(g);
    g.c.advance(CONTEXT_LOST_NOTICE_GRACE_MS);
    expect(plate()).not.toBeNull();
    restore(g);
    expect(plate()).toBeNull();
    expect(g.notice.shown).toBe(false);
    lose(g);
    g.c.advance(CONTEXT_LOST_NOTICE_GRACE_MS);
    expect(plate()).not.toBeNull();
    expect(g.shown).toBe(2);
  });

  it('an intentional loss (data-ac-intentional-loss) never shows it', () => {
    const g = make();
    g.canvas.dataset.acIntentionalLoss = '1';
    lose(g);
    g.c.advance(10 * 60_000);
    expect(plate()).toBeNull();
    expect(g.c.pending).toBe(0);
  });

  it('dispose removes the listeners and the plate', () => {
    const g = make();
    lose(g);
    g.c.advance(CONTEXT_LOST_NOTICE_GRACE_MS);
    g.notice.dispose();
    expect(plate()).toBeNull();
    lose(g);
    g.c.advance(CONTEXT_LOST_NOTICE_GRACE_MS);
    expect(plate()).toBeNull();
  });
});

describe('BUG.webgl-lost-no-notice — telemetry', () => {
  function reporter() {
    const events: WorldEvent[] = [];
    const t = { now: 1000 };
    const r = new WorldReporter({
      endpoint: 'http://x/client-preworld', build: 'abc1234', trace: 'feedc0de12345678', era: () => 'eor', server: () => 'coldeve',
      now: () => t.now, send: (_u, b) => { events.push(JSON.parse(b) as WorldEvent); },
    });
    return { r, events, t };
  }

  it('first_minute: shown and reloaded from the notice (the reload\'s pagehide sends closed_tab)', () => {
    const { r, events, t } = reporter();
    r.enteredWorld();
    t.now += 2000; r.contextLostNow();
    t.now += CONTEXT_LOST_NOTICE_GRACE_MS; r.lostNoticeShownNow();
    t.now += 5000; r.lostNoticeReloadNow();
    r.left('closed_tab');
    expect(events[0]).toMatchObject({ outcome: 'first_minute', exit: 'closed_tab', contextRestored: false, lostNoticeShown: true, lostNoticeReload: true });
    expect(sanitizeClientWorld(events[0])).toMatchObject({ lostNoticeShown: true, lostNoticeReload: true });
  });

  it('world_left after a long session: shown, closed without Reload; fields reset on the next entry', () => {
    const { r, events, t } = reporter();
    r.enteredWorld();
    for (let i = 0; i < 61; i++) { t.now += 1000; r.tick(); }
    r.contextLostNow();
    t.now += CONTEXT_LOST_NOTICE_GRACE_MS; r.lostNoticeShownNow();
    t.now += 800_000;
    r.left('closed_tab');
    const left = events.find((e) => e.outcome === 'world_left')!;
    expect(left).toMatchObject({ contextRestored: false, lostNoticeShown: true, lostNoticeReload: false });
    expect(sanitizeClientWorld(left)).toMatchObject({ lostNoticeShown: true, lostNoticeReload: false });
    r.enteredWorld();
    r.left('logout');
    expect(events.at(-1)).toMatchObject({ outcome: 'first_minute', lostNoticeShown: false, lostNoticeReload: false });
  });

  it('outside the world the reporter records nothing; an older page\'s event keeps no notice keys at the bridge', () => {
    const { r, events } = reporter();
    r.lostNoticeShownNow();
    r.lostNoticeReloadNow();
    r.enteredWorld();
    r.left('logout');
    expect(events[0]).toMatchObject({ lostNoticeShown: false, lostNoticeReload: false });
    const old = { ...events[0] } as Record<string, unknown>;
    delete old.lostNoticeShown; delete old.lostNoticeReload;
    const s = sanitizeClientWorld(old) as unknown as Record<string, unknown>;
    expect(s).not.toHaveProperty('lostNoticeShown');
    expect(s).not.toHaveProperty('lostNoticeReload');
  });
});
