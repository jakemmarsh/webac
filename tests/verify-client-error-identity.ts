/**
 * OBS.client-error-identity — client_error reports carry the page's `trace`
 * and the browser's `bid`, the ids the pre-world reports already use, so a
 * crash or a boot refusal (kind="boot" webglCause=…) joins that page's other
 * lines and a later page of the same browser (its char_list carries bid).
 *
 * Drives the real ErrorReporter (the sent payload), the real bridge
 * (POST /client-errors → its client_error log fields → formatLogLine), and
 * the web-origin report (WebReport.ts + the report Worker).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ErrorReporter } from '../packages/renderer/src/telemetry/ErrorReporter.js';
import { PreworldReporter } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { browserId } from '../packages/renderer/src/telemetry/LoginTags.js';
import { buildWebReport, launcherConnectFailedReport } from '../packages/renderer/src/telemetry/WebReport.js';
import { sanitizeClientError } from '../services/ws-tcp-bridge/src/clientErrors.js';
import { resolveBridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil.js';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server.js';
import { formatLogLine } from '../services/ws-tcp-bridge/src/log.js';
import { validateReport } from '../deploy/web/cloudflare/report-worker.mjs';

/** tools/aws-logs.sh's rendering of one JSON log line: `key=<json value>` pairs, level dropped. */
function renderLikeAwsLogs(jsonLine: string): string {
  const obj = JSON.parse(jsonLine) as Record<string, unknown>;
  const val = (v: unknown) => (typeof v === 'boolean' ? String(v) : v === null ? 'null' : JSON.stringify(v));
  const fields = Object.entries(obj).filter(([k]) => k !== 'level').map(([k, v]) => `${k}=${val(v)}`).join(' ');
  return `2026-11-17T00:00:00.000Z [${String(obj.level).toUpperCase()}]  ${fields}`;
}

function memoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => { m.set(k, v); } };
}

describe('ErrorReporter — trace and bid on every report', () => {
  it('a boot refusal carries the page trace (read when the report is built) and the browser id the pre-world reporter uses', () => {
    const sent: Array<Record<string, unknown>> = [];
    const bid = browserId(memoryStorage(), () => '0a1b2c3d');
    // main.ts order: the error reporter first, the pre-world reporter (which makes the trace) just after.
    let preworld: PreworldReporter | null = null;
    const r = new ErrorReporter({
      endpoint: 'https://bridge.example/client-errors', build: 'b1', screen: () => 'boot', userAgent: 'UA',
      send: (_url, body) => { sent.push(JSON.parse(body)); },
      trace: () => preworld?.trace, browserId: bid,
    });
    preworld = new PreworldReporter({
      endpoint: null, build: 'b1', era: () => 'eor', server: () => null, screen: () => 'boot', chargenStep: () => null, browserId: bid,
    } as ConstructorParameters<typeof PreworldReporter>[0]);
    r.report('boot', 'WebGL 2 unavailable', { webglCause: 'no_webgl' });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ kind: 'boot', trace: preworld.trace, bid: '0a1b2c3d', webglCause: 'no_webgl' });
    expect(preworld.trace).toMatch(/^[0-9a-f]{16}$/);
  });

  it('no trace yet, a malformed trace or bid, or a throwing source: the field is left out and the report still goes', () => {
    const sent: Array<Record<string, unknown>> = [];
    const make = (trace: (() => string | null | undefined) | undefined, bid: string | null | undefined) => new ErrorReporter({
      endpoint: 'https://bridge.example/client-errors', build: 'b1', screen: () => 'boot',
      send: (_url, body) => { sent.push(JSON.parse(body)); }, trace, browserId: bid,
    });
    make(() => undefined, null).report('error', 'a');
    make(() => 'NOT A TRACE!', 'zzzzzzzz').report('error', 'b');
    make(() => { throw new Error('x'); }, '0a1b2c3d').report('error', 'c');
    make(undefined, undefined).report('error', 'd');
    expect(sent).toHaveLength(4);
    for (const b of sent.slice(0, 3)) expect(b).not.toHaveProperty('trace');
    expect(sent[0]).not.toHaveProperty('bid');
    expect(sent[1]).not.toHaveProperty('bid');
    expect(sent[2].bid).toBe('0a1b2c3d');
    expect(sent[3]).not.toHaveProperty('trace');
    expect(sent[3]).not.toHaveProperty('bid');
  });
});

describe('the bridge — client_error lines carry trace and bid', () => {
  it('sanitizeClientError keeps well-formed trace / bid and drops anything else', () => {
    const base = { kind: 'boot', message: 'WebGL 2 unavailable' };
    expect(sanitizeClientError({ ...base, trace: '0123456789abcdef', bid: '0a1b2c3d' })).toMatchObject({ trace: '0123456789abcdef', bid: '0a1b2c3d' });
    const junk = sanitizeClientError({ ...base, trace: 'x"><script>', bid: '1.2.3.4' })!;
    expect(junk).not.toHaveProperty('trace');
    expect(junk).not.toHaveProperty('bid');
    expect(sanitizeClientError({ ...base, trace: 7, bid: ['0a1b2c3d'] })).not.toHaveProperty('bid');
  });

  it('POST /client-errors → one client_error line whose rendered form greps as trace="<hex>" bid="<hex>"', async () => {
    const logs: string[] = [];
    const config = resolveBridgeConfig([], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
    config.wsPort = 0;
    const bridge = createBridgeServer(config, { log: (level, event, fields) => { logs.push(formatLogLine(level, event, fields)); } });
    const port = await bridge.listen();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/client-errors`, {
        method: 'POST', headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({
          kind: 'boot', trace: '9f8e7d6c5b4a3210', bid: '0a1b2c3d', message: 'WebGL 2 unavailable', build: 'b1', screen: 'boot',
          userAgent: 'UA', count: 1, webglCause: 'no_webgl', account: 'never-logged', password: 'never-logged',
        }),
      });
      expect(res.status).toBe(204);
      const line = logs.find((l) => l.includes('"event":"client_error"'))!;
      expect(line).toBeDefined();
      expect(line).not.toContain('never-logged');
      const rendered = renderLikeAwsLogs(line);
      // tools/monitor/resume-check.py and launch-filter.sh read traces this way.
      expect(rendered.match(/trace="([0-9a-f]+)"/)?.[1]).toBe('9f8e7d6c5b4a3210');
      expect(rendered).toMatch(/ bid="0a1b2c3d" /);
      expect(rendered).toMatch(/event="client_error".*kind="boot".*webglCause="no_webgl"/);
    } finally {
      await bridge.shutdown();
    }
  });
});

describe('web-origin reports (/__webac/report) carry trace and bid too', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('buildWebReport adds well-formed ids; the Worker keeps them and nulls anything else', () => {
    const input = launcherConnectFailedReport({
      netErrorId: 'ID_NetError_CantSocket', connectUrl: 'wss://bridge.playwebac.com/?server=x', bridgeUrl: 'wss://bridge.playwebac.com/', sinceLoginMs: 5, build: 'b',
    })!;
    const r = buildWebReport({ ...input, trace: '0123456789abcdef', bid: '0a1b2c3d' }, {});
    expect(r).toMatchObject({ trace: '0123456789abcdef', bid: '0a1b2c3d' });
    const none = buildWebReport({ ...input, trace: null, bid: 'nope' }, {});
    expect(none).not.toHaveProperty('trace');
    expect(none).not.toHaveProperty('bid');
    expect(validateReport(JSON.parse(JSON.stringify(r)))).toMatchObject({ trace: '0123456789abcdef', bid: '0a1b2c3d' });
    expect(validateReport({ kind: 'world_list_failed', trace: 'a b', bid: '0A1B2C3D' })).toMatchObject({ trace: null, bid: null });
  });
});
