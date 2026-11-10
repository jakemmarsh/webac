/**
 * OBS.upgrade-aborted — an admitted WebSocket upgrade that never reaches openSession logs one
 * `upgrade_aborted` warn line (2026-11-10: two hidden-tab resumes whose sockets failed left no bridge
 * line at all), and still frees the per-IP slot admission took, exactly once.
 *
 * Drives the real bridge server (createBridgeServer) over real TCP sockets: a client that vanishes
 * while admission is still resolving its server, and one whose upgrade request ws refuses.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as net from 'net';
import { WebSocket } from 'ws';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { ServerRegistry } from '../services/ws-tcp-bridge/src/serverList';
import { createBridgeServer, type BridgeServer } from '../services/ws-tcp-bridge/src/server';

type Line = { level: string; event: string; fields: Record<string, unknown> };

const TRACE = '0123456789abcdef';
const IP = '198.51.100.44';

function baseConfig(env: Record<string, string>): BridgeConfig {
  const c = resolveBridgeConfig([], {
    BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none', BRIDGE_MODE: 'multi', BRIDGE_ALLOW_PRIVATE_TARGETS: '1',
    BRIDGE_TRUST_PROXY: '1', BRIDGE_MAX_SESSIONS_PER_IP: '1', BRIDGE_CONNECT_RATE_PER_IP: '1000', ...env,
  });
  c.wsPort = 0;
  return c;
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('timed out waiting');
    await new Promise(r => setTimeout(r, 10));
  }
}

/** A raw upgrade request (what a browser sends), written on a plain TCP socket we control. */
function rawUpgrade(port: number, opts: { key?: boolean } = {}): net.Socket {
  const s = net.connect(port, '127.0.0.1');
  s.on('error', () => { /* destroyed on purpose */ });
  s.write([
    `GET /connect?server=local&trace=${TRACE} HTTP/1.1`,
    `Host: 127.0.0.1:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    ...(opts.key === false ? [] : ['Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==']),
    'Sec-WebSocket-Version: 13',
    `X-Forwarded-For: ${IP}`,
    '', '',
  ].join('\r\n'));
  return s;
}

describe('bridge upgrade_aborted (OBS.upgrade-aborted)', () => {
  let bridge: BridgeServer | null = null;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    if (bridge) await bridge.shutdown();
    bridge = null;
  });

  /** A bridge whose server lookup waits until `gate.open()` (admission is async in multi mode). */
  async function start(): Promise<{ port: number; lines: Line[]; gate: { held: boolean; open(): void } }> {
    const lines: Line[] = [];
    let waiters: Array<() => void> = [];
    const gate = { held: true, open() { this.held = false; for (const w of waiters.splice(0)) w(); } };
    const lookup = async () => {
      if (gate.held) await new Promise<void>(r => waiters.push(r));
      return ['127.0.0.1'];
    };
    const registry = new ServerRegistry({
      url: null, refreshMs: 0, cachePath: null,
      overlay: { servers: [{ id: 'local', name: 'Local Fake', emu: 'ACE', host: 'fake.example', port: 9000, source: 'overlay' }], deny: [] },
    });
    await registry.start();
    bridge = createBridgeServer(baseConfig({}), {
      registry, lookup,
      log: (level, event, fields) => { lines.push({ level, event, fields: fields ?? {} }); },
    });
    return { port: await bridge.listen(), lines, gate };
  }

  async function openWs(port: number): Promise<WebSocket> {
    const ws = await new Promise<WebSocket>((resolve, reject) => {
      const w = new WebSocket(`ws://127.0.0.1:${port}/connect?server=local`, { headers: { 'x-forwarded-for': IP } });
      w.once('open', () => resolve(w));
      w.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
      w.once('error', reject);
    });
    sockets.push(ws);
    return ws;
  }

  const aborted = (lines: Line[]) => lines.filter(l => l.event === 'upgrade_aborted');

  it('a client that destroys its socket while admission resolves logs socket_destroyed_after_admit and frees its IP slot', async () => {
    const { port, lines, gate } = await start();
    const s = rawUpgrade(port);
    // Let the request reach the bridge (admission now waits on the lookup), then vanish.
    await new Promise(r => setTimeout(r, 50));
    s.resetAndDestroy(); // RST: the bridge's end of the socket is destroyed, not just half-closed
    await new Promise(r => setTimeout(r, 50));
    gate.open();
    await until(() => aborted(lines).length === 1);
    const [line] = aborted(lines);
    expect(line.level).toBe('warn');
    expect(line.fields).toMatchObject({ ip: IP, reason: 'socket_destroyed_after_admit', server: 'local', trace: TRACE });
    expect(typeof line.fields.ms).toBe('number');
    expect(line.fields.ms as number).toBeGreaterThanOrEqual(50);
    expect(lines.some(l => l.event === 'session_open')).toBe(false);

    // The per-IP cap is 1: the slot was freed, so this player's next socket gets in.
    const ws = await openWs(port);
    expect(bridge!.snapshot().sessions).toBe(1);
    expect(aborted(lines)).toHaveLength(1); // a session that opened logs nothing
    ws.close();
    await until(() => bridge!.snapshot().sessions === 0);
    // ...and the release ran once: after the session's own release, one slot again (not two).
    await openWs(port);
    const refused = await openWs(port); // the cap still holds at 1: accepted only to be closed with 4429
    const code = await new Promise<number>(r => refused.once('close', (c) => r(c)));
    expect(code).toBe(4429);
    expect(aborted(lines)).toHaveLength(1); // a refusal is connect_rejected, not upgrade_aborted
  });

  it('an upgrade ws refuses (no Sec-WebSocket-Key) logs handshake_error and frees its IP slot', async () => {
    const { port, lines, gate } = await start();
    gate.open();
    const s = rawUpgrade(port, { key: false });
    const reply = await new Promise<string>((resolve) => {
      let got = '';
      s.on('data', (d) => { got += d.toString(); });
      s.on('close', () => resolve(got));
    });
    expect(reply).toMatch(/^HTTP\/1\.1 400/); // ws's own answer, unchanged
    await until(() => aborted(lines).length === 1);
    expect(aborted(lines)[0].fields).toMatchObject({ ip: IP, reason: 'handshake_error', server: 'local', trace: TRACE });
    await openWs(port);
    expect(bridge!.snapshot().sessions).toBe(1);
  });

  it('a client that half-closes (FIN) before the upgrade completes is logged, never opened, and freed', async () => {
    const { port, lines, gate } = await start();
    const s = rawUpgrade(port);
    await new Promise(r => setTimeout(r, 50));
    s.end(); // FIN while admission waits
    await new Promise(r => setTimeout(r, 50));
    gate.open();
    await until(() => aborted(lines).length === 1);
    // Node may already have torn the socket down (destroyed) or left it half-closed for ws to drop.
    expect(['socket_destroyed_after_admit', 'closed_before_open']).toContain(aborted(lines)[0].fields.reason);
    expect(lines.some(l => l.event === 'session_open')).toBe(false);
    await openWs(port);
    expect(bridge!.snapshot().sessions).toBe(1);
  });

  it('logs at most 10 lines a minute per address', async () => {
    const { port, lines, gate } = await start();
    gate.open();
    for (let i = 0; i < 12; i++) {
      const s = rawUpgrade(port, { key: false });
      s.resume(); // drain ws's 400 answer so the close arrives
      await new Promise<void>(r => s.on('close', () => r()));
    }
    await new Promise(r => setTimeout(r, 50));
    expect(aborted(lines)).toHaveLength(10);
    await openWs(port); // and every one of them freed its slot
  });
});
