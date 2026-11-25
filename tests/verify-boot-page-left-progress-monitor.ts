/**
 * OBS.boot-page-left-progress — tools/monitor/launch-filter.sh drops a boot page_left from
 * a prerender nobody ever opened (prerendered=true shownMs=0; production trace
 * 333da82d74429f6b, 2026-11-25), and keeps every boot page_left from a page that was shown,
 * or that was hidden from the start without being a prerender. Real reporter bodies, the
 * bridge's real sanitizer and log line, rendered as tools/aws-logs.sh does, piped through
 * the real filter.
 *
 * Kept apart from verify-boot-page-left-progress.ts: tools/monitor is private, so the public
 * export drops a test that runs it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld.js';
import { formatLogLine } from '../services/ws-tcp-bridge/src/log.js';

const FILTER = path.join(__dirname, '..', 'tools', 'monitor', 'launch-filter.sh');

/** tools/aws-logs.sh's rendering: `<ts> [LEVEL]  key=<json value> …`, level dropped. */
function renderLikeAwsLogs(jsonLine: string): string {
  const obj = JSON.parse(jsonLine) as Record<string, unknown>;
  const val = (v: unknown) => (typeof v === 'boolean' ? String(v) : v === null ? 'null' : JSON.stringify(v));
  return `2026-11-25T19:13:38.000Z [${String(obj.level).toUpperCase()}]  ${Object.entries(obj).filter(([k]) => k !== 'level').map(([k, v]) => `${k}=${val(v)}`).join(' ')}`;
}

/** A boot page_left after `leftAtMs`, from a page that started prerendering / hidden and was shown at `shownAt` (null: never). */
function bootPageLeft(start: { prerendering: boolean; hidden: boolean }, shownAt: number | null, leftAtMs: number): string {
  const clock = { t: 0 };
  const vis = { ...start };
  const sent: PreworldEvent[] = [];
  const r = new PreworldReporter({
    endpoint: 'https://bridge.example/client-preworld', build: '219e3ba522db', era: () => 'eor', server: () => 'coldeve',
    screen: () => 'boot', now: () => clock.t, trace: '333da82d74429f6b',
    prerendering: () => vis.prerendering, hidden: () => vis.hidden,
    send: (_u, raw) => { sent.push(JSON.parse(raw) as PreworldEvent); },
  });
  r.bootStage('patch_download');
  for (clock.t = 1000; clock.t <= leftAtMs; clock.t += 1000) {
    if (shownAt !== null && clock.t >= shownAt) { vis.prerendering = false; vis.hidden = false; }
    r.tick();
  }
  clock.t = leftAtMs;
  r.pageLeft();
  const ev = sanitizeClientPreworld(sent.find(e => e.outcome === 'page_left'))!;
  const fields = Object.fromEntries(Object.entries(ev).filter(([, v]) => v !== null));
  return renderLikeAwsLogs(formatLogLine('info', 'client_preworld', { ip: '198.51.100.7', ...fields }, new Date('2026-11-25T19:13:38Z')));
}

function filter(lines: string[]): string {
  return execFileSync('bash', [FILTER], { input: `${lines.join('\n')}\n`, env: { ...process.env, MONITOR_OWN_IPS: '192\\.0\\.2\\.1' } }).toString();
}

describe('launch-filter.sh: a boot page_left from a page nobody saw', () => {
  it('drops a discarded prerender (prerendered=true shownMs=0)', () => {
    const line = bootPageLeft({ prerendering: true, hidden: true }, null, 25_269);
    expect(line).toMatch(/shownMs=0 prerendered=true/);
    expect(filter([line]).trim()).toBe('');
  });

  it('keeps a prerender that was opened, a background tab that was never a prerender, and a visitor who watched', () => {
    const opened = bootPageLeft({ prerendering: true, hidden: true }, 5_000, 40_000);
    const background = bootPageLeft({ prerendering: false, hidden: true }, null, 40_000);
    const visitor = bootPageLeft({ prerendering: false, hidden: false }, 0, 40_000);
    expect(opened).toMatch(/shownMs=35000 prerendered=true/);
    expect(background).toMatch(/shownMs=0/);
    expect(visitor).toMatch(/shownMs=40000/);
    const out = filter([opened, background, visitor]);
    expect(out.match(/outcome="page_left"/g)).toHaveLength(3);
  });
});

describe('launch-filter.sh: a boot_slow from a page hidden for most of it', () => {
  // Shape of trace b24816dccd0a24a7 (2026-11-25 20:03Z), address replaced.
  const slow = (pageMs: number, hiddenMs: number) =>
    `2026-11-25T20:03:41.988Z [INFO]  t="2026-11-25T20:03:41.988Z" event="client_preworld" ip="198.51.100.7" outcome="boot_slow" era="eor" trace="b24816dccd0a24a7" build="40de721fae69" screen="boot" pageMs=${pageMs} screenMs=17265 stage="side_tables" progress=100 doneKB=6538 totalKB=6538 cache="partial" stream=[{"scope":"all","ms":18795,"worldCacheMs":0,"phases":{"manifestMs":15614,"hiddenMs":${hiddenMs}}}]`;
  it('drops one with under 15 s of the page visible', () => {
    expect(filter([slow(20_856, 18_795)]).trim()).toBe('');
  });
  it('keeps one whose page was visible for longer', () => {
    expect(filter([slow(40_000, 18_795)])).toMatch(/boot_slow/);
    expect(filter([slow(20_856, 0)])).toMatch(/boot_slow/);
  });
});
