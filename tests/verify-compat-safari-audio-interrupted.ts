/**
 * COMPAT.safari-audio-interrupted — Safari has a fourth AudioContext state,
 * 'interrupted' (WebKit's AudioContext
 * "interrupted" state: https://bugs.webkit.org/show_bug.cgi?id=276016, W3C TAG review w3ctag/design-reviews#1069): a
 * running context goes there when the system takes the audio device or the
 * page is backgrounded, and only resume() brings it back. AudioManager.resume
 * acted on 'suspended' alone, and FirstGestureAudio had removed its gesture
 * listeners once the context first ran, so an interrupted Safari game stayed
 * silent until reload. Drives the real AudioManager on a fake Safari context
 * and the real installFirstGestureAudio.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AudioManager } from '../packages/renderer/src/audio/AudioManager.js';
import { installFirstGestureAudio } from '../packages/renderer/src/audio/FirstGestureAudio.js';

type State = 'suspended' | 'running' | 'interrupted' | 'closed';

/** A minimal Safari-like AudioContext: starts suspended (no gesture), has 'interrupted'. */
class FakeSafariContext extends EventTarget {
  static last: FakeSafariContext | null = null;
  state: State = 'suspended';
  resumes = 0;
  destination = {};
  constructor() { super(); FakeSafariContext.last = this; }
  createGain() { return { gain: { value: 1 }, connect() {} }; }
  private set(s: State) { this.state = s; this.dispatchEvent(new Event('statechange')); }
  async resume() { this.resumes++; this.set('running'); }
  async suspend() { this.set('suspended'); }
  async close() { this.set('closed'); }
  interrupt() { this.set('interrupted'); }
}

function fakeDocument() {
  const listeners: Array<{ type: string; fn: () => void }> = [];
  return {
    listeners,
    addEventListener(type: string, fn: EventListenerOrEventListenerObject) { listeners.push({ type, fn: fn as () => void }); },
    removeEventListener(type: string, fn: EventListenerOrEventListenerObject) {
      const i = listeners.findIndex((l) => l.type === type && l.fn === fn);
      if (i > -1) listeners.splice(i, 1);
    },
    fire(type: string) { for (const l of [...listeners]) if (l.type === type) l.fn(); },
  };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

const g = globalThis as Record<string, unknown>;
let saved: unknown;
beforeEach(() => { saved = g.AudioContext; g.AudioContext = FakeSafariContext; });
afterEach(() => { g.AudioContext = saved; });

describe("Safari's 'interrupted' AudioContext comes back on the next gesture", () => {
  it('AudioManager.resume() resumes an interrupted context, not only a suspended one', async () => {
    const am = new AudioManager();
    expect(am.init()).toBe(true);
    const ctx = FakeSafariContext.last!;
    await am.resume();
    expect(am.isRunning).toBe(true);
    ctx.interrupt();
    expect(am.isRunning).toBe(false);
    await am.resume();
    expect(ctx.resumes).toBe(2);
    expect(am.isRunning).toBe(true);
  });

  it('first gesture runs it and the listeners go; an interruption re-arms them; the next key resumes', async () => {
    const am = new AudioManager();
    const doc = fakeDocument();
    installFirstGestureAudio(doc, am, () => {});
    doc.fire('click');
    await settle();
    expect(am.isRunning).toBe(true);
    expect(doc.listeners).toHaveLength(0);

    FakeSafariContext.last!.interrupt();
    expect(doc.listeners.map((l) => l.type)).toEqual(['click', 'keydown', 'pointerdown']);
    doc.fire('keydown');
    await settle();
    expect(am.isRunning).toBe(true);
    expect(doc.listeners).toHaveLength(0);
  });

  it('our own suspend() (the play-only-when-active option) does not re-arm the gesture listeners', async () => {
    const am = new AudioManager();
    const doc = fakeDocument();
    installFirstGestureAudio(doc, am, () => {});
    doc.fire('click');
    await settle();
    await am.suspend();
    expect(doc.listeners).toHaveLength(0);
  });
});
