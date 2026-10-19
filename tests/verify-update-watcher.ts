import { describe, it, expect } from 'vitest';
import {
  DEV_BUILD_ID, UpdateWatcher, VERSION_PATH, decideUpdateAction, reloadAtBreak, isUpdateAvailable, parseServedVersion, updateNoticeText, updateNoticeAsDialog,
} from '../packages/renderer/src/update/UpdateWatcher.js';

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

describe('update notifier', () => {
  it('parses /version.json and ignores malformed bodies', () => {
    expect(parseServedVersion({ build: 'abc123', urgent: true })).toEqual({ build: 'abc123', urgent: true });
    expect(parseServedVersion({ build: 'abc123' })).toEqual({ build: 'abc123', urgent: false });
    for (const bad of [null, 'x', {}, { build: '' }, { build: 7 }]) expect(parseServedVersion(bad)).toBeNull();
  });

  it('an update is a different served build; dev builds never update', () => {
    expect(isUpdateAvailable('a', { build: 'b', urgent: false })).toBe(true);
    expect(isUpdateAvailable('a', { build: 'a', urgent: false })).toBe(false);
    expect(isUpdateAvailable(DEV_BUILD_ID, { build: 'b', urgent: false })).toBe(false);
    expect(isUpdateAvailable('a', { build: DEV_BUILD_ID, urgent: false })).toBe(false);
    expect(isUpdateAvailable('a', null)).toBe(false);
  });

  it('reloads only at a natural break; notifies once in the world or at char select', () => {
    const pending = { build: 'b', urgent: false };
    expect(decideUpdateAction({ pending: null, screen: 'launcher', passwordTyped: false, alreadyNotified: false })).toEqual({ kind: 'none' });
    expect(decideUpdateAction({ pending, screen: 'launcher', passwordTyped: false, alreadyNotified: false })).toEqual({ kind: 'reload' });
    expect(decideUpdateAction({ pending, screen: 'launcher', passwordTyped: true, alreadyNotified: false })).toEqual({ kind: 'none' });
    // The Disconnected screen stays up so the player can read it; OK reloads (reloadAtBreak).
    expect(decideUpdateAction({ pending, screen: 'disconnected', passwordTyped: false, alreadyNotified: true })).toEqual({ kind: 'none' });
    expect(reloadAtBreak(pending)).toBe(true);
    expect(reloadAtBreak(null)).toBe(false);
    expect(decideUpdateAction({ pending, screen: 'world', passwordTyped: false, alreadyNotified: false })).toEqual({ kind: 'notify', urgent: false });
    expect(decideUpdateAction({ pending, screen: 'world', passwordTyped: false, alreadyNotified: true })).toEqual({ kind: 'none' });
    expect(decideUpdateAction({ pending: { build: 'b', urgent: true }, screen: 'char-select', passwordTyped: false, alreadyNotified: false })).toEqual({ kind: 'notify', urgent: true });
    expect(decideUpdateAction({ pending, screen: 'loading', passwordTyped: false, alreadyNotified: false })).toEqual({ kind: 'none' });
  });

  it('notice text', () => {
    expect(updateNoticeText(false)).toMatch(/next time you return to the world list/);
    expect(updateNoticeText(true)).toMatch(/log out/);
  });

  it('the notice is the OK dialog when urgent, and at character select (no chat window there)', () => {
    expect(updateNoticeAsDialog(true, 'world')).toBe(true);
    expect(updateNoticeAsDialog(false, 'world')).toBe(false);
    expect(updateNoticeAsDialog(false, 'char-select')).toBe(true);
    expect(updateNoticeAsDialog(true, 'char-select')).toBe(true);
  });

  it('UpdateWatcher fetches /version.json uncached, reports a new build once, and an urgent upgrade again', async () => {
    const seen: Array<[string, RequestInit | undefined]> = [];
    let body: unknown = { build: 'a' };
    const reported: Array<{ build: string; urgent: boolean }> = [];
    const w = new UpdateWatcher({
      currentBuild: 'a',
      fetchFn: async (u, init) => { seen.push([String(u), init]); return json(body); },
      onAvailable: (v) => reported.push(v),
    });
    expect(await w.check()).toBeNull();
    body = { build: 'b' };
    await w.check(); await w.check();
    body = { build: 'b', urgent: true };
    await w.check();
    expect(reported).toEqual([{ build: 'b', urgent: false }, { build: 'b', urgent: true }]);
    expect(seen[0]).toEqual([VERSION_PATH, { cache: 'no-store' }]);
    expect(w.pendingVersion).toEqual({ build: 'b', urgent: true });
  });

  it('network errors and 404s are quiet; dev builds never poll', async () => {
    const w = new UpdateWatcher({ currentBuild: 'a', fetchFn: async () => { throw new TypeError('offline'); }, onAvailable: () => { throw new Error('no'); } });
    expect(await w.check()).toBeNull();
    const w404 = new UpdateWatcher({ currentBuild: 'a', fetchFn: async () => json({}, 404), onAvailable: () => { throw new Error('no'); } });
    expect(await w404.check()).toBeNull();
    let started = 0;
    new UpdateWatcher({ currentBuild: DEV_BUILD_ID, onAvailable: () => {}, setIntervalFn: () => { started++; } }).start();
    expect(started).toBe(0);
  });
});
