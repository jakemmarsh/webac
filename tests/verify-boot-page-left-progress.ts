/**
 * OBS.boot-page-left-progress — production 2026-11-25 19:13:38Z (EoR, build 219e3ba522db,
 * trace 333da82d74429f6b): `page_left screen=boot stage=patch_download pageMs=25269` and
 * nothing else (no boot_slow, no page_hidden, no progress: the meter's Begin never came).
 * A prerender's slow clock waits for activation, so a prerender discarded unopened looks
 * exactly like that. Boot-screen page_left / page_hidden / boot_slow / boot_failed now say
 * how long the page was ever on screen (shownMs) and whether it started as a prerender
 * (prerendered): a discarded prerender, a tab opened in the background and a visitor who
 * watched and gave up read apart.
 *
 * Drives the real PreworldReporter through its real install() (pagehide, visibilitychange,
 * prerenderingchange, the 1 s tick) and runs its payloads through the bridge's real sanitizer.
 */
import { describe, it, expect } from 'vitest';
import { PreworldReporter, BOOT_SLOW_MS, SHOWN_OUTCOMES, type PreworldEvent, type PreworldScreen } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld, SHOWN_OUTCOMES as BRIDGE_SHOWN_OUTCOMES } from '../services/ws-tcp-bridge/src/clientPreworld.js';

function harness(start: { prerendering: boolean; hidden: boolean }) {
  const sent: PreworldEvent[] = [];
  const clock = { t: 5000 };
  const vis = { ...start };
  const state: { screen: PreworldScreen } = { screen: 'boot' };
  const r = new PreworldReporter({
    endpoint: 'https://bridge.example/client-preworld', build: 'abc1234', era: () => 'eor', server: () => null,
    screen: () => state.screen, now: () => clock.t, trace: 'feedc0de12345678',
    prerendering: () => vis.prerendering, hidden: () => vis.hidden,
    send: (_url, raw) => sent.push(JSON.parse(raw) as PreworldEvent),
  });
  const winL = new Map<string, () => void>();
  const docL = new Map<string, () => void>();
  const ticks: Array<() => void> = [];
  const doc = { get visibilityState() { return vis.hidden ? 'hidden' : 'visible'; }, addEventListener: (t: string, l: () => void) => { docL.set(t, l); } };
  r.install({ addEventListener: (t: string, l: () => void) => { winL.set(t, l); }, setInterval: (f: () => void) => { ticks.push(f); return 1; } } as never, doc as never);
  /** Advance the clock one second at a time, running the reporter's interval like the browser. */
  const advance = (ms: number) => { for (let i = 0; i < ms; i += 1000) { clock.t += Math.min(1000, ms - i); ticks.forEach(f => f()); } };
  /** Change visibility the way the browser does: the state, then its events. */
  const show = () => {
    const wasPrerender = vis.prerendering;
    vis.prerendering = false; vis.hidden = false;
    if (wasPrerender) docL.get('prerenderingchange')!();
    docL.get('visibilitychange')!();
  };
  const hide = () => { vis.hidden = true; docL.get('visibilitychange')!(); };
  return { r, sent, clock, state, winL, advance, show, hide };
}

describe('OBS.boot-page-left-progress: was the boot ever on screen', () => {
  it('the production shape: a prerender discarded unopened sends page_left with shownMs 0 and prerendered, and no boot_slow', () => {
    const h = harness({ prerendering: true, hidden: true });
    h.r.bootStage('patch_download');
    h.advance(25_000);
    h.winL.get('pagehide')!();
    expect(h.sent.map(e => e.outcome)).toEqual(['page_left']);
    expect(h.sent[0]).toMatchObject({ screen: 'boot', stage: 'patch_download', pageMs: 25_000, progress: null, shownMs: 0, prerendered: true });
    // The bridge keeps both as sent.
    expect(sanitizeClientPreworld(h.sent[0])).toMatchObject({ shownMs: 0, prerendered: true });
  });

  it('a prerender opened at 10 s: boot_slow 20 s after activation, page_left counts only the time shown', () => {
    const h = harness({ prerendering: true, hidden: true });
    h.r.bootStage('patch_download');
    h.advance(10_000);
    h.show();
    h.advance(BOOT_SLOW_MS);
    expect(h.sent.find(e => e.outcome === 'boot_slow')).toMatchObject({ pageMs: 10_000 + BOOT_SLOW_MS, shownMs: BOOT_SLOW_MS, prerendered: true });
    h.advance(5_000);
    h.winL.get('pagehide')!();
    expect(h.sent.find(e => e.outcome === 'page_left')).toMatchObject({ pageMs: 35_000, shownMs: 25_000, prerendered: true });
  });

  it('a tab opened in the background: its boot_slow says shownMs 0 (not a slow visitor) and carries no prerendered', () => {
    const h = harness({ prerendering: false, hidden: true });
    h.r.bootStage('patch_download');
    h.advance(BOOT_SLOW_MS);
    const slow = h.sent.find(e => e.outcome === 'boot_slow')!;
    expect(slow.shownMs).toBe(0);
    expect(slow).not.toHaveProperty('prerendered');
    // Brought forward for 4 s, then hidden again: page_hidden and page_left count those 4 s only.
    h.show();
    h.advance(4_000);
    h.hide();
    h.advance(3_000);
    expect(h.sent.find(e => e.outcome === 'page_hidden')).toMatchObject({ shownMs: 4_000 });
    h.winL.get('pagehide')!();
    expect(h.sent.find(e => e.outcome === 'page_left')).toMatchObject({ pageMs: 27_000, shownMs: 4_000 });
  });

  it('inverse: a visitor who watched the boot and gave up keeps a full shownMs, its progress and its boot_slow', () => {
    const h = harness({ prerendering: false, hidden: false });
    h.r.bootStage('patch_download');
    h.r.bootPatchEvent({ kind: 'begin', expected: 100 * 1024 * 1024 });
    h.r.bootPatchEvent({ kind: 'downloaded', bytes: 20 * 1024 * 1024 });
    h.advance(25_000);
    h.winL.get('pagehide')!();
    expect(h.sent.map(e => e.outcome)).toEqual(['boot_slow', 'page_left']);
    expect(h.sent[0]).toMatchObject({ pageMs: BOOT_SLOW_MS, shownMs: BOOT_SLOW_MS });
    expect(h.sent[1]).toMatchObject({ pageMs: 25_000, shownMs: 25_000, doneKB: 20 * 1024, totalKB: 100 * 1024, progress: 20 });
    expect(h.sent[1]).not.toHaveProperty('prerendered');
  });

  it('only boot-screen page_left / page_hidden / boot_slow / boot_failed carry it', () => {
    expect([...SHOWN_OUTCOMES].sort()).toEqual([...BRIDGE_SHOWN_OUTCOMES].sort());
    const h = harness({ prerendering: false, hidden: false });
    h.r.bootFailed('TypeError');
    expect(h.sent[0]).toMatchObject({ outcome: 'boot_failed', shownMs: 0 });
    h.state.screen = 'char-select';
    h.r.characterList(1);
    h.state.screen = 'chargen';
    h.advance(2_000);
    h.winL.get('pagehide')!();
    expect(h.sent.map(e => e.outcome)).toEqual(['boot_failed', 'char_list', 'page_left']);
    for (const e of h.sent.slice(1)) {
      expect(e).not.toHaveProperty('shownMs');
      expect(e).not.toHaveProperty('prerendered');
    }
  });

  it('bridge: kept on those outcomes from the boot screen only, bounded, prerendered exactly true; an old page is unchanged', () => {
    const base = { outcome: 'page_left', screen: 'boot', trace: 'feedc0de12345678' };
    expect(sanitizeClientPreworld({ ...base, shownMs: 1234, prerendered: true })).toMatchObject({ shownMs: 1234, prerendered: true });
    const bad = sanitizeClientPreworld({ ...base, shownMs: -1, prerendered: 'yes' })!;
    expect(bad).not.toHaveProperty('shownMs');
    expect(bad).not.toHaveProperty('prerendered');
    expect(sanitizeClientPreworld({ ...base, shownMs: 1.5 })).not.toHaveProperty('shownMs');
    expect(sanitizeClientPreworld({ ...base, screen: 'chargen', shownMs: 5, prerendered: true })).not.toHaveProperty('shownMs');
    expect(sanitizeClientPreworld({ ...base, outcome: 'char_list', shownMs: 5 })).not.toHaveProperty('shownMs');
    for (const outcome of ['page_hidden', 'boot_slow', 'boot_failed']) expect(sanitizeClientPreworld({ ...base, outcome, shownMs: 7 })).toMatchObject({ shownMs: 7 });
    expect(sanitizeClientPreworld(base)).not.toHaveProperty('shownMs');
  });
});
