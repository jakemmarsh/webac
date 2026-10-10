/**
 * ASSESS (2026-06-10 fresh-eyes audit, testing recommendation #2): a
 * packet-replay corpus. tests/fixtures/ac-session-*.bin holds the raw inbound
 * (server→client) frames of a REAL ACE session, captured at the bridge
 * (BRIDGE_CAPTURE=<file>). Replaying them through the real ClientConnection →
 * ServerMessageHandler gives behavioral coverage of every parser path at once:
 * a wire-format regression either throws or changes the parsed event sequence,
 * both of which this test catches — the FAITHFUL.331–337 alignment-bug class
 * would have been caught automatically here.
 *
 * The corpus bytes are fixed, so the (eventType, opcode) sequence the handler
 * produces is deterministic even though the GUIDs/positions inside vary per
 * capture. We assert: the handshake completes, zero frames throw, and the
 * opcode histogram is stable (snapshot).
 *
 * CAPTURING A CORPUS (one step, requires a working local ACE):
 *   1. Start the bridge with capture on:
 *        BRIDGE_CAPTURE=tests/fixtures/ac-session-001.bin \
 *          npx tsx services/ws-tcp-bridge/src/bridge.ts
 *   2. Log in and play for a bit (login → world → move/cast a few actions).
 *   3. Stop the session. The .bin is now picked up automatically below.
 * tests/fixtures/ac-session-001.bin is committed, so the suite always runs:
 * a missing corpus fails 'the committed corpus is present', never skips.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ClientConnection,
  decodeCaptureFrames,
  type ConnectionEvent,
} from '@ac/network';

const FIXTURE_DIR = resolve(__dirname, 'fixtures');

// Node has no global WebSocket; ClientConnection only touches WebSocket.OPEN.
beforeAllEnsureWebSocket();
function beforeAllEnsureWebSocket(): void {
  const g = globalThis as { WebSocket?: unknown };
  if (typeof g.WebSocket === 'undefined') {
    g.WebSocket = class { static readonly OPEN = 1; };
  }
}

function corpusFiles(): string[] {
  return readdirSync(FIXTURE_DIR)
    .filter((f) => /^ac-session-.*\.bin$/.test(f))
    .sort();
}

interface ReplayResult {
  events: ConnectionEvent[];
  opcodeHistogram: Record<string, number>;
  eventTypeHistogram: Record<string, number>;
  parseErrors: number;
  framesFed: number;
}

function replay(corpus: Uint8Array): ReplayResult {
  const frames = decodeCaptureFrames(corpus);
  const events: ConnectionEvent[] = [];
  const conn = new ClientConnection('ws://replay-not-connected');
  // Pre-seed the credentials some handshake paths read.
  (conn as unknown as { lastAccount: string }).lastAccount = 'replay';
  (conn as unknown as { lastPassword: string }).lastPassword = 'replay';
  conn.on((e) => events.push(e));
  // Stub the socket: capture-replay must not touch the network.
  (conn as unknown as { ws: unknown }).ws = {
    readyState: 1,
    send: () => {},
    close: () => {},
  };

  let parseErrors = 0;
  for (const frame of frames) {
    try {
      (conn as unknown as { handlePacket(p: Uint8Array): void }).handlePacket(frame);
    } catch {
      // handlePacket wraps per-listener errors already; a throw here is a
      // packet-walk/parse failure — exactly the regression we want to flag.
      parseErrors++;
    }
  }

  const opcodeHistogram: Record<string, number> = {};
  const eventTypeHistogram: Record<string, number> = {};
  for (const e of events) {
    eventTypeHistogram[e.type] = (eventTypeHistogram[e.type] ?? 0) + 1;
    if (e.type === 'message') {
      const op = (e.data as { opcode?: number }).opcode;
      if (op !== undefined) {
        const key = '0x' + op.toString(16);
        opcodeHistogram[key] = (opcodeHistogram[key] ?? 0) + 1;
      }
    }
  }

  // Try to free any keepalive timer the handshake may have armed.
  try { (conn as unknown as { disconnect(): void }).disconnect(); } catch { /* ignore */ }

  return { events, opcodeHistogram, eventTypeHistogram, parseErrors, framesFed: frames.length };
}

const FILES = corpusFiles();

// tests/fixtures/ is committed (ac-session-001.bin ships with the repo), so an
// empty corpus is a broken checkout — fail, never skip vacuously
// (DEBT.test-harness-hygiene).
describe('packet-replay corpus (real ACE session bytes)', () => {
  const files = FILES;

  it('the committed corpus is present', () => {
    expect(files).toContain('ac-session-001.bin');
  });

  for (const file of files) {
    describe(file, () => {
      const corpus = readFileSync(resolve(FIXTURE_DIR, file));
      const result = replay(new Uint8Array(corpus));

      it('decodes into a non-trivial number of frames', () => {
        expect(result.framesFed).toBeGreaterThan(10);
      });

      it('replays every frame without a parse/packet-walk exception', () => {
        expect(result.parseErrors).toBe(0);
      });

      it('completes the ACE handshake (handshakeComplete from the ConnectRequest)', () => {
        // 'connected' is a ws.onopen event, not derivable from replaying inbound
        // frames — 'handshakeComplete' is what processing the server's
        // ConnectRequest emits, so that's the replay-observable handshake marker.
        expect(result.eventTypeHistogram['handshakeComplete'] ?? 0).toBeGreaterThanOrEqual(1);
      });

      it('parses the expected login + world-entry event milestones', () => {
        // A real login→world corpus must surface these in the parsed stream.
        expect(result.eventTypeHistogram['characterList'] ?? 0).toBeGreaterThanOrEqual(1);
        expect(result.eventTypeHistogram['playerCreate'] ?? 0).toBeGreaterThanOrEqual(1);
        expect(result.eventTypeHistogram['objectCreate'] ?? 0).toBeGreaterThanOrEqual(1);
        expect(result.eventTypeHistogram['message'] ?? 0).toBeGreaterThan(20);
      });

      it('parses a stable set of message opcodes (snapshot)', () => {
        // The corpus is fixed, so the opcode histogram is deterministic — a
        // parser change that re-routes bytes changes this snapshot.
        expect(result.opcodeHistogram).toMatchSnapshot();
      });

      it('produces a stable event-type histogram (snapshot)', () => {
        expect(result.eventTypeHistogram).toMatchSnapshot();
      });
    });
  }
});
