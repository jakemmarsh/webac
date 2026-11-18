/**
 * OBS.client-error-identity — the monitor's launch filter still reads
 * client_error lines that now carry `trace` and `bid`: a real bridge line
 * (sanitizeClientError → formatLogLine), rendered as tools/aws-logs.sh does,
 * piped through the real tools/monitor/launch-filter.sh.
 *
 * Kept apart from verify-client-error-identity.ts: tools/monitor is private,
 * so the public export drops a test that runs it.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { sanitizeClientError } from '../services/ws-tcp-bridge/src/clientErrors.js';
import { sanitizeClientWorld } from '../services/ws-tcp-bridge/src/clientWorld.js';
import { WorldReporter, type WorldEvent } from '../packages/renderer/src/telemetry/WorldReporter.js';
import { formatLogLine } from '../services/ws-tcp-bridge/src/log.js';

const FILTER = path.join(__dirname, '..', 'tools', 'monitor', 'launch-filter.sh');

/** tools/aws-logs.sh's rendering: `<ts> [LEVEL]  key=<json value> …`, level dropped. */
function renderLikeAwsLogs(jsonLine: string): string {
  const obj = JSON.parse(jsonLine) as Record<string, unknown>;
  const val = (v: unknown) => (typeof v === 'boolean' ? String(v) : v === null ? 'null' : JSON.stringify(v));
  return `2026-11-17T00:00:00.000Z [${String(obj.level).toUpperCase()}]  ${Object.entries(obj).filter(([k]) => k !== 'level').map(([k, v]) => `${k}=${val(v)}`).join(' ')}`;
}

function bridgeLine(body: Record<string, unknown>): string {
  const report = sanitizeClientError({ trace: '9f8e7d6c5b4a3210', bid: '0a1b2c3d', build: 'b1', userAgent: 'Mozilla/5.0 Chrome/141', count: 1, ...body })!;
  return renderLikeAwsLogs(formatLogLine('warn', 'client_error', { ip: '198.51.100.7', ...report }, new Date('2026-11-17T00:00:00Z')));
}

function filter(lines: string[]): string {
  return execFileSync('bash', [FILTER], { input: `${lines.join('\n')}\n`, env: { ...process.env, MONITOR_OWN_IPS: '192\\.0\\.2\\.1' } }).toString();
}

describe('launch-filter.sh with trace / bid on client_error', () => {
  it('a real boot refusal still alerts, with its trace and bid on the line', () => {
    const out = filter([bridgeLine({ kind: 'boot', message: 'WebGL 2 unavailable', screen: 'boot', webglCause: 'no_webgl' })]);
    expect(out).toContain('event="client_error"');
    expect(out).toMatch(/trace="9f8e7d6c5b4a3210"/);
    expect(out).toMatch(/bid="0a1b2c3d"/);
  });

  it('the known-benign rules still drop theirs: an injected script (all <anonymous> frames), Mesa without a GPU process, a lost context', () => {
    const out = filter([
      bridgeLine({ kind: 'error', message: 'TypeError: x', stack: 'TypeError: x\n    at <anonymous>:1:20\n    at <anonymous>:3:7' }),
      bridgeLine({ kind: 'boot', message: 'WebGL 2 unavailable', webglCause: 'gpu_process_unavailable', webglStatus: 'GL_VENDOR Google Inc. (Mesa) GL_RENDERER llvmpipe' }),
      bridgeLine({ kind: 'webglcontextlost', message: 'WebGL context lost', screen: 'world' }),
    ]);
    expect(out.trim()).toBe('');
  });
});

/** A real client_world line: the page's WorldReporter event, through the bridge's sanitizer and log format (nulls dropped, as server.ts). */
function worldLine(ev: WorldEvent): string {
  const w = sanitizeClientWorld(ev)!;
  const fields = Object.fromEntries(Object.entries(w).filter(([, v]) => v !== null));
  return renderLikeAwsLogs(formatLogLine('info', 'client_world', { ip: '198.51.100.7', ...fields }, new Date('2026-11-17T00:00:00Z')));
}

/** One world session with a context loss (restored after `restoreAfterMs`, or never), ended by `end` at `endAt` ms. */
function lossSession(restoreAfterMs: number | null, end: 'logout' | 'closed_tab', endAt: number): WorldEvent[] {
  const events: WorldEvent[] = [];
  const clock = { t: 1000 };
  let errors = 0;
  const r = new WorldReporter({
    endpoint: 'http://x/client-preworld', build: 'b1', trace: '9f8e7d6c5b4a3210', era: () => 'dm', server: () => 'seedsow',
    now: () => clock.t, send: (_u, b) => { events.push(JSON.parse(b) as WorldEvent); },
  });
  r.setSources({ screen: () => 'world', errors: () => errors });
  r.enteredWorld();
  for (let t = 0; t < endAt; t += 16) {
    clock.t += 16;
    r.frame(clock.t, true);
    if (t === 4000) { r.contextLostNow(); errors = 1; } // the loss's own client_error is the session's one error
    if (restoreAfterMs !== null && t === 4000 + restoreAfterMs) r.contextRestoredNow();
    if (clock.t % 1000 < 16) r.tick();
  }
  r.left(end);
  return events;
}

describe('launch-filter.sh and TELEMETRY.context-restore', () => {
  it('a restored loss in a long session that ended cleanly is still dropped', () => {
    const evs = lossSession(800, 'logout', 70_000);
    expect(evs.map((e) => e.outcome)).toEqual(['first_minute', 'world_left']);
    expect(filter([worldLine(evs[1])]).trim()).toBe('');
  });

  it('an unrestored loss alerts, on world_left and on first_minute (the 2026-11-18 black screen)', () => {
    const long = lossSession(null, 'closed_tab', 70_000);
    const left = filter([worldLine(long[1])]);
    expect(left).toContain('outcome="world_left"');
    expect(left).toContain('contextRestored=false');
    const short = lossSession(null, 'closed_tab', 24_000);
    expect(short[0]).toMatchObject({ outcome: 'first_minute', contextRestored: false });
    const minute = filter([worldLine(short[0])]);
    expect(minute).toContain('outcome="first_minute"');
    expect(minute).toMatch(/contextRestored=false .*lostForMs=1\d{4}/);
  });

  it('an unrestored loss alerts even when no error was counted (exit still_in, errors=0)', () => {
    const ev = { ...lossSession(null, 'closed_tab', 70_000)[0], errors: 0 };
    expect(ev).toMatchObject({ outcome: 'first_minute', exit: 'still_in' });
    expect(filter([worldLine(ev)])).toContain('contextRestored=false');
    // The same minute with no loss is dropped as before.
    expect(filter([worldLine({ ...ev, contextLost: false, contextRestored: null, contextLossCount: 0, lostForMs: null } as WorldEvent)]).trim()).toBe('');
  });
});
