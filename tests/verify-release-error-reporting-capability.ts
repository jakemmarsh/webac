/**
 * RELEASE.error-reporting + RELEASE.capability-check — the real
 * telemetry/ErrorReporter.ts and boot/Capability.ts.
 */
import { describe, it, expect } from 'vitest';
import { Window } from 'happy-dom';
import { ErrorReporter, MAX_REPORTS, stripUrlQueries } from '../packages/renderer/src/telemetry/ErrorReporter.js';
import { capabilityProblems, showCapabilityScreen, MIN_DEVICE_MEMORY_GB } from '../packages/renderer/src/boot/Capability.js';

function reporter(endpoint: string | null = 'https://bridge.example/client-errors') {
  const sent: Array<{ url: string; body: Record<string, unknown> }> = [];
  const r = new ErrorReporter({
    endpoint, build: 'b1', screen: () => 'world', userAgent: 'UA',
    send: (url, body) => sent.push({ url, body: JSON.parse(body) }),
  });
  return { r, sent };
}

describe('RELEASE.error-reporting — ErrorReporter', () => {
  it('the endpoint is the bridge host over http(s)', () => {
    expect(ErrorReporter.endpointFor('wss://bridge.playwebac.com/connect?server=x')).toBe('https://bridge.playwebac.com/client-errors');
    expect(ErrorReporter.endpointFor('ws://localhost:9090')).toBe('http://localhost:9090/client-errors');
    expect(ErrorReporter.endpointFor('nonsense')).toBeNull();
  });

  it('reports once per distinct error, strips query strings, carries build + screen, and caps a page at MAX_REPORTS', () => {
    const { r, sent } = reporter();
    r.report('error', 'TypeError: boom at http://localhost:3000/?account=bob&password=hunter2', {
      stack: 'at f (http://localhost:3000/src/main.ts?t=123:10:5)', source: 'http://localhost:3000/src/main.ts?t=123', line: 10, column: 5,
    });
    r.report('error', 'TypeError: boom at http://localhost:3000/?account=bob&password=hunter2', { source: 'http://localhost:3000/src/main.ts?t=123', line: 10 });
    expect(sent).toHaveLength(1);
    const body = sent[0].body;
    expect(sent[0].url).toBe('https://bridge.example/client-errors');
    expect(JSON.stringify(body)).not.toMatch(/hunter2|bob|\?t=/);
    expect(body).toMatchObject({ kind: 'error', message: 'TypeError: boom at http://localhost:3000/', stack: 'at f (http://localhost:3000/src/main.ts:10:5)', build: 'b1', screen: 'world', userAgent: 'UA', count: 1 });
    for (let i = 0; i < MAX_REPORTS + 5; i++) r.report('unhandledrejection', `e${i}`);
    expect(sent).toHaveLength(MAX_REPORTS);
  });

  it('install() turns window errors and unhandled rejections into reports; resource load errors are ignored', () => {
    const { r, sent } = reporter();
    const listeners = new Map<string, (ev: Event) => void>();
    r.install({ addEventListener: (t: string, l: (ev: Event) => void) => { listeners.set(t, l); } } as never);
    listeners.get('error')!({ message: '', error: null } as unknown as Event); // <img> 404
    // Chrome's benign ResizeObserver window errors (both wordings) are not crashes.
    listeners.get('error')!({ message: 'ResizeObserver loop completed with undelivered notifications.', error: null } as unknown as Event);
    listeners.get('error')!({ message: 'ResizeObserver loop limit exceeded', error: null } as unknown as Event);
    listeners.get('error')!({ message: 'ReferenceError: x is not defined', error: new ReferenceError('x is not defined'), filename: 'https://a/b.js', lineno: 3, colno: 4 } as unknown as Event);
    listeners.get('unhandledrejection')!({ reason: new Error('nope') } as unknown as Event);
    expect(sent.map(s => [s.body.kind, s.body.message])).toEqual([
      ['error', 'ReferenceError: x is not defined'],
      ['unhandledrejection', 'Error: nope'],
    ]);
    const canvasListeners = new Map<string, () => void>();
    r.watchCanvas({ addEventListener: (t: string, l: () => void) => { canvasListeners.set(t, l); } } as never);
    canvasListeners.get('webglcontextlost')!();
    expect(sent.at(-1)!.body).toMatchObject({ kind: 'webglcontextlost', message: 'WebGL context lost' });
  });

  it('no endpoint → nothing is sent', () => {
    const { r, sent } = reporter(null);
    r.report('error', 'x');
    expect(sent).toHaveLength(0);
    expect(stripUrlQueries('see https://x.example/a?b=c#d.')).toBe('see https://x.example/a');
  });
});

describe('RELEASE.capability-check — Capability', () => {
  const ok = { webgl2: true, websocket: true, deviceMemoryGb: 8, finePointer: true };

  it('a capable desktop browser has no problems; deviceMemory unknown (Firefox/Safari) is not a problem', () => {
    expect(capabilityProblems(ok)).toEqual([]);
    expect(capabilityProblems({ ...ok, deviceMemoryGb: null })).toEqual([]);
  });

  it('no WebGL 2 or WebSocket is blocking; low memory and touch-only are warnings', () => {
    expect(capabilityProblems({ ...ok, webgl2: false }).map(p => [p.id, p.hard])).toEqual([['webgl2', true]]);
    expect(capabilityProblems({ ...ok, websocket: false }).map(p => [p.id, p.hard])).toEqual([['websocket', true]]);
    expect(capabilityProblems({ ...ok, deviceMemoryGb: MIN_DEVICE_MEMORY_GB / 2, finePointer: false }).map(p => [p.id, p.hard]))
      .toEqual([['memory', false], ['pointer', false]]);
  });

  it('the screen lets the player continue past warnings, and has no way past a blocking problem', async () => {
    const win = new Window();
    const doc = win.document as unknown as Document;
    const soft = showCapabilityScreen(doc, capabilityProblems({ ...ok, finePointer: false }));
    const btn = doc.querySelector('.capability-continue') as HTMLButtonElement;
    expect(doc.querySelector('.capability-pointer')?.textContent).toMatch(/keyboard and mouse/);
    btn.click();
    await soft;
    expect(doc.getElementById('capability-screen')).toBeNull();
    void showCapabilityScreen(doc, capabilityProblems({ ...ok, webgl2: false }));
    expect(doc.querySelector('.capability-webgl2')?.textContent).toMatch(/WebGL 2/);
    expect(doc.querySelector('.capability-continue')).toBeNull();
    await win.happyDOM.close();
  });
});
