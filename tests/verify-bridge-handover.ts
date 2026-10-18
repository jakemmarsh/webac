/**
 * Planned handover across a bridge deploy (services/ws-tcp-bridge/src/handover.ts,
 * packages/network/src/SocketHandover.ts; docs/bridge-handover.md).
 *
 * A deploy drains the old bridge; its sessions used to stay there for up to
 * BRIDGE_DRAIN_SECONDS (6 h). Now the draining bridge tells every tab, and the
 * tab moves its live session to the new deployment: the old bridge lets go of
 * the session's UDP socket without the server's Disconnect, the new one binds
 * the same address and port, and the tab swaps its WebSocket. The game server
 * sees the same endpoint before and after, and no Disconnect: nothing ended.
 *
 * Two real bridges sharing a secret, a fake UDP game server that records who
 * sends, the real SocketHandover driving real WebSockets.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as dgram from 'dgram';
import { WebSocket } from 'ws';
import { resolveBridgeConfig, type BridgeConfig } from '../services/ws-tcp-bridge/src/bridgeUtil';
import { createBridgeServer, DRAINING_FRAME, DRAINING_HANDOVER_FRAME, type BridgeServer } from '../services/ws-tcp-bridge/src/server';
import { HandoverTickets, bindWhenFree, HANDOVER_TICKET_MS } from '../services/ws-tcp-bridge/src/handover';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld';
import { SocketHandover, handoverUrl, type HandoverResult, type HandoverSocket } from '../packages/network/src/SocketHandover';
import { parseRelayLinkNotice } from '../packages/network/src/ClientConnection';

const SECRET = 'handover-test-secret-'.padEnd(40, 'x');
const DISCONNECT = 0x8000;

function config(port: number, env: Record<string, string> = {}): BridgeConfig {
  const c = resolveBridgeConfig(['0', '127.0.0.1', String(port), String(port + 1)], {
    BRIDGE_SERVERS_URL: 'none', BRIDGE_SERVERS_CACHE: 'none', BRIDGE_ROUTINES_DIR: 'none', ...env,
  });
  c.wsPort = 0;
  return c;
}

function open(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_req, res) => reject(new Error(`status ${res.statusCode}`)));
    ws.once('error', reject);
  });
}

async function until(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) { if (Date.now() - start > ms) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 5)); }
}

/** A client packet: 24 bytes with a sequence and the given header flags. */
function packet(seq: number, flags = 0x2): Buffer {
  const b = Buffer.alloc(24);
  b.writeUInt32LE(seq, 0);
  b.writeUInt32LE(flags, 4);
  return b;
}

describe('planned bridge handover', () => {
  const closers: Array<() => unknown> = [];
  afterEach(async () => { for (const c of closers.splice(0).reverse()) await c(); });

  /** The game server: records each datagram's sender, answers to whoever sent last. */
  async function gameServer() {
    const udp = dgram.createSocket('udp4');
    const got: Array<{ from: string; seq: number; flags: number }> = [];
    let last: dgram.RemoteInfo | null = null;
    udp.on('message', (m, r) => { last = r; got.push({ from: `${r.address}:${r.port}`, seq: m.readUInt32LE(0), flags: m.readUInt32LE(4) }); });
    await new Promise<void>((r) => udp.bind(0, '127.0.0.1', () => r()));
    closers.push(() => udp.close());
    const reply = (seq: number) => { if (last) udp.send(packet(seq, 0x4), last.port, last.address); };
    /** A ConnectRequest naming the session's client id (the bridge keeps it for the session's Disconnect). */
    const connectRequest = (clientId: number) => {
      const b = Buffer.alloc(20 + 32);
      b.writeUInt32LE(0x40000, 4);
      b.writeUInt32LE(clientId, 20 + 16);
      if (last) udp.send(b, last.port, last.address);
    };
    return { udp, got, reply, connectRequest, port: udp.address().port };
  }

  async function bridges(envA: Record<string, string> = { BRIDGE_HANDOVER_SECRET: SECRET }, envB: Record<string, string> = envA) {
    const server = await gameServer();
    const a = createBridgeServer(config(server.port, envA), { log: () => {} });
    const b = createBridgeServer(config(server.port, envB), { log: () => {} });
    const portA = await a.listen();
    const portB = await b.listen();
    closers.push(() => a.shutdown(), () => b.shutdown());
    return { server, a, b, portA, portB };
  }

  /** A tab in a game session on bridge A: its socket, and what arrived on it (game datagrams' sequences, texts). */
  async function session(env: Awaited<ReturnType<typeof bridges>>) {
    const ws = await open(`ws://127.0.0.1:${env.portA}/`);
    closers.push(() => ws.close());
    const seqs: number[] = [];
    const texts: string[] = [];
    ws.on('message', (d: ArrayBuffer | Buffer, binary: boolean) => {
      if (binary) seqs.push(Buffer.from(d as ArrayBuffer).readUInt32LE(0));
      else texts.push(d.toString());
    });
    ws.send(packet(2));
    await until(() => env.server.got.length === 1);
    env.server.connectRequest(0x1234);
    env.server.reply(100);
    await until(() => seqs.includes(100));
    return { ws, seqs, texts };
  }

  /** The tab's handover, as ClientConnection runs it: `onOld` gets the old socket's text frames. */
  function runHandover(old: WebSocket, url: string, oldTexts: string[]) {
    let moved: WebSocket | null = null;
    const newSeqs: number[] = [];
    const result = new Promise<HandoverResult>((resolve) => {
      const h = new SocketHandover({
        old: old as unknown as HandoverSocket,
        url,
        open: (u) => { const s = new WebSocket(u); return s as unknown as HandoverSocket; },
        switchTo: (s, early) => {
          moved = s as unknown as WebSocket;
          for (const f of early) newSeqs.push(Buffer.from(f as ArrayBuffer).readUInt32LE(0));
          moved.on('message', (d: ArrayBuffer, binary: boolean) => { if (binary) newSeqs.push(Buffer.from(d).readUInt32LE(0)); });
          closers.push(() => moved?.close());
        },
        done: resolve,
      });
      old.on('message', (d: Buffer, binary: boolean) => { if (!binary) h.onOldText(d.toString()); });
      h.start();
    });
    void oldTexts;
    return { result, moved: () => moved, newSeqs };
  }

  it('moves a live session to the new deployment: same endpoint at the server, no Disconnect, the old bridge drains empty', async () => {
    const env = await bridges();
    const tab = await session(env);
    const endpoint = env.server.got[0].from;

    const drained = env.a.drain(60_000);
    await until(() => tab.texts.includes(DRAINING_HANDOVER_FRAME));
    expect(parseRelayLinkNotice(DRAINING_HANDOVER_FRAME)).toEqual({ kind: 'draining', handover: true });
    const oldClosed = new Promise<void>((r) => tab.ws.once('close', () => r()));

    const t0 = Date.now();
    const h = runHandover(tab.ws, `ws://127.0.0.1:${env.portB}/`, tab.texts);
    const r = await h.result;
    expect(r).toMatchObject({ ok: true });
    console.log(`[handover] local loopback: ${r.ms} ms start → adopted (wall ${Date.now() - t0} ms)`);
    await oldClosed;

    // The session goes on over the new socket, from the same UDP endpoint.
    const moved = h.moved()!;
    moved.send(packet(3));
    await until(() => env.server.got.length === 2);
    expect(env.server.got[1]).toMatchObject({ from: endpoint, seq: 3 });
    env.server.reply(101);
    await until(() => h.newSeqs.includes(101));
    // The server never saw a Disconnect: nothing ended.
    expect(env.server.got.some((g) => g.flags & DISCONNECT)).toBe(false);
    expect(await drained).toBe('empty');
    expect(env.b.snapshot().sessions).toBe(1);

    // The moved session still ends cleanly later: the new bridge sends the Disconnect when it closes.
    moved.close();
    await until(() => env.server.got.some((g) => g.flags & DISCONNECT));
    expect(env.server.got.find((g) => g.flags & DISCONNECT)!.from).toBe(endpoint);
  });

  it('a bridge without the shared secret announces the drain but hands nothing over (the session stays, as before)', async () => {
    const env = await bridges({}, {});
    const tab = await session(env);
    void env.a.drain(60_000);
    await until(() => tab.texts.includes(DRAINING_FRAME));
    expect(parseRelayLinkNotice(DRAINING_FRAME)).toEqual({ kind: 'draining' });
    const r = await runHandover(tab.ws, `ws://127.0.0.1:${env.portB}/`, tab.texts).result;
    expect(r).toMatchObject({ ok: false, stage: 'ticket', reason: 'no_secret', released: false });
    // Still playing on the old bridge.
    tab.ws.send(packet(3));
    await until(() => env.server.got.length === 2);
    env.server.reply(102);
    await until(() => tab.seqs.includes(102));
  });

  it('no ticket before the drain starts', async () => {
    const env = await bridges();
    const tab = await session(env);
    const r = await runHandover(tab.ws, `ws://127.0.0.1:${env.portB}/`, tab.texts).result;
    expect(r).toMatchObject({ ok: false, stage: 'ticket', reason: 'not_draining', released: false });
  });

  it('a new bridge with another secret refuses the ticket and the old bridge keeps the session', async () => {
    const env = await bridges({ BRIDGE_HANDOVER_SECRET: SECRET }, { BRIDGE_HANDOVER_SECRET: 'another-secret-'.padEnd(40, 'y') });
    const tab = await session(env);
    void env.a.drain(60_000);
    await until(() => tab.texts.includes(DRAINING_HANDOVER_FRAME));
    const r = await runHandover(tab.ws, `ws://127.0.0.1:${env.portB}/`, tab.texts).result;
    expect(r).toMatchObject({ ok: false, stage: 'adopt', reason: 'bad_ticket', released: false });
    tab.ws.send(packet(3));
    await until(() => env.server.got.length === 2);
    expect(env.server.got[1].from).toBe(env.server.got[0].from);
    env.server.reply(103);
    await until(() => tab.seqs.includes(103));
  });

  it('a 1999-protocol session moves the same way (Connection1999 adds ?proto=ac1999 to both sockets); a ticket for another protocol is refused', async () => {
    const env = await bridges();
    const ws = await open(`ws://127.0.0.1:${env.portA}/?proto=ac1999`);
    closers.push(() => ws.close());
    const texts: string[] = [];
    ws.on('message', (d: Buffer, binary: boolean) => { if (!binary) texts.push(d.toString()); });
    ws.send(packet(1, 0));
    await until(() => env.server.got.length === 1);
    void env.a.drain(60_000);
    await until(() => texts.includes(DRAINING_HANDOVER_FRAME));
    // The end-of-retail URL: refused, and the session stays on the old bridge.
    const wrong = await runHandover(ws, `ws://127.0.0.1:${env.portB}/`, texts).result;
    expect(wrong).toMatchObject({ ok: false, stage: 'adopt', reason: 'other_protocol', released: false });
    const h = runHandover(ws, `ws://127.0.0.1:${env.portB}/?proto=ac1999`, texts);
    expect(await h.result).toMatchObject({ ok: true });
    h.moved()!.send(packet(2, 0));
    await until(() => env.server.got.length === 2);
    expect(env.server.got[1].from).toBe(env.server.got[0].from);
  });

  it('a handover socket carries nothing of its own until a ticket hands it a session', async () => {
    const env = await bridges();
    const ws = await open(handoverUrl(`ws://127.0.0.1:${env.portB}/`));
    closers.push(() => ws.close());
    ws.send(packet(2));
    await new Promise((r) => setTimeout(r, 100));
    expect(env.server.got).toHaveLength(0);
    // A forged ticket is refused.
    const answer = new Promise<string>((r) => ws.once('message', (d: Buffer) => r(d.toString())));
    ws.send(JSON.stringify({ adopt: 'h1.forged.ticket' }));
    expect(JSON.parse(await answer)).toEqual({ adopt: { ok: false, reason: 'bad_ticket' } });
  });
});

describe('handover tickets', () => {
  it('open once, on the same host, before they expire', () => {
    let now = 1_000_000;
    const a = new HandoverTickets(SECRET, () => now, 'host-a');
    const fields = { target: 'pinned', protocol: 'eor' as const, address: '0.0.0.0', port: 50000, aceSessionId: 7, time1999: 0, account: null, egress: null, trace: null };
    const t = a.issue(fields);
    expect(a.open(t)).toMatchObject({ ok: true, ticket: { port: 50000, aceSessionId: 7, host: 'host-a' } });
    expect(a.open(t)).toEqual({ ok: false, reason: 'used' });
    expect(new HandoverTickets(SECRET, () => now, 'host-b').open(a.issue(fields))).toEqual({ ok: false, reason: 'other_host' });
    const late = a.issue(fields);
    now += HANDOVER_TICKET_MS + 1;
    expect(a.open(late)).toEqual({ ok: false, reason: 'expired' });
  });

  it('the new bridge binds the port as soon as the old one lets go of it', async () => {
    const held = dgram.createSocket('udp4');
    await new Promise<void>((r) => held.bind(0, '127.0.0.1', () => r()));
    const port = held.address().port;
    setTimeout(() => held.close(), 60);
    const t0 = Date.now();
    const udp = await bindWhenFree('127.0.0.1', port);
    expect(udp).not.toBeNull();
    expect(udp!.address().port).toBe(port);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    udp!.close();
  });

  it('gives up when the port never frees', async () => {
    const held = dgram.createSocket('udp4');
    await new Promise<void>((r) => held.bind(0, '127.0.0.1', () => r()));
    expect(await bindWhenFree('127.0.0.1', held.address().port, { maxMs: 50 })).toBeNull();
    held.close();
  });
});

describe('handover telemetry', () => {
  it("the bridge logs a 'handover' outcome with its time, reason and path, and drops anything else", () => {
    expect(sanitizeClientPreworld({ outcome: 'handover', era: 'eor', handoverMs: 412, reason: 'safe', path: 'adopt' }))
      .toMatchObject({ outcome: 'handover', era: 'eor', handoverMs: 412, reason: 'safe', path: 'adopt' });
    const bad = sanitizeClientPreworld({ outcome: 'handover', handoverMs: -1, reason: 'whenever', path: 'teleport' })!;
    expect(bad.outcome).toBe('handover');
    expect(bad).not.toHaveProperty('handoverMs');
    expect(bad).not.toHaveProperty('reason');
    expect(bad).not.toHaveProperty('path');
    // Other outcomes never carry them.
    expect(sanitizeClientPreworld({ outcome: 'enter_ok', handoverMs: 5, reason: 'safe' })).not.toHaveProperty('handoverMs');
  });
});
