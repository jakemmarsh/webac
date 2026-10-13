/**
 * Simple Proxy Protocol (services/ws-tcp-bridge/src/spp.ts): a server that
 * trusts the bridge learns each player's real address from a 38-byte header
 * on every datagram and echoes it on its replies. Header encoding against the
 * Cloudflare spec, then a real bridge, real WebSockets and a UDP server
 * standing in for a patched ACE.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as dgram from 'dgram';
import type { AddressInfo } from 'net';
import WebSocket from 'ws';
import { resolveBridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer } from '../services/ws-tcp-bridge/src/server';
import {
  SPP_HEADER_SIZE, SPP_MAGIC, encodeSppHeader, sppAddressBytes, stripSppHeader,
} from '../services/ws-tcp-bridge/src/spp';

const cleanups: Array<() => unknown> = [];
afterEach(async () => { for (const c of cleanups.splice(0)) await c(); });

const hex = (b: Buffer) => b.toString('hex');

describe('SPP header encoding', () => {
  it('lays out magic, client, proxy, ports in network byte order (38 bytes)', () => {
    const h = encodeSppHeader({ address: '203.0.113.7', port: 51000 }, { address: '10.0.0.2', port: 9090 });
    expect(h.length).toBe(SPP_HEADER_SIZE);
    expect(h.readUInt16BE(0)).toBe(SPP_MAGIC);
    expect(hex(h.subarray(2, 18))).toBe('00000000000000000000ffffcb007107');
    expect(hex(h.subarray(18, 34))).toBe('00000000000000000000ffff0a000002');
    expect(h.readUInt16BE(34)).toBe(51000);
    expect(h.readUInt16BE(36)).toBe(9090);
  });

  it('encodes IPv4-mapped, full and compressed IPv6 addresses', () => {
    expect(hex(sppAddressBytes('::ffff:198.51.100.4'))).toBe('00000000000000000000ffffc6336404');
    expect(hex(sppAddressBytes('2001:db8::1'))).toBe('20010db8000000000000000000000001');
    expect(hex(sppAddressBytes('2001:db8:0:0:1:2:3:4'))).toBe('20010db8000000000001000200030004');
    expect(hex(sppAddressBytes('::1'))).toBe('00000000000000000000000000000001');
    expect(hex(sppAddressBytes('fe80::1%eth0'))).toBe('fe800000000000000000000000000001');
    expect(hex(sppAddressBytes('not an ip'))).toBe('0'.repeat(32));
  });

  it('strips a reply\'s header and refuses a reply without one', () => {
    const payload = Buffer.from('payload!');
    const h = encodeSppHeader({ address: '203.0.113.7', port: 0 }, { address: '10.0.0.2', port: 9090 });
    expect(stripSppHeader(Buffer.concat([h, payload]))?.toString()).toBe('payload!');
    expect(stripSppHeader(payload)).toBeNull();
    expect(stripSppHeader(Buffer.alloc(SPP_HEADER_SIZE + 4))).toBeNull(); // wrong magic
    expect(stripSppHeader(h.subarray(0, 20))).toBeNull(); // short
  });
});

describe('resolveBridgeConfig: SPP opt-in', () => {
  it('is off unless BRIDGE_SPP / BRIDGE_SPP_SERVERS say so', () => {
    expect(resolveBridgeConfig([], {}).spp).toEqual({ pinned: false, servers: new Set() });
    const cfg = resolveBridgeConfig([], { BRIDGE_SPP: '1', BRIDGE_SPP_SERVERS: ' PortalStorm-ID , other ,' });
    expect(cfg.spp.pinned).toBe(true);
    expect([...cfg.spp.servers]).toEqual(['portalstorm-id', 'other']);
  });
});

interface Received { header: Buffer; payload: Buffer; port: number }

/** A UDP server standing in for ACE; `reply` decides what goes back. */
async function gameServer(reply: (d: Buffer) => Buffer | null): Promise<{ port: number; got: Received[] }> {
  const got: Received[] = [];
  const sock = dgram.createSocket('udp4');
  sock.on('message', (d, rinfo) => {
    got.push({ header: d.subarray(0, SPP_HEADER_SIZE), payload: d.subarray(SPP_HEADER_SIZE), port: rinfo.port });
    const out = reply(d);
    if (out) sock.send(out, rinfo.port, rinfo.address);
  });
  await new Promise<void>((r) => sock.bind(0, '127.0.0.1', () => r()));
  cleanups.push(() => sock.close());
  return { port: (sock.address() as AddressInfo).port, got };
}

async function bridgeTo(port: number, env: Record<string, string>): Promise<string> {
  const config = resolveBridgeConfig(['0', '127.0.0.1', String(port)], {
    BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none',
    BRIDGE_TRUST_PROXY: '1', BRIDGE_CLIENT_IP_HEADER: 'x-real-ip', ...env,
  });
  config.wsPort = 0;
  const bridge = createBridgeServer(config, { log: () => {} });
  const bound = await bridge.listen();
  cleanups.push(() => bridge.shutdown());
  return `ws://127.0.0.1:${bound}`;
}

function open(url: string, realIp: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers: { 'x-real-ip': realIp } });
    ws.once('open', () => { cleanups.push(() => ws.close()); resolve(ws); });
    ws.once('error', reject);
  });
}

/** Sends a 24-byte packet (fill bytes without the ConnectResponse flag, so it goes to the login port); resolves with what came back through the bridge, or null after 1 s. */
function send(ws: WebSocket, fill: number): Promise<Buffer | null> {
  return new Promise((resolve) => {
    const t = setTimeout(() => { ws.off('message', on); resolve(null); }, 1000);
    const on = (m: Buffer) => { clearTimeout(t); resolve(Buffer.from(m)); };
    ws.once('message', on);
    ws.send(Buffer.alloc(24, fill));
  });
}

describe('bridge with SPP on', () => {
  it('prepends each player\'s own address, and hands the browser the reply without the header', async () => {
    // A trusting server echoes the header it got (the spec), then its payload.
    const server = await gameServer((d) => Buffer.concat([d.subarray(0, SPP_HEADER_SIZE), Buffer.from('reply:'), d.subarray(SPP_HEADER_SIZE)]));
    const url = await bridgeTo(server.port, { BRIDGE_SPP: '1' });
    const a = await open(url, '203.0.113.7');
    const b = await open(url, '2001:db8::42');

    const ra = await send(a, 0x11);
    const rb = await send(b, 0x22);
    expect(ra?.toString('latin1').startsWith('reply:')).toBe(true);
    expect(ra?.subarray(6)).toEqual(Buffer.alloc(24, 0x11));
    expect(rb?.subarray(6)).toEqual(Buffer.alloc(24, 0x22));

    expect(server.got).toHaveLength(2);
    const [ga, gb] = server.got;
    expect(ga.header.readUInt16BE(0)).toBe(SPP_MAGIC);
    expect(hex(ga.header.subarray(2, 18))).toBe(hex(sppAddressBytes('203.0.113.7')));
    expect(hex(gb.header.subarray(2, 18))).toBe(hex(sppAddressBytes('2001:db8::42')));
    expect(ga.payload).toEqual(Buffer.alloc(24, 0x11));
    // Each player keeps its own UDP source port, as the server keys sessions by it.
    expect(ga.port).not.toBe(gb.port);
  });

  it('drops a reply that lacks the header instead of passing junk to the client', async () => {
    const server = await gameServer((d) => d.subarray(SPP_HEADER_SIZE)); // forgets to echo
    const url = await bridgeTo(server.port, { BRIDGE_SPP: '1' });
    expect(await send(await open(url, '203.0.113.7'), 1)).toBeNull();
  });
});

describe('bridge with SPP off (every server today)', () => {
  it('sends and receives the datagrams byte for byte, with no header', async () => {
    const server = await gameServer((d) => d);
    const url = await bridgeTo(server.port, {});
    const r = await send(await open(url, '203.0.113.7'), 0x56);
    expect(r).toEqual(Buffer.alloc(24, 0x56));
    expect(Buffer.concat([server.got[0].header, server.got[0].payload])).toEqual(Buffer.alloc(24, 0x56));
  });
});
