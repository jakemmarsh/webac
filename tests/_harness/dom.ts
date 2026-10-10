/**
 * Shared happy-dom harness for DOM-driving tests (DEBT.test-harness-hygiene).
 *
 * ~215 test files used to copy a bootstrap that dynamic-imported happy-dom in
 * a try/catch and gated their suites on `describe.skipIf(!domWindow)`. If the
 * import ever broke (a dependency bump, a lockfile slip, a CI cache miss) every
 * one of those suites silently SKIPPED and CI stayed green. happy-dom is a
 * devDependency — it is always installed wherever the suite runs — so a load
 * failure here is a broken environment and must fail loudly, never skip.
 *
 * This directory is excluded from vitest's test globs (vitest.config.ts), so
 * helpers here are imported by tests, never collected as tests themselves.
 */

// The package name is assembled at runtime so Vite's import analysis doesn't
// try to pre-bundle happy-dom for browser builds that never load it (the
// reason every copied bootstrap spelled it `['happy', 'dom'].join('-')`).
const HAPPY_DOM_PKG = ['happy', 'dom'].join('-');

export interface DomWindowSize {
  innerWidth: number;
  innerHeight: number;
}

/**
 * Import happy-dom and construct a Window. THROWS if happy-dom cannot load —
 * callers must not catch this: a missing DOM is a broken test environment,
 * not a reason to skip.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function loadDomWindow(size: DomWindowSize = { innerWidth: 1024, innerHeight: 768 }): Promise<any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;
  try {
    mod = await import(/* @vite-ignore */ HAPPY_DOM_PKG);
  } catch (err) {
    throw new Error(
      `tests/_harness/dom.ts: failed to import ${HAPPY_DOM_PKG} (a devDependency — run \`npm install\`). `
      + 'DOM suites fail instead of skipping so a broken environment can never pass CI silently.',
      { cause: err },
    );
  }
  if (typeof mod?.Window !== 'function') {
    throw new Error(`tests/_harness/dom.ts: ${HAPPY_DOM_PKG} loaded but exports no Window constructor`);
  }
  return new mod.Window(size);
}

/**
 * How window members are copied onto globalThis:
 *  - 'none'           — copied as-is (the common case).
 *  - 'functions'      — every function member is bound to the window (so
 *                       happy-dom methods such as requestAnimationFrame keep
 *                       their `this` when called bare).
 *  - 'animationFrame' — only keys ending in `AnimationFrame` are bound.
 * `window` itself is always the window object.
 */
export type DomGlobalBind = 'none' | 'functions' | 'animationFrame';

/**
 * Swap `keys` from `win` onto globalThis, recording the previous values in
 * `saved` so {@link restoreDomGlobals} can undo it.
 */
export function installDomGlobals(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  win: any,
  keys: readonly string[],
  saved: Record<string, unknown>,
  bind: DomGlobalBind = 'none',
): void {
  const g = globalThis as Record<string, unknown>;
  for (const key of keys) {
    saved[key] = g[key];
    if (key === 'window') { g[key] = win; continue; }
    const value = win[key];
    const shouldBind = typeof value === 'function'
      && (bind === 'functions' || (bind === 'animationFrame' && key.endsWith('AnimationFrame')));
    g[key] = shouldBind ? value.bind(win) : value;
  }
}

/**
 * Undo {@link installDomGlobals}: keys that were absent before are deleted,
 * the rest get their saved value back.
 */
export function restoreDomGlobals(keys: readonly string[], saved: Record<string, unknown>): void {
  const g = globalThis as Record<string, unknown>;
  for (const key of keys) {
    if (saved[key] === undefined) delete g[key];
    else g[key] = saved[key];
  }
}
