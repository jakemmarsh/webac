/**
 * FAITHFUL.272 — 'server-load' HUD indicator driven by ping round-trip latency.
 *
 * Pre-fix the 'server-load' HUD indicator (LayoutDesc icon active=0x06001360,
 * inactive=0x06001362) was rendered but never wired — stayed permanently
 * inactive. GameEventPingResponse (0x01EA, 4-byte header-only) was lumped
 * into the silent-consume case and ignored. AC retail's server-load
 * indicator lit up when the player's connection to the server became
 * laggy; we mirror that by measuring round-trip time of our own ping
 * requests and lighting the icon when latency exceeds the threshold.
 *
 * The latency math (round-trip computation, 250ms threshold decision, 3s
 * in-flight-hang fallback) lives in PingLatencyTracker
 * (packages/renderer/src/network/PingLatencyTracker.ts) and is driven here
 * directly with injected timestamps — not through a text pin on main.ts.
 * The ServerMessageHandler dispatch + main.ts wiring (setIndicatorActive
 * call site, heartbeat interval setup) are checked as a secondary text
 * pattern, since that's plumbing rather than logic worth unit-testing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PingLatencyTracker,
  SERVER_LOAD_LATENCY_MS,
  PING_HANG_FALLBACK_MS,
} from '../packages/renderer/src/network/PingLatencyTracker.js';
import { GameActions } from '../packages/renderer/src/network/GameActions.js';
import { GameActionType } from '../packages/network/src/index.js';

const REPO = resolve(__dirname, '..');

describe('FAITHFUL.272 — PingLatencyTracker (behavioral)', () => {
  it('has no in-flight request initially — responseReceived is a no-op', () => {
    const tracker = new PingLatencyTracker(() => 0);
    expect(tracker.responseReceived()).toBeNull();
    expect(tracker.isHung()).toBe(false);
  });

  it('computes round-trip latency between requestSent and responseReceived', () => {
    let t = 1000;
    const tracker = new PingLatencyTracker(() => t);
    tracker.requestSent();
    t = 1120;
    const result = tracker.responseReceived();
    expect(result).toEqual({ latencyMs: 120, indicatorActive: false });
    expect(tracker.lastLatency).toBe(120);
  });

  it('indicatorActive is false exactly at the 250ms threshold (strictly greater-than)', () => {
    let t = 0;
    const tracker = new PingLatencyTracker(() => t);
    tracker.requestSent();
    t = SERVER_LOAD_LATENCY_MS;
    expect(tracker.responseReceived()).toEqual({ latencyMs: SERVER_LOAD_LATENCY_MS, indicatorActive: false });
  });

  it('indicatorActive is true just above the 250ms threshold', () => {
    let t = 0;
    const tracker = new PingLatencyTracker(() => t);
    tracker.requestSent();
    t = SERVER_LOAD_LATENCY_MS + 1;
    expect(tracker.responseReceived()).toEqual({ latencyMs: SERVER_LOAD_LATENCY_MS + 1, indicatorActive: true });
  });

  it('clears the in-flight marker after a response, so a stray second response is a no-op', () => {
    let t = 0;
    const tracker = new PingLatencyTracker(() => t);
    tracker.requestSent();
    t = 50;
    tracker.responseReceived();
    t = 999;
    expect(tracker.responseReceived()).toBeNull();
  });

  it('isHung is false right up to the 3s cutoff, true just past it', () => {
    let t = 0;
    const tracker = new PingLatencyTracker(() => t);
    tracker.requestSent();
    t = PING_HANG_FALLBACK_MS;
    expect(tracker.isHung()).toBe(false);
    t = PING_HANG_FALLBACK_MS + 1;
    expect(tracker.isHung()).toBe(true);
  });

  it('isHung is false once there is no in-flight request', () => {
    const tracker = new PingLatencyTracker(() => 0);
    expect(tracker.isHung()).toBe(false);
  });

  it('reset() clears in-flight state without recording a latency', () => {
    let t = 0;
    const tracker = new PingLatencyTracker(() => t);
    tracker.requestSent();
    t = 10000;
    tracker.reset();
    expect(tracker.isHung()).toBe(false);
    expect(tracker.responseReceived()).toBeNull();
    expect(tracker.lastLatency).toBeNull();
  });

  it('defaults to performance.now() when no clock is injected', () => {
    const tracker = new PingLatencyTracker();
    tracker.requestSent();
    const result = tracker.responseReceived();
    expect(result).not.toBeNull();
    expect(result!.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('FAITHFUL.272 — server-load wiring (text check on plumbing, not logic)', () => {
  const SMH_TS = readFileSync(resolve(REPO, 'packages/renderer/src/network/ServerMessageHandler.ts'), 'utf-8');
  const MAIN_TS = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

  it('ServerMessageHandler.onPingResponse handler is declared (void payload)', () => {
    expect(SMH_TS).toMatch(/onPingResponse\?:\s*HandlerFn<void>;/);
  });

  it('PingResponse case is split out of the silent-consume case + fires the handler', () => {
    expect(SMH_TS).toMatch(/case GameEventType\.PingResponse:[\s\S]+?this\.handlers\.onPingResponse\?\.\(\);/);
  });

  it('PingResponse is NOT in the silent-consume case anymore', () => {
    const silentBlock = SMH_TS.match(/case GameEventType\.SetSquelchDB:[\s\S]+?break;/)?.[0] ?? '';
    expect(silentBlock).not.toContain('PingResponse');
  });

  it('pingRequest (network/GameActions) stamps the tracker and ships an empty PingRequest — behavioural', () => {
    // DEBT.acdebug-production-coupling — the heartbeat's sender moved from the
    // acDebug helper to GameActions; drive the real class with a real tracker.
    let t = 500;
    const tracker = new PingLatencyTracker(() => t);
    const sent: Array<[number, number]> = [];
    const actions = new GameActions(() => (type, payload) => { sent.push([type, payload.length]); return true; }, tracker);
    actions.pingRequest();
    expect(sent).toEqual([[GameActionType.PingRequest, 0]]);
    t = 900;
    expect(tracker.responseReceived()).toEqual({ latencyMs: 400, indicatorActive: true });
    // Before the ACE session exists nothing ships and nothing is stamped.
    const idle = new PingLatencyTracker(() => 0);
    new GameActions(() => null, idle).pingRequest();
    expect(idle.responseReceived()).toBeNull();
  });

  it('threshold (250ms) matches AC retail rubber-band feel', () => {
    expect(SERVER_LOAD_LATENCY_MS).toBe(250);
  });
});
