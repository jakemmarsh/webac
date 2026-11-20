/**
 * TELEMETRY.extension-errors — an uncaught error thrown by a browser
 * extension's own script (every URL in its source and stack an extension's)
 * is not counted in the page's error count (the first minute's `errors`), and
 * a page sends at most one, as kind `extension_error` with the extension's
 * id and first frame. Anything with a frame of ours is reported as before.
 * Drives the real ErrorReporter through install()'s listeners and the real
 * bridge sanitizer.
 *
 * Prod case: 2026-11-20 06:17Z, trace 88ff0efc576013bb, errors=121 in the
 * first minute, every frame in chrome-extension://eppio…/executors/200.js.
 */
import { describe, it, expect } from 'vitest';
import { ErrorReporter, extensionOrigin } from '../packages/renderer/src/telemetry/ErrorReporter.js';
import { WorldReporter, type WorldEvent } from '../packages/renderer/src/telemetry/WorldReporter.js';
import { sanitizeClientError } from '../services/ws-tcp-bridge/src/clientErrors.js';

const EXT = 'chrome-extension://eppiocemhmnlbhjplcgkofciiegomcon/executors/200.js';
const EXT_STACK = `TypeError: Cannot read properties of undefined (reading 'M_ID')\n    at h (${EXT}:1:761)\n    at C (${EXT}:1:1442)`;
const OURS = 'https://playwebac.com/assets/main-abc123.js';

function harness() {
  const sent: Array<Record<string, unknown>> = [];
  const r = new ErrorReporter({
    endpoint: 'https://bridge.example/client-errors', build: 'b1', screen: () => 'boot', userAgent: 'UA',
    send: (_url, body) => { sent.push(JSON.parse(body)); },
  });
  const listeners = new Map<string, (ev: Event) => void>();
  r.install({ addEventListener: (t: string, l: (ev: Event) => void) => { listeners.set(t, l); } } as never);
  const reject = (err: Error) => listeners.get('unhandledrejection')!({ reason: err } as unknown as Event);
  const windowError = (ev: Record<string, unknown>) => listeners.get('error')!(ev as unknown as Event);
  return { r, sent, reject, windowError };
}

function errWith(message: string, stack: string): Error {
  const e = new TypeError(message);
  e.stack = stack;
  return e;
}

describe('TELEMETRY.extension-errors — ErrorReporter', () => {
  it('the prod case: an extension-only rejection is not counted and is sent once as extension_error with the id and first frame', () => {
    const { r, sent, reject } = harness();
    reject(errWith("Cannot read properties of undefined (reading 'M_ID')", EXT_STACK));
    expect(r.reportCount).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      kind: 'extension_error',
      message: "TypeError: Cannot read properties of undefined (reading 'M_ID')",
      extensionId: 'eppiocemhmnlbhjplcgkofciiegomcon',
      stack: `at h (${EXT}:1:761)`,
      screen: 'boot',
      count: 1,
    });
  });

  it('a second extension error, the same or a different one (another extension too), sends nothing more and counts nothing', () => {
    const { r, sent, reject, windowError } = harness();
    for (let i = 0; i < 121; i++) reject(errWith("Cannot read properties of undefined (reading 'M_ID')", EXT_STACK));
    reject(errWith('other', `TypeError: other\n    at x (${EXT}:9:9)`));
    windowError({ message: 'Uncaught Error: y', error: null, filename: 'moz-extension://3c4a2b1e-1111-2222-3333-444455556666/content.js', lineno: 4, colno: 2 });
    expect(r.reportCount).toBe(0);
    expect(sent).toHaveLength(1);
  });

  it('a mixed stack (an extension frame and one of our bundle) is ours: counted and sent as before', () => {
    const { r, sent, reject } = harness();
    reject(errWith('boom', `TypeError: boom\n    at h (${EXT}:1:761)\n    at frameStep (${OURS}:1:2000)`));
    expect(r.reportCount).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'unhandledrejection', message: 'TypeError: boom' });
    expect(sent[0].stack).toContain(OURS);
    expect(sent[0].extensionId).toBeUndefined();
  });

  it('a window error with no stack and an extension source is the extension\'s', () => {
    const { r, sent, windowError } = harness();
    windowError({ message: 'Uncaught TypeError: z', error: null, filename: `${EXT}`, lineno: 1, colno: 5 });
    expect(r.reportCount).toBe(0);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'extension_error', extensionId: 'eppiocemhmnlbhjplcgkofciiegomcon', source: EXT, line: 1, column: 5, stack: EXT });
  });

  it('our own errors are unchanged: counted, sent with their kind; no URL at all (or <anonymous> only) stays ours', () => {
    const { r, sent, reject, windowError } = harness();
    windowError({ message: 'ReferenceError: q', error: new ReferenceError('q'), filename: OURS, lineno: 3, colno: 4 });
    reject(new Error('no stack url'));
    reject(errWith('anon', 'TypeError: anon\n    at <anonymous>:1:20'));
    r.report('boot', 'unsupported browser: webgl2');
    expect(r.reportCount).toBe(4);
    expect(sent.map(s => s.kind)).toEqual(['error', 'unhandledrejection', 'unhandledrejection', 'boot']);
    // An extension error after ours still goes once, without touching the count.
    reject(errWith('ext', EXT_STACK));
    expect(r.reportCount).toBe(4);
    expect(sent.at(-1)).toMatchObject({ kind: 'extension_error' });
  });

  it('extensionOrigin knows every extension scheme and needs every URL to be one', () => {
    for (const [url, id] of [
      ['chrome-extension://abc/x.js', 'abc'],
      ['moz-extension://3c4a2b1e-1111-2222-3333-444455556666/x.js', '3c4a2b1e-1111-2222-3333-444455556666'],
      ['safari-web-extension://ABCDEF12-3456/x.js', 'ABCDEF12-3456'],
      ['safari-extension://com.example.ext-TEAM/x.js', 'com.example.ext-TEAM'],
      ['ms-browser-extension://Ext_1/x.js', 'Ext_1'],
      ['webkit-masked-url://hidden/', 'hidden'], // Safari 16.4+ masks extension frames

    ] as const) {
      expect(extensionOrigin(`Error\n    at f (${url}:1:2)`, null)?.extensionId).toBe(id);
    }
    expect(extensionOrigin(null, null)).toBeNull();
    expect(extensionOrigin('Error: x', null)).toBeNull();
    expect(extensionOrigin(EXT_STACK, OURS)).toBeNull();
    expect(extensionOrigin(`Error\n    at f (blob:https://playwebac.com/1234:1:2)\n    at g (${EXT}:1:1)`, null)).toBeNull();
    // Firefox's frame shape: name@url:line:col.
    expect(extensionOrigin(`h@${EXT}:1:761\nC@${EXT}:1:1442`, null)).toEqual({ extensionId: 'eppiocemhmnlbhjplcgkofciiegomcon', firstFrame: `h@${EXT}:1:761` });
  });

  it('the first minute\'s errors (WorldReporter, fed reportCount as main.ts does) leaves the extension\'s errors out', () => {
    const { r, reject } = harness();
    const events: WorldEvent[] = [];
    const clock = { t: 1000 };
    const w = new WorldReporter({
      endpoint: 'http://x/client-preworld', build: 'b1', trace: '9f8e7d6c5b4a3210', era: () => 'eor', server: () => 'x',
      now: () => clock.t, send: (_u, b) => { events.push(JSON.parse(b) as WorldEvent); },
    });
    w.setSources({ screen: () => 'world', errors: () => r.reportCount });
    w.enteredWorld();
    for (let i = 0; i < 121; i++) reject(errWith("Cannot read properties of undefined (reading 'M_ID')", EXT_STACK));
    reject(errWith('ours', `TypeError: ours\n    at f (${OURS}:1:1)`));
    w.left('closed_tab');
    expect(events[0]).toMatchObject({ outcome: 'first_minute', errors: 1 });
  });
});

describe('TELEMETRY.extension-errors — the bridge sanitizer', () => {
  it('accepts kind extension_error with its extensionId; an id-unshaped or misplaced extensionId is dropped', () => {
    const ok = sanitizeClientError({ kind: 'extension_error', message: 'TypeError: x', stack: `at h (${EXT}:1:761)`, extensionId: 'eppiocemhmnlbhjplcgkofciiegomcon', count: 1 });
    expect(ok).toMatchObject({ kind: 'extension_error', extensionId: 'eppiocemhmnlbhjplcgkofciiegomcon', stack: `at h (${EXT}:1:761)` });
    expect(sanitizeClientError({ kind: 'extension_error', message: 'x', extensionId: 'bad id with "quotes"' })!.extensionId).toBeUndefined();
    expect(sanitizeClientError({ kind: 'error', message: 'x', extensionId: 'abc' })!.extensionId).toBeUndefined();
    expect(sanitizeClientError({ kind: 'not_a_kind', message: 'x' })).toBeNull();
  });
});
