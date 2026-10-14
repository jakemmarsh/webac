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
import { describe, it, expect } from 'vitest';
import { installFirstGestureAudio } from '../packages/renderer/src/audio/FirstGestureAudio.js';

type Listener = () => void;
function fakeDocument() {
  const listeners: Array<{ type: string; fn: Listener; once: boolean }> = [];
  return {
    listeners,
    addEventListener(type: string, fn: EventListenerOrEventListenerObject, opts?: boolean | AddEventListenerOptions) {
      listeners.push({ type, fn: fn as Listener, once: typeof opts === 'object' && !!opts.once });
    },
    /** Dispatch like the browser: a listener's throw propagates here (prod reported it as an uncaught error). */
    click() {
      for (const l of [...listeners]) {
        if (l.type !== 'click') continue;
        if (l.once) listeners.splice(listeners.indexOf(l), 1);
        l.fn();
      }
    },
  };
}

function fakeAudio(opens = true) {
  return { inits: 0, init() { this.inits++; return opens; } };
}

describe('BUG.boot-click-tdz — the first-click audio handler during the boot', () => {
  it('a click before the GameUI exists opens audio without touching the UI and without throwing', () => {
    const doc = fakeDocument();
    const audio = fakeAudio();
    // main()'s wiring: the slot is declared before the listener, filled after `new GameUI`.
    let ui: { applied: number; applySoundCategories(): void } | null = null;
    const gesture = installFirstGestureAudio(doc, audio, () => ui?.applySoundCategories());
    expect(doc.listeners).toHaveLength(1);
    expect(doc.listeners[0]).toMatchObject({ type: 'click', once: true });
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

  it('only the first click counts; a context that fails to open applies nothing', () => {
    const doc = fakeDocument();
    const audio = fakeAudio(false);
    let applied = 0;
    const gesture = installFirstGestureAudio(doc, audio, () => { applied++; });
    doc.click();
    doc.click();
    expect(audio.inits).toBe(1);
    expect(applied).toBe(0);
    expect(gesture.initialized).toBe(false);
  });
});
