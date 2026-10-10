/**
 * RELEASE.remove-test-defaults — the `window.__*` debug hooks (`__ac`,
 * `__playerState`, `__aceConnection`, `__castSpell`, …) exist only where the
 * tooling that reads them runs: the Vite dev server and pages with `?debug`
 * (the same gate as acDebug, utils/debugTools.ts). A production page without
 * `?debug` exposes none of them.
 *
 * `exposeDebugGlobal(name, value)` sets one; `debugBag()` is the `window.__ac`
 * scratch object (a detached object when the gate is off, so callers can
 * write telemetry fields unconditionally).
 */
import { debugToolsEnabled } from './debugTools.js';

type GlobalTarget = Record<string, unknown>;

function defaultTarget(): GlobalTarget | null {
  return typeof window !== 'undefined' ? (window as unknown as GlobalTarget) : null;
}

function defaultEnabled(): boolean {
  const search = typeof location !== 'undefined' ? location.search : '';
  return debugToolsEnabled(import.meta.env?.DEV === true, search);
}

let enabledOverride: boolean | null = null;

/** Whether debug globals are exposed on this page. */
export function debugGlobalsEnabled(): boolean {
  return enabledOverride ?? defaultEnabled();
}

/** Tests: force the gate (null restores the real one). */
export function setDebugGlobalsEnabledForTest(v: boolean | null): void {
  enabledOverride = v;
}

/** `window[name] = value` when the gate is on; returns whether it was set. */
export function exposeDebugGlobal(name: string, value: unknown, target: GlobalTarget | null = defaultTarget()): boolean {
  if (!target || !debugGlobalsEnabled()) return false;
  target[name] = value;
  return true;
}

/** Read a debug global (undefined when the gate is off or it was never set). */
export function readDebugGlobal<T = unknown>(name: string, target: GlobalTarget | null = defaultTarget()): T | undefined {
  if (!target || !debugGlobalsEnabled()) return undefined;
  return target[name] as T | undefined;
}

const detachedBag: Record<string, unknown> = {};

/** The `window.__ac` object (created on demand); a detached object when the gate is off. */
export function debugBag(target: GlobalTarget | null = defaultTarget()): Record<string, unknown> {
  if (!target || !debugGlobalsEnabled()) return detachedBag;
  const cur = target.__ac;
  if (cur && typeof cur === 'object') return cur as Record<string, unknown>;
  const bag: Record<string, unknown> = {};
  target.__ac = bag;
  return bag;
}
