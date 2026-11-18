/**
 * AGENT.press-dispatch-target — ac_press (`__acAgent.press`) dispatched its synthetic keydown / keyup on `document`.
 * An event dispatched on document travels document → window only, so CameraController's listeners on document.body
 * never saw it: press('Autorun') answered "pressed KeyQ (Autorun)" and autorun never toggled, as for every movement
 * and camera key. dispatchKeyPress now targets what a real key targets (the focused element, else body), and the press
 * bubbles body → document → window, each listener seeing it once.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { dispatchKeyPress, keyEventTarget } from '../packages/renderer/src/input/KeybindActionLookup.js';
import { CameraController } from '../packages/renderer/src/scene/CameraController.js';
import { KeybindRegistry } from '../packages/renderer/src/input/KeybindRegistry.js';
import { DEFAULT_KEYBINDS, MOVEMENT_CANONICAL } from '../packages/renderer/src/input/KeybindDefaults.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow();
const DOM_GLOBALS = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'KeyboardEvent'] as const;

/** Run the scheduled keyup at once, recording the delay asked for. */
const now = (delays: number[]) => (fn: () => void, ms: number) => { delays.push(ms); fn(); };

describe('dispatchKeyPress — the press lands where a real key does', () => {
  const saved: Record<string, unknown> = {};
  beforeAll(() => { installDomGlobals(domWindow, DOM_GLOBALS, saved); });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });

  it('a listener on body, one on document and one on window each see the keydown and keyup once', () => {
    const doc = domWindow.document;
    const seen: string[] = [];
    const on = (where: string, t: EventTarget) => {
      const down = (e: Event) => seen.push(`${where}:down:${(e as KeyboardEvent).code}`);
      const up = (e: Event) => seen.push(`${where}:up:${(e as KeyboardEvent).code}`);
      t.addEventListener('keydown', down); t.addEventListener('keyup', up);
      return () => { t.removeEventListener('keydown', down); t.removeEventListener('keyup', up); };
    };
    const offs = [on('body', doc.body), on('document', doc), on('window', domWindow)];
    const delays: number[] = [];
    dispatchKeyPress(doc, 'KeyQ', 80, now(delays));
    offs.forEach((off) => off());
    expect(seen).toEqual([
      'body:down:KeyQ', 'document:down:KeyQ', 'window:down:KeyQ',
      'body:up:KeyQ', 'document:up:KeyQ', 'window:up:KeyQ',
    ]);
    expect(delays).toEqual([80]);
  });

  it('modifiers ride on the event; the code is the bare key', () => {
    const doc = domWindow.document;
    let ev: KeyboardEvent | null = null;
    const h = (e: Event) => { ev = e as KeyboardEvent; };
    doc.body.addEventListener('keydown', h);
    dispatchKeyPress(doc, 'Shift+Alt+KeyD', 80, () => {});
    doc.body.removeEventListener('keydown', h);
    expect(ev).not.toBeNull();
    expect([ev!.code, ev!.shiftKey, ev!.altKey, ev!.ctrlKey, ev!.bubbles, ev!.cancelable]).toEqual(['KeyD', true, true, false, true, true]);
  });

  it('a focused field gets the press first (as a real key), then it bubbles up past body; keyup goes to the same element', () => {
    const doc = domWindow.document;
    const input = doc.createElement('input');
    doc.body.appendChild(input);
    input.focus();
    expect(keyEventTarget(doc)).toBe(input);
    const seen: string[] = [];
    const rec = (where: string) => (e: Event) => seen.push(`${where}:${e.type}`);
    input.addEventListener('keydown', rec('input')); input.addEventListener('keyup', rec('input'));
    doc.body.addEventListener('keydown', rec('body'));
    let refocused = false;
    // The keyup goes to the element the keydown hit, even when focus moved between them.
    dispatchKeyPress(doc, 'Enter', 80, (fn) => { input.blur(); refocused = keyEventTarget(doc) === doc.body; fn(); });
    expect(refocused).toBe(true);
    expect(seen).toEqual(['input:keydown', 'body:keydown', 'input:keyup']);
    input.remove();
  });

  it('with nothing focused the target is body', () => {
    expect(keyEventTarget(domWindow.document)).toBe(domWindow.document.body);
  });

  it('the shipped CameraController bound to body (main.ts) toggles autorun and walks on an agent press', () => {
    const doc = domWindow.document;
    const c = new CameraController(new THREE.PerspectiveCamera());
    const reg = new KeybindRegistry(DEFAULT_KEYBINDS);
    c.keyTranslator = (code) => { const id = reg.resolve(code); return id != null ? MOVEMENT_CANONICAL[id] ?? null : null; };
    c.bind(doc.body);
    const autorunKey = reg.getMappings(reg.actions().find((a) => a.name === 'Autorun')!.id).find((m): m is string => !!m)!;
    expect(c.autoRun).toBe(false);
    dispatchKeyPress(doc, autorunKey, 80, (fn) => fn());
    expect(c.autoRun).toBe(true);
    dispatchKeyPress(doc, autorunKey, 80, (fn) => fn());
    expect(c.autoRun).toBe(false);
    // A held movement key: down moves, the scheduled up stops.
    let release: (() => void) | null = null;
    dispatchKeyPress(doc, 'KeyW', 80, (fn) => { release = fn; });
    expect(c.isMovingForward).toBe(true);
    release!();
    expect(c.isMovingForward).toBe(false);
  });
});
