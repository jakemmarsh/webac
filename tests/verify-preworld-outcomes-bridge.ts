/**
 * RELEASE.preworld-outcomes — the bridge side: POST /client-preworld becomes
 * one `client_preworld` log line of whitelisted fields (clientPreworld.ts),
 * rate-limited per address and size-capped, and a session's `?trace=` page
 * id lands on its session_open / session_close lines so the two correlate.
 */
import { describe, it, expect } from 'vitest';
import * as dgram from 'dgram';
import { WebSocket } from 'ws';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server';
import { renderPrometheus } from '../services/ws-tcp-bridge/src/metrics';
import { sanitizeClientPreworld, traceFromUrl, CLIENT_PREWORLD_MAX_BODY } from '../services/ws-tcp-bridge/src/clientPreworld';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter';

function baseConfig(argv: string[] = []): BridgeConfig {
  const c = resolveBridgeConfig(argv, { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
  c.wsPort = 0;
  return c;
}

type Line = [string, string, Record<string, unknown>];
const until = async (f: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!f()) { if (Date.now() > end) throw new Error('timeout'); await new Promise(r => setTimeout(r, 10)); }
};

/** A real reporter's payload (what the page POSTs). */
function pagePayload(): PreworldEvent {
  let body = '';
  const r = new PreworldReporter({
    endpoint: 'http://x/client-preworld', build: 'abc1234', era: () => 'eor', server: () => 'coldeve',
    screen: () => 'connecting', now: () => 5000, trace: 'feedc0de12345678', send: (_u, b) => { body = b; },
  });
  r.connectionError({ characterError: 0x14 }, 'ID_CHAR_ERROR_ACCOUNT_DOESNT_EXIST');
  return JSON.parse(body) as PreworldEvent;
}

describe('sanitizeClientPreworld', () => {
  it("keeps a real reporter payload whole", () => {
    const p = pagePayload();
    expect(sanitizeClientPreworld(p)).toEqual(p);
  });

  it('drops unknown fields and every value that is not a code, number or listed identifier', () => {
    const ev = sanitizeClientPreworld({
      ...pagePayload(),
      account: 'bob', password: 'hunter2', name: 'Bob the Great', message: 'hi',
      token: 'Bob the Great', era: 'eor; drop table', server: 'a b', trace: 'NOTHEX!', screen: 'my-house',
      step: 'Bob', build: '<script>', code: -1, count: 1e9, pageMs: 1.5,
    })!;
    expect(Object.keys(ev)).not.toContain('account');
    expect(JSON.stringify(ev)).not.toMatch(/bob|hunter2|hi"|script/i);
    expect(ev).toMatchObject({
      outcome: 'login_refused', token: null, era: null, server: null, trace: null, screen: null, step: null, build: null,
      code: null, count: null, pageMs: null,
    });
    expect(sanitizeClientPreworld({ outcome: 'nope' })).toBeNull();
    // A deliberate reload (an era switch) is its own closed outcome, its reason a token.
    expect(sanitizeClientPreworld({ ...pagePayload(), outcome: 'page_reload', token: 'era_switch' })).toMatchObject({ outcome: 'page_reload', token: 'era_switch' });
    expect(sanitizeClientPreworld([])).toBeNull();
    expect(sanitizeClientPreworld('x')).toBeNull();
  });

  it('the boot reason codes pass the token check; boot text does not', () => {
    for (const token of ['boot_password_mismatch', 'boot_banned', 'boot_client_version', 'boot_dat_newer', 'boot_no_reason', 'boot_other']) {
      expect(sanitizeClientPreworld({ outcome: 'login_refused', token })!.token).toBe(token);
    }
    expect(sanitizeClientPreworld({ outcome: 'login_refused', token: ' because the password entered for this account was not correct' })!.token).toBeNull();
  });

  it('reads a trace id off an upgrade URL', () => {
    expect(traceFromUrl('/connect?server=coldeve&trace=feedc0de12345678')).toBe('feedc0de12345678');
    expect(traceFromUrl('/?trace=bad%20id')).toBeNull();
    expect(traceFromUrl(undefined)).toBeNull();
  });
});

describe('POST /client-preworld', () => {
  it('logs one client_preworld line (nulls left out), counts it, refuses junk, oversize bodies and floods', async () => {
    const logs: Line[] = [];
    const bridge = createBridgeServer(baseConfig(), { log: (level, event, fields) => { logs.push([level, event, fields ?? {}]); } });
    const port = await bridge.listen();
    try {
      const post = (body: string) => fetch(`http://127.0.0.1:${port}/client-preworld`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body });
      const ok = await post(JSON.stringify(pagePayload()));
      expect(ok.status).toBe(204);
      expect(ok.headers.get('access-control-allow-origin')).toBe('*');
      const line = logs.find(l => l[1] === 'client_preworld')!;
      expect(line[0]).toBe('info');
      expect(line[2]).toEqual({
        ip: expect.any(String), outcome: 'login_refused', era: 'eor', server: 'coldeve', trace: 'feedc0de12345678', build: 'abc1234',
        screen: 'connecting', code: 0x14, token: 'ID_CHAR_ERROR_ACCOUNT_DOESNT_EXIST', pageMs: 0, screenMs: 0,
      });
      expect(bridge.metrics.clientPreworld.get('login_refused')).toBe(1);
      expect(renderPrometheus(bridge.metrics, { mode: 'pinned', era: null, sessions: 0, perServer: [], serversList: null, uptimeSeconds: 0, draining: false }))
        .toContain('acbridge_client_preworld_total{outcome="login_refused"} 1');
      expect((await post('not json')).status).toBe(400);
      expect((await post(JSON.stringify({ outcome: 'page_left', pad: 'x'.repeat(CLIENT_PREWORLD_MAX_BODY) }))).status).toBe(413);
      const pre = await fetch(`http://127.0.0.1:${port}/client-preworld`, { method: 'OPTIONS' });
      expect(pre.status).toBe(204);
      // 60 per 10 minutes per address: 3 used above (the 413 never reached the handler).
      for (let i = 0; i < 58; i++) await post('{}');
      expect((await post(JSON.stringify(pagePayload()))).status).toBe(429);
      // A separate budget from crash reports.
      expect((await fetch(`http://127.0.0.1:${port}/client-errors`, { method: 'POST', body: JSON.stringify({ kind: 'boot', message: 'x' }) })).status).toBe(204);
    } finally {
      await bridge.shutdown();
    }
  });

  it("a session's ?trace= is on its session_open and session_close lines", async () => {
    const udp = dgram.createSocket('udp4');
    await new Promise<void>(r => udp.bind(0, '127.0.0.1', () => r()));
    const udpPort = (udp.address() as { port: number }).port;
    const logs: Line[] = [];
    const bridge = createBridgeServer(baseConfig(['0', '127.0.0.1', String(udpPort)]), { log: (level, event, fields) => { logs.push([level, event, fields ?? {}]); } });
    const port = await bridge.listen();
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/?trace=feedc0de12345678`);
      await new Promise<void>((res, rej) => { ws.once('open', () => res()); ws.once('error', rej); });
      await until(() => logs.some(l => l[1] === 'session_open'));
      expect(logs.find(l => l[1] === 'session_open')![2]).toMatchObject({ trace: 'feedc0de12345678' });
      ws.close();
      await until(() => logs.some(l => l[1] === 'session_close'));
      expect(logs.find(l => l[1] === 'session_close')![2]).toMatchObject({ trace: 'feedc0de12345678' });
      // No trace (or a malformed one): the lines are as before.
      const ws2 = new WebSocket(`ws://127.0.0.1:${port}/?trace=<x>`);
      await new Promise<void>((res, rej) => { ws2.once('open', () => res()); ws2.once('error', rej); });
      await until(() => logs.filter(l => l[1] === 'session_open').length === 2);
      expect(logs.filter(l => l[1] === 'session_open')[1][2]).not.toHaveProperty('trace');
      ws2.close();
    } finally {
      await bridge.shutdown();
      udp.close();
    }
  });
});
