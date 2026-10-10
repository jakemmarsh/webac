/**
 * Bridge deploys without dropping players (services/ws-tcp-bridge/src/server.ts
 * drain()): new connections are refused while a draining bridge keeps every
 * open session relaying until it ends or the cap passes. A real bridge, real
 * WebSockets and a UDP echo standing in for the game server.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as dgram from 'dgram';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { resolveBridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer, type BridgeServer } from '../services/ws-tcp-bridge/src/server';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

async function echoServer(): Promise<number> {
  const sock = dgram.createSocket('udp4');
  sock.on('message', (msg, rinfo) => sock.send(msg, rinfo.port, rinfo.address));
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  cleanups.push(() => sock.close());
  return (sock.address() as AddressInfo).port;
}

async function startBridge(): Promise<{ bridge: BridgeServer; url: string }> {
  const port = await echoServer();
  const config = resolveBridgeConfig(['0', '127.0.0.1', String(port)], { BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none' });
  config.wsPort = 0;
  const bridge = createBridgeServer(config, { log: () => {} });
  const bound = await bridge.listen();
  cleanups.push(() => bridge.shutdown());
  return { bridge, url: `ws://127.0.0.1:${bound}` };
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

/** A 20-byte packet (the bridge drops anything shorter), echoed back through the bridge. */
function roundTrip(ws: WebSocket): Promise<boolean> {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve(false), 2000);
    ws.once('message', () => { clearTimeout(t); resolve(true); });
    ws.send(Buffer.alloc(24, 1));
  });
}

describe('bridge drain', () => {
  it('refuses new connections, keeps the open session relaying, and resolves when it ends', async () => {
    const { bridge, url } = await startBridge();
    const player = await open(url);
    expect(await roundTrip(player)).toBe(true);

    const drained = bridge.drain(60_000);
    await expect(open(url)).rejects.toThrow(/status 503/);
    expect(bridge.snapshot()).toMatchObject({ draining: true, sessions: 1 });
    expect(await roundTrip(player)).toBe(true); // still playing through the drain

    player.close();
    expect(await drained).toBe('empty');
  });

  it('gives up after the cap with sessions still open; shutdown() then closes them', async () => {
    const { bridge, url } = await startBridge();
    const player = await open(url);
    const closed = new Promise<number>((r) => player.once('close', (code) => r(code)));
    expect(await bridge.drain(150)).toBe('timeout');
    await bridge.shutdown();
    expect(await closed).toBe(1001);
  });

  it('an idle bridge drains at once', async () => {
    const { bridge } = await startBridge();
    expect(await bridge.drain(60_000)).toBe('empty');
  });
});
