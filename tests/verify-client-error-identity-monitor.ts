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
