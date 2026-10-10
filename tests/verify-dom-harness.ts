/**
 * DEBT.test-harness-hygiene — the shared happy-dom harness (tests/_harness/dom.ts).
 *
 * ~215 DOM suites used to copy a try/catch bootstrap and gate on
 * `describe.skipIf(!domWindow)`, so a broken happy-dom import silently skipped
 * them all while CI stayed green. They now load the window through
 * loadDomWindow, which throws; these tests pin that contract and the
 * install/restore semantics the copies implemented inline.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

describe('tests/_harness/dom.ts — loadDomWindow', () => {
  it('returns a live happy-dom Window of the requested size', async () => {
    const win = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
    expect(win.innerWidth).toBe(1568);
    expect(win.innerHeight).toBe(775);
    const el = win.document.createElement('div');
    win.document.body.appendChild(el);
    expect(win.document.body.contains(el)).toBe(true);
  });

  it('defaults to 1024x768', async () => {
    const win = await loadDomWindow();
    expect([win.innerWidth, win.innerHeight]).toEqual([1024, 768]);
  });

  it('happy-dom is a declared devDependency, so a load failure is an environment bug (never a skip)', async () => {
    const pkg = JSON.parse(
      (await import('node:fs')).readFileSync(new URL('../package.json', import.meta.url), 'utf-8'),
    ) as { devDependencies?: Record<string, string> };
    expect(pkg.devDependencies?.['happy-dom']).toBeTruthy();
  });
});

describe('tests/_harness/dom.ts — installDomGlobals / restoreDomGlobals', () => {
  const g = globalThis as Record<string, unknown>;
  const KEYS = ['__harnessProbeA', '__harnessProbeB', 'window'] as const;
  afterEach(() => { delete g.__harnessProbeA; delete g.__harnessProbeB; });

  it('copies members onto globalThis and restores prior values / deletes new keys', () => {
    const priorWindow = g.window;
    g.__harnessProbeA = 'before';
    const fake = { __harnessProbeA: 'a', __harnessProbeB: 'b' };
    const saved: Record<string, unknown> = {};
    installDomGlobals(fake, KEYS, saved);
    expect(g.__harnessProbeA).toBe('a');
    expect(g.__harnessProbeB).toBe('b');
    expect(g.window).toBe(fake);
    restoreDomGlobals(KEYS, saved);
    expect(g.__harnessProbeA).toBe('before');
    expect('__harnessProbeB' in g).toBe(false);
    expect(g.window).toBe(priorWindow);
  });

  it("'none' copies functions unbound; 'functions' binds every function to the window", () => {
    const fake = { tag: 'win', __harnessProbeA(this: { tag?: string } | undefined) { return this?.tag; } };
    const saved: Record<string, unknown> = {};
    installDomGlobals(fake, ['__harnessProbeA'], saved);
    expect((g.__harnessProbeA as () => unknown)()).toBeUndefined();
    restoreDomGlobals(['__harnessProbeA'], saved);
    installDomGlobals(fake, ['__harnessProbeA'], saved, 'functions');
    expect((g.__harnessProbeA as () => unknown)()).toBe('win');
    restoreDomGlobals(['__harnessProbeA'], saved);
  });

  it("'animationFrame' binds only the *AnimationFrame members", () => {
    const g2 = globalThis as Record<string, unknown>;
    const fake = {
      tag: 'win',
      requestAnimationFrame(this: { tag?: string } | undefined) { return this?.tag; },
      __harnessProbeA(this: { tag?: string } | undefined) { return this?.tag; },
    };
    const keys = ['requestAnimationFrame', '__harnessProbeA'];
    const saved: Record<string, unknown> = {};
    installDomGlobals(fake, keys, saved, 'animationFrame');
    try {
      expect((g2.requestAnimationFrame as () => unknown)()).toBe('win');
      expect((g2.__harnessProbeA as () => unknown)()).toBeUndefined();
    } finally {
      restoreDomGlobals(keys, saved);
    }
  });
});
