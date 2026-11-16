/**
 * BUG.webgl-crash-block-wait — prod 2026-11-16 15:06Z: a GPU reset took both of a player's webAC
 * tabs' WebGL contexts, and each reload for ~75 s stopped on the capability screen with
 * webglCause "context_lost_after_crash" ("Web page caused context loss and was blocked"), whose
 * text said to quit the browser. Chromium's block lifts by itself after
 * kBlockedDomainExpirationPeriod = base::Minutes(2), so for that cause the screen now tries WebGL 2
 * quietly every 10 s for 150 s and the boot goes on when one works.
 *
 * Drives the real gate (boot/Capability.ts runCapabilityGate) with the real probes
 * (probeCapabilities, browserCanCreateWebGl2) over a fake browser whose block lifts on the Nth
 * WebGL 2 attempt, under fake timers; the real screen in happy-dom; and the telemetry through the
 * real reporter and the bridge's sanitizer.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import {
  runCapabilityGate, waitForWebGl2, crashBlockWaitable, capabilityProblems, probeCapabilities, browserCanCreateWebGl2,
  WEBGL_CRASH_BLOCK_PROBE_MS, WEBGL_CRASH_BLOCK_WAIT_MS, type CapabilityEnv, type CapabilityProblem, type WebGlWaitResult,
} from '../packages/renderer/src/boot/Capability.js';
import { canCreateWebGl2 } from '../packages/renderer/src/boot/WebGlDiagnosis.js';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld, PREWORLD_OUTCOMES } from '../services/ws-tcp-bridge/src/clientPreworld.js';

const CHROMIUM_BLOCKED = 'Web page caused context loss and was blocked';
const CHROME_WIN = { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36', userAgentData: { platform: 'Windows', brands: [{ brand: 'Google Chrome' }, { brand: 'Chromium' }] } };

/**
 * A Chromium-like browser: WebGL (1 and 2) refused with `status` until `liftAfter` WebGL 2 attempts
 * have failed; every created context counts its WEBGL_lose_context release.
 */
function fakeBrowser(opts: { status: string; liftAfter: number; finePointer?: boolean }) {
  const s = { webgl2Attempts: 0, contexts: 0, released: 0 };
  const createElement = () => {
    const listeners: Array<(ev: Event) => void> = [];
    return {
      addEventListener(type: string, l: (ev: Event) => void) { if (type === 'webglcontextcreationerror') listeners.push(l); },
      getContext(kind: string) {
        if (kind === '2d') return {};
        if (kind === 'webgl2') s.webgl2Attempts++;
        if (s.webgl2Attempts > opts.liftAfter) {
          s.contexts++;
          return {
            getExtension: (n: string) => (n === 'WEBGL_lose_context' ? { loseContext: () => { s.released++; } } : null),
            getParameter: () => 'ANGLE (NVIDIA GeForce RTX 3060)',
          };
        }
        for (const l of listeners) l({ type: 'webglcontextcreationerror', statusMessage: opts.status } as unknown as Event);
        return null;
      },
    };
  };
  const win = {
    document: { createElement },
    navigator: { ...CHROME_WIN, webdriver: false },
    WebSocket: function WebSocket() {},
    DecompressionStream: function DecompressionStream() {},
    matchMedia: () => ({ matches: opts.finePointer ?? true }),
    location: { search: '' },
  } as unknown as Parameters<typeof probeCapabilities>[0];
  return { s, win };
}

const timers = { setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms), now: () => Date.now() };

/** The gate over a fake browser, with the screen and telemetry recorded. */
function gate(b: ReturnType<typeof fakeBrowser>) {
  const shows: Array<{ ids: string[]; waiting: boolean }> = [];
  const waits: WebGlWaitResult[] = [];
  let done: CapabilityEnv | null = null;
  const p = runCapabilityGate({
    probe: () => probeCapabilities(b.win),
    probed: () => {},
    showing: () => {},
    show: (problems: CapabilityProblem[], recovered?: Promise<boolean>) => {
      shows.push({ ids: problems.map(x => x.id), waiting: !!recovered });
      if (!problems.some(x => x.hard)) return Promise.resolve();
      return new Promise<void>((resolve) => { void recovered?.then(ok => { if (ok) resolve(); }); });
    },
    canCreateWebGl2: () => browserCanCreateWebGl2(b.win.document),
    timers,
    waited: (r) => waits.push(r),
  }).then((env) => { done = env; });
  return { p, shows, waits, done: () => done };
}

describe('BUG.webgl-crash-block-wait — the quiet WebGL 2 wait', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('the window covers Chromium\'s 2-minute block with margin, one try every 10 s', () => {
    expect(WEBGL_CRASH_BLOCK_PROBE_MS).toBe(10_000);
    expect(WEBGL_CRASH_BLOCK_WAIT_MS).toBe(150_000);
    expect(WEBGL_CRASH_BLOCK_WAIT_MS).toBeGreaterThan(2 * 60_000);
  });

  it('the block lifts on the 4th quiet try: the screen goes, the boot goes on with WebGL 2, recovered at 40 s', async () => {
    // Boot's probe = attempt 1; quiet tries 2..4; the 4th quiet try (attempt 5) works.
    const b = fakeBrowser({ status: CHROMIUM_BLOCKED, liftAfter: 4 });
    const g = gate(b);
    await vi.advanceTimersByTimeAsync(0);
    expect(g.shows).toEqual([{ ids: ['webgl2'], waiting: true }]);
    await vi.advanceTimersByTimeAsync(39_999);
    expect(g.done()).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    await g.p;
    expect(g.waits).toEqual([{ recovered: true, waitedMs: 40_000 }]);
    expect(g.done()!.webgl2).toBe(true);
    // Every context made (the working quiet try and the boot's re-probe) was released.
    expect(b.s.released).toBe(b.s.contexts);
    expect(b.s.contexts).toBe(2);
    expect(g.shows).toHaveLength(1);
  });

  it('a soft problem still asks after the block lifts (the boot probes again from the top)', async () => {
    const b = fakeBrowser({ status: CHROMIUM_BLOCKED, liftAfter: 1, finePointer: false });
    const g = gate(b);
    await vi.advanceTimersByTimeAsync(10_000);
    await g.p;
    expect(g.shows).toEqual([{ ids: ['webgl2', 'pointer'], waiting: true }, { ids: ['pointer'], waiting: false }]);
    expect(g.done()!.webgl2).toBe(true);
  });

  it('never lifts: 15 quiet tries, gives up at 150 s, the screen stays and the boot never goes on', async () => {
    const b = fakeBrowser({ status: CHROMIUM_BLOCKED, liftAfter: Infinity });
    const g = gate(b);
    await vi.advanceTimersByTimeAsync(WEBGL_CRASH_BLOCK_WAIT_MS);
    expect(g.waits).toEqual([{ recovered: false, waitedMs: 150_000 }]);
    const attempts = b.s.webgl2Attempts;
    expect(attempts).toBe(1 + 15);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(b.s.webgl2Attempts).toBe(attempts);
    expect(g.done()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('any other WebGL cause: no quiet tries at all (the screen waits for Reload, as before)', async () => {
    const b = fakeBrowser({ status: 'disabled by enterprise policy or commandline switch', liftAfter: Infinity });
    const g = gate(b);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(g.shows).toEqual([{ ids: ['webgl2'], waiting: false }]);
    expect(b.s.webgl2Attempts).toBe(1);
    expect(g.waits).toEqual([]);
    expect(g.done()).toBeNull();
  });

  it('only the crash block, and only when nothing else hard is wrong, is waited out', () => {
    const base: CapabilityEnv = { webgl2: false, websocket: true, deviceMemoryGb: 8, finePointer: true,
      webgl2Failure: { cause: 'context_lost_after_crash', status: CHROMIUM_BLOCKED } };
    expect(crashBlockWaitable(base, capabilityProblems(base))).toBe(true);
    const noWs = { ...base, websocket: false };
    expect(crashBlockWaitable(noWs, capabilityProblems(noWs))).toBe(false);
    for (const cause of ['blocklisted', 'gpu_process_unavailable', 'unknown', 'acceleration_disabled'] as const) {
      const e = { ...base, webgl2Failure: { cause, status: null } };
      expect(crashBlockWaitable(e, capabilityProblems(e))).toBe(false);
    }
  });

  it('waitForWebGl2: a probe that throws counts as a failed try', async () => {
    let n = 0;
    const p = waitForWebGl2(() => { n++; if (n < 3) throw new Error('lost'); return true; }, timers);
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(p).resolves.toEqual({ recovered: true, waitedMs: 30_000 });
  });

  it('canCreateWebGl2 releases the context it made and makes nothing else', () => {
    const b = fakeBrowser({ status: CHROMIUM_BLOCKED, liftAfter: 0 });
    expect(canCreateWebGl2(() => b.win.document.createElement('canvas') as never)).toBe(true);
    expect(b.s).toEqual({ webgl2Attempts: 1, contexts: 1, released: 1 });
    const blocked = fakeBrowser({ status: CHROMIUM_BLOCKED, liftAfter: Infinity });
    expect(canCreateWebGl2(() => blocked.win.document.createElement('canvas') as never)).toBe(false);
    expect(blocked.s).toEqual({ webgl2Attempts: 1, contexts: 0, released: 0 });
  });
});

describe('BUG.webgl-crash-block-wait — the real screen', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let domWindow: any;
  const saved: Record<string, unknown> = {};
  const DOM_GLOBALS = ['window', 'document', 'HTMLElement', 'Node'] as const;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let showCapabilityScreen: any;
  beforeAll(async () => {
    domWindow = await loadDomWindow({ innerWidth: 1280, innerHeight: 720 });
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
    ({ showCapabilityScreen } = await import('../packages/renderer/src/boot/Capability.js'));
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));
  afterEach(() => { domWindow.document.body.innerHTML = ''; });

  const env: CapabilityEnv = { webgl2: false, websocket: true, deviceMemoryGb: 8, finePointer: true,
    webgl2Failure: { cause: 'context_lost_after_crash', status: CHROMIUM_BLOCKED },
    platform: { os: 'windows', browser: 'chrome' } };

  it('shows the two-minute text with Reload, and closes and resolves when the wait recovers', async () => {
    const doc = domWindow.document as Document;
    let recover!: (ok: boolean) => void;
    let resolved = false;
    const p = showCapabilityScreen(doc, capabilityProblems(env), () => {}, new Promise<boolean>(r => { recover = r; }))
      .then(() => { resolved = true; });
    const screen = doc.getElementById('capability-screen')!;
    expect(screen.textContent).toContain('turns graphics off for this site for up to two minutes');
    expect(screen.textContent).not.toMatch(/quit the browser/);
    expect(doc.querySelector('.capability-reload')).not.toBeNull();
    recover(true);
    await p;
    expect(resolved).toBe(true);
    expect(doc.getElementById('capability-screen')).toBeNull();
  });

  it('a wait that gave up leaves the screen as it is', async () => {
    const doc = domWindow.document as Document;
    let resolved = false;
    void showCapabilityScreen(doc, capabilityProblems(env), () => {}, Promise.resolve(false)).then(() => { resolved = true; });
    await new Promise(r => setTimeout(r, 0));
    expect(resolved).toBe(false);
    expect(doc.getElementById('capability-screen')).not.toBeNull();
  });
});

describe('BUG.webgl-crash-block-wait — webgl_wait telemetry', () => {
  it('recovered / gave_up with heldMs, kept by the bridge', () => {
    const sent: PreworldEvent[] = [];
    const r = new PreworldReporter({
      endpoint: 'https://bridge.example/client-preworld', build: 'abc1234', era: () => 'eor', server: () => null,
      screen: () => 'boot', now: () => 1000, trace: 'feedc0de12345678',
      send: (_url, raw) => sent.push(JSON.parse(raw) as PreworldEvent),
    });
    r.bootStage('capability_prompt');
    r.webglWait('recovered', 40_000.4);
    r.webglWait('gave_up', 150_000);
    expect(PREWORLD_OUTCOMES).toContain('webgl_wait');
    expect(sent[0]).toMatchObject({ outcome: 'webgl_wait', token: 'recovered', heldMs: 40_000, stage: 'capability_prompt' });
    expect(sanitizeClientPreworld(sent[0])).toMatchObject({ outcome: 'webgl_wait', token: 'recovered', heldMs: 40_000 });
    expect(sanitizeClientPreworld(sent[1])).toMatchObject({ outcome: 'webgl_wait', token: 'gave_up', heldMs: 150_000 });
  });
});
