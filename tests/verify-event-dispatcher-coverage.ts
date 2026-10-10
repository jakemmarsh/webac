/**
 * FAITHFUL.172 — GameEvent dispatcher coverage drift guard.
 *
 * Sister to FAITHFUL.168 (which covered the direct-message dispatcher).
 * This test walks the ACE GameEvent class hierarchy for every concrete
 * `class GameEventX : GameEventMessage { ... base(GameEventType.Y) ... }`
 * pair, then asserts every Y that ACE actually emits has a dispatcher
 * case in ServerMessageHandler.ts's handleGameEvent switch.
 *
 * The set of "ACE actually emits this" is derived from grepping
 * `new GameEventX(` references across the ACE.Server source tree.
 */
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { GameEventType, GameMessageOpcode } from '@ac/network';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

const REPO = resolve(__dirname, '..');
const ACE_SERVER = resolve(REPO, 'reference/ACE/Source/ACE.Server');
const ACE_EVT_DIR = resolve(ACE_SERVER, 'Network/GameEvent/Events');

const aceExists = aceReferenceExists(ACE_SERVER);

function listFiles(dir: string, suffix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(full, suffix));
    else if (entry.name.endsWith(suffix)) out.push(full);
  }
  return out;
}

function gatherACEEmittedEventClasses(): Set<string> {
  const re = /new (GameEvent[A-Z][A-Za-z0-9]+)\s*\(/g;
  const out = new Set<string>();
  for (const file of listFiles(ACE_SERVER, '.cs')) {
    if (file.includes('/GameEvent/Events/')) continue; // skip the class defs themselves
    const src = readFileSync(file, 'utf8');
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) out.add(m[1]);
  }
  return out;
}

function gatherACEEventTypeMap(): Map<string, number> {
  // Each GameEventX.cs file declares `base(GameEventType.Y, ...)` — pull
  // (X, Y) pairs so we can map ACE class name to the canonical event type.
  const re = /class (GameEvent[A-Z][A-Za-z0-9]+)[\s\S]+?base\(GameEventType\.([A-Z][A-Za-z0-9]+)/;
  const out = new Map<string, number>();
  for (const file of listFiles(ACE_EVT_DIR, '.cs')) {
    const src = readFileSync(file, 'utf8');
    const m = src.match(re);
    if (!m) continue;
    const evtName = m[2] as keyof typeof GameEventType;
    const evtValue = GameEventType[evtName];
    if (typeof evtValue === 'number') out.set(m[1], evtValue);
  }
  return out;
}

/**
 * Behavioural: feed the REAL ServerMessageHandler one GameEvent per
 * GameEventType value (zero-filled payload) and record which event types
 * reach the dispatch switch's `default:` → logUnhandled. handleGameEvent
 * catches per-event parse errors, so a dummy payload never masks a case.
 */
function gatherHandledEvents(): Set<number> {
  const h = new ServerMessageHandler();
  const unhandled = new Set<number>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (h as any).logUnhandled = (type: string, code: number) => { if (type === 'event') unhandled.add(code); };
  const quiet = [vi.spyOn(console, 'log').mockImplementation(() => {}), vi.spyOn(console, 'warn').mockImplementation(() => {}),
    vi.spyOn(console, 'error').mockImplementation(() => {})];
  const out = new Set<number>();
  try {
    for (const v of Object.values(GameEventType)) {
      if (typeof v !== 'number') continue;
      try {
        h.handleMessage({ type: 'event', opcode: GameMessageOpcode.GameEvent, objectGuid: 0x50000001, sequence: 1, eventType: v, payload: new Uint8Array(512) });
      } catch { /* handled path threw on the dummy payload — the case exists */ }
      if (!unhandled.has(v)) out.add(v);
    }
  } finally {
    for (const q of quiet) q.mockRestore();
  }
  return out;
}

describe.skipIf(!aceExists)('GameEvent dispatcher coverage drift guard', () => {
  let emitted: Set<string>;
  let classToType: Map<string, number>;
  let handled: Set<number>;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    emitted = gatherACEEmittedEventClasses();
    classToType = gatherACEEventTypeMap();
    handled = gatherHandledEvents();
  });

  it('found a reasonable number of ACE-emitted GameEvent classes (>= 60)', () => {
    expect(emitted.size).toBeGreaterThanOrEqual(60);
  });

  it('found a reasonable number of dispatcher case branches (>= 50)', () => {
    expect(handled.size).toBeGreaterThanOrEqual(50);
  });

  it('every ACE-emitted GameEvent class has a dispatcher case in handleGameEvent', () => {
    // Some events ACE emits don't strictly need a dispatcher case (e.g. pure
    // ACK responses with no payload-bearing semantics, or events the client
    // can safely ignore). Track ALL gaps and require zero — if a future audit
    // reveals one that's truly noise, document it via an allowlist here
    // rather than skip the test silently.
    const ALLOWLIST: ReadonlySet<string> = new Set([
      // Allegiance subsystem batch events: these arrive in groups and the
      // dispatcher relies on the AllegianceInfo / AllegianceLogin master
      // events to assemble state. The per-record sub-events are noise on the
      // wire for our consumer.
      // (None currently — keep this empty and re-evaluate if/when needed.)
    ]);

    const missing: string[] = [];
    for (const className of emitted) {
      if (ALLOWLIST.has(className)) continue;
      const evtValue = classToType.get(className);
      if (evtValue === undefined) continue; // class has no matching event type in Events dir
      if (!handled.has(evtValue)) {
        missing.push(`${className} (event type 0x${evtValue.toString(16).toUpperCase().padStart(4, '0')})`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('FAITHFUL.157-167 newly-handled events are still covered (regression guard)', () => {
    // Spot-check that the sweep's added cases weren't accidentally removed.
    expect(handled.has(GameEventType.SalvageOperationsResult)).toBe(true);
    expect(handled.has(GameEventType.HouseProfile)).toBe(true);
    expect(handled.has(GameEventType.MagicDispelEnchantment)).toBe(true);
    expect(handled.has(GameEventType.QueryAgeResponse)).toBe(true);
    expect(handled.has(GameEventType.AllegianceInfoResponse)).toBe(true);
  });
});

describe('GameEvent dispatcher probe self-check (runs without reference/ACE)', () => {
  it('the probe distinguishes handled from unhandled event types', () => {
    const handled = gatherHandledEvents();
    expect(handled.has(GameEventType.UpdateHealth)).toBe(true);
    expect(handled.has(GameEventType.HouseProfile)).toBe(true);
    const h = new ServerMessageHandler();
    let logged = false;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (h as any).logUnhandled = () => { logged = true; };
    h.handleMessage({ type: 'event', opcode: GameMessageOpcode.GameEvent, objectGuid: 0, sequence: 0, eventType: 0xDEAD, payload: new Uint8Array(8) });
    expect(logged).toBe(true);
  });
});
