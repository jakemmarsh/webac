/**
 * BUG.boot-click-tdz — prod build 5101ef32 threw "Uncaught ReferenceError:
 * Cannot access 'E' before initialization" at HTMLDocument.ia
 * (index-BhvBxvRc.js:5383:57780). The source map puts it at main.ts's
 * first-click audio handler (`initAudio`), whose body read `gameUI` — a const
 * main() declares after several awaits. A click during the boot (the player
 * pressing the patch screen's Cancel at stage world_init) reached it first.
 *
 * The handler now lives in audio/FirstGestureAudio.ts and reaches the UI only
 * through the callback main() passes (a nullable slot filled once the GameUI
 * exists). These tests drive the real installer the way main() wires it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { installFirstGestureAudio } from '../packages/renderer/src/audio/FirstGestureAudio.js';
import { AudioManager } from '../packages/renderer/src/audio/AudioManager.js';

type Listener = () => void;
function fakeDocument() {
  const listeners: Array<{ type: string; fn: Listener }> = [];
  return {
    listeners,
    addEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      listeners.push({ type, fn: fn as Listener });
    },
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i > -1) listeners.splice(i, 1);
    },
    /** Dispatch like the browser: a listener's throw propagates here (prod reported it as an uncaught error). */
    fire(type: string) {
      for (const l of [...listeners]) if (l.type === type) l.fn();
    },
    click() { this.fire('click'); },
  };
}

function fakeAudio(opens = true) {
  return { inits: 0, init() { this.inits++; return opens; } };
}

/** An AudioManager-shaped source whose context starts suspended (opened before any gesture). */
function suspendedAudio() {
  return {
    inits: 0, resumes: 0, state: 'suspended' as 'suspended' | 'running',
    init() { this.inits++; return true; },
    async resume() { this.resumes++; this.state = 'running'; },
    get isRunning() { return this.state === 'running'; },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe('BUG.boot-click-tdz — the first-click audio handler during the boot', () => {
  it('a click before the GameUI exists opens audio without touching the UI and without throwing', () => {
    const doc = fakeDocument();
    const audio = fakeAudio();
    // main()'s wiring: the slot is declared before the listener, filled after `new GameUI`.
    let ui: { applied: number; applySoundCategories(): void } | null = null;
    const gesture = installFirstGestureAudio(doc, audio, () => ui?.applySoundCategories());
    expect(doc.listeners.map((l) => l.type)).toEqual(['click', 'keydown', 'pointerdown']);
    expect(() => doc.click()).not.toThrow();
    expect(audio.inits).toBe(1);
    expect(gesture.initialized).toBe(true);
    ui = { applied: 0, applySoundCategories() { this.applied++; } };
    expect(ui.applied).toBe(0);
  });

  it('the old shape — the callback reading a binding still in its TDZ — is what threw', () => {
    const doc = fakeDocument();
    // Reproduces the shipped closure: `gameUI` is referenced before its `const` runs.
    const run = (): void => {
      installFirstGestureAudio(doc, fakeAudio(), () => { void lateUi; });
      doc.click();
      const lateUi = 1;
      void lateUi;
    };
    expect(run).toThrow(ReferenceError);
  });

  it('a click once the GameUI exists applies the saved Sound Options to the new graph', () => {
    const doc = fakeDocument();
    const audio = fakeAudio();
    const ui = { applied: 0, applySoundCategories() { this.applied++; } };
    let slot: typeof ui | null = null;
    installFirstGestureAudio(doc, audio, () => slot?.applySoundCategories());
    slot = ui;
    doc.click();
    expect(audio.inits).toBe(1);
    expect(ui.applied).toBe(1);
  });

  it('a context that fails to open applies nothing and stops listening', () => {
    const doc = fakeDocument();
    const audio = fakeAudio(false);
    let applied = 0;
    const gesture = installFirstGestureAudio(doc, audio, () => { applied++; });
    doc.click();
    doc.click();
    expect(audio.inits).toBe(1);
    expect(applied).toBe(0);
    expect(gesture.initialized).toBe(false);
    expect(doc.listeners).toHaveLength(0);
  });
});

describe('BUG.combat-sounds-need-a-click — the gesture resumes a context world entry opened', () => {
  it('a key press (no click) resumes the suspended context, then the listeners go', async () => {
    const doc = fakeDocument();
    const audio = suspendedAudio();
    let applied = 0;
    const gesture = installFirstGestureAudio(doc, audio, () => { applied++; });
    doc.fire('keydown');
    await settle();
    expect(audio.resumes).toBe(1);
    expect(audio.isRunning).toBe(true);
    expect(gesture.initialized).toBe(true);
    expect(applied).toBe(1);
    expect(doc.listeners).toHaveLength(0);
  });

  it('a resume the browser refuses keeps listening; the next gesture tries again', async () => {
    const doc = fakeDocument();
    const audio = suspendedAudio();
    let refuse = true;
    audio.resume = async function () { this.resumes++; if (refuse) throw new Error('NotAllowedError'); this.state = 'running'; };
    installFirstGestureAudio(doc, audio, () => {});
    doc.click();
    await settle();
    expect(audio.isRunning).toBe(false);
    expect(doc.listeners).toHaveLength(3);
    refuse = false;
    doc.fire('pointerdown');
    await settle();
    expect(audio.inits).toBe(1);
    expect(audio.resumes).toBe(2);
    expect(audio.isRunning).toBe(true);
    expect(doc.listeners).toHaveLength(0);
  });
});

describe('BUG.combat-sounds-need-a-click — AudioManager.isRunning is the one sound gate', () => {
  const realCtx = (globalThis as { AudioContext?: unknown }).AudioContext;
  afterEach(() => { (globalThis as { AudioContext?: unknown }).AudioContext = realCtx; });
  function fakeContext(state: 'suspended' | 'running') {
    const node = () => ({ gain: { value: 1 }, connect() {} });
    return class { state = state; destination = {}; createGain = node; async resume() { this.state = 'running'; } };
  }

  it('false before init, false while the context is suspended, true once it runs', async () => {
    (globalThis as { AudioContext?: unknown }).AudioContext = fakeContext('suspended');
    const am = new AudioManager();
    expect(am.isRunning).toBe(false);
    expect(am.init()).toBe(true);
    expect(am.isInitialized).toBe(true);
    expect(am.isRunning).toBe(false);
    await am.resume();
    expect(am.isRunning).toBe(true);
  });

  it('a context opened without a gesture but already running (agent windows) plays: no click needed', () => {
    (globalThis as { AudioContext?: unknown }).AudioContext = fakeContext('running');
    const am = new AudioManager();
    am.init();
    expect(am.isRunning).toBe(true);
  });
});
