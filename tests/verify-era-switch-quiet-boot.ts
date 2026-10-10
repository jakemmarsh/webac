import { describe, it, expect } from 'vitest';
import {
  patchBootPlan, QuietPatchProgress, QUIET_PATCH_REVEAL_MS, PatchStatus, patchProgressText,
} from '../packages/renderer/src/ui/PatchScreen.js';
import { stashEraSwitch, takeEraSwitch, resolveBootEra, ERA_SWITCH_MAX_AGE_MS, type EraSwitch } from '../packages/renderer/src/era/EraBoot.js';

// ERA.switch-no-splash (Jake, playwebac.com 2026-10-06): "why did logging into
// the ac1999 server first return to the connecting/patching splash page?"
// An era-switch reload resumes the ENTER; it must not put gmDataPatchUI back up.

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem' | 'removeItem'> & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
  };
}

const sw = (at: number): EraSwitch => ({
  era: 'ac1999-retail', worldKey: 'k', worldName: 'AC1999 Test', connectUrl: 'ws://x', account: 'a', password: 'p', at,
});

describe('patch boot plan', () => {
  it('a normal whole-DAT boot draws the splash from the ranged read, gated on the connect meter (unchanged)', () => {
    expect(patchBootPlan({ resumingEraSwitch: false, streamedInterface: false })).toEqual({
      splash: true, rangedSplash: true, waitForRangedSplash: true, gatePatchOnConnect: true, quietProgress: false,
    });
  });

  it('a normal streamed boot draws the splash from the boot pack (no ranged read; unchanged)', () => {
    expect(patchBootPlan({ resumingEraSwitch: false, streamedInterface: true })).toEqual({
      splash: true, rangedSplash: false, waitForRangedSplash: false, gatePatchOnConnect: true, quietProgress: false,
    });
  });

  it('resuming an era switch creates no patch screen, streamed or whole', () => {
    for (const streamedInterface of [true, false]) {
      const plan = patchBootPlan({ resumingEraSwitch: true, streamedInterface });
      expect(plan.splash).toBe(false);
      expect(plan.rangedSplash).toBe(false);
      expect(plan.waitForRangedSplash).toBe(false);
      expect(plan.gatePatchOnConnect).toBe(false);
      expect(plan.quietProgress).toBe(true);
    }
  });

  it('the boot decision follows the stashed switch: present → quiet, absent or stale → splash', () => {
    const now = 1_000_000;
    const s = memoryStorage();
    stashEraSwitch(sw(now - 5000), s);
    const pending = takeEraSwitch(s, now);
    expect(pending).not.toBeNull();
    expect(resolveBootEra({ search: '', pending }).id).toBe('ac1999-retail');
    expect(patchBootPlan({ resumingEraSwitch: !!pending, streamedInterface: true }).splash).toBe(false);
    // Taken once: the password is gone from sessionStorage, a second reload is a normal boot.
    expect(s.map.size).toBe(0);
    expect(patchBootPlan({ resumingEraSwitch: !!takeEraSwitch(s, now), streamedInterface: true }).splash).toBe(true);
    // A stale stash (over two minutes) is ignored: the normal splash.
    stashEraSwitch(sw(now - ERA_SWITCH_MAX_AGE_MS - 1), s);
    expect(patchBootPlan({ resumingEraSwitch: !!takeEraSwitch(s, now), streamedInterface: true }).splash).toBe(true);
  });
});

describe('quiet era-switch progress line', () => {
  it('a cache-served boot never shows it', () => {
    const q = new QuietPatchProgress(0);
    q.onEvent({ kind: 'interrogation' });
    expect(q.text(QUIET_PATCH_REVEAL_MS + 5000)).toBeNull();
    q.onEvent({ kind: 'end' });
    expect(q.text(QUIET_PATCH_REVEAL_MS + 5000)).toBeNull();
  });

  it('a short download stays black; one that outlasts the reveal delay shows the patch progress text', () => {
    const q = new QuietPatchProgress(0);
    q.onEvent({ kind: 'interrogation' });
    q.onEvent({ kind: 'begin', expected: 4 * 1024 * 1024 });
    q.onEvent({ kind: 'downloaded', bytes: 1024 * 1024 });
    expect(q.text(QUIET_PATCH_REVEAL_MS - 1)).toBeNull();
    const ref = new PatchStatus();
    ref.onEvent({ kind: 'begin', expected: 4 * 1024 * 1024 });
    ref.onEvent({ kind: 'downloaded', bytes: 1024 * 1024 });
    expect(q.text(QUIET_PATCH_REVEAL_MS)).toBe(patchProgressText(0.25, 4 * 1024 * 1024));
    expect(q.text(QUIET_PATCH_REVEAL_MS)).toBe(ref.label.text);
  });

  it('progress events reach it without waiting for the bridge (no connect gate)', () => {
    const q = new QuietPatchProgress(0);
    q.onEvent({ kind: 'begin', expected: 1000 });
    expect(q.text(5000)).not.toBeNull();
  });

  it('hides once the download completes or the patch ends', () => {
    const q = new QuietPatchProgress(0);
    q.onEvent({ kind: 'begin', expected: 1000 });
    q.onEvent({ kind: 'downloaded', bytes: 1000 });
    expect(q.text(5000)).toBeNull();
    const r = new QuietPatchProgress(0);
    r.onEvent({ kind: 'begin', expected: 1000 });
    r.onEvent({ kind: 'end' });
    expect(r.text(5000)).toBeNull();
  });
});
