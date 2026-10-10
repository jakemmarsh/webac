/**
 * BUG.game-event-catch-loses-event-type — handleGameEvent()'s unguarded
 * switch cases (UpdateHealth, InventoryPutObjInContainer, WieldObject,
 * InventoryPutObjectIn3D, etc.) had no top-level try/catch, so a mid-parse
 * throw propagated two layers up to ClientConnection.emit()'s per-listener
 * catch — which only logs the generic ConnectionEvent kind ('gameEvent'),
 * never the specific GameEventType that actually threw. Every one of the
 * ~104 GameEventType values collapsed to the same content-free
 * "Listener error for gameEvent" log line.
 *
 * Fix (packages/renderer/src/network/ServerMessageHandler.ts):
 * handleGameEvent() now wraps its dispatch in its own try/catch — matching
 * the ~16 cases in the same switch that already self-guard — and logs
 * `GameEventType[eventType] ?? eventType` plus objectGuid before
 * swallowing, so the failure is diagnosable without re-instrumenting.
 *
 * Drives the real ServerMessageHandler.handleMessage() with a
 * deliberately truncated UpdateHealth GameEvent payload — never a
 * source-grep pin.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { GameEventType, GameMessageOpcode, BinaryWriter } from '@ac/network';

let seq = 400;
function event(eventType: GameEventType, objectGuid: number, payload: Uint8Array) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    sequence: seq++,
    eventType,
    objectGuid,
    payload,
  };
}

describe('handleGameEvent error diagnostics (BUG.game-event-catch-loses-event-type)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onUpdateHealth: (d) => calls.push(d) });
  });

  it('a well-formed UpdateHealth payload still parses normally (baseline, no regression)', () => {
    const w = new BinaryWriter(8);
    w.writeUInt32(0x50001234);
    w.writeFloat32(0.5);
    handler.handleMessage(event(GameEventType.UpdateHealth, 0x50001234, w.toBuffer()));

    expect(calls).toHaveLength(1);
    expect(calls[0].guid).toBe(0x50001234);
    expect(calls[0].healthFraction).toBeCloseTo(0.5);
  });

  it('a truncated UpdateHealth payload is swallowed, not thrown, and logs the specific event type + objectGuid', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => {
      handler.handleMessage(event(GameEventType.UpdateHealth, 0x5000abcd, new Uint8Array(0)));
    }).not.toThrow();

    expect(calls).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [logged] = errorSpy.mock.calls[0];
    // Pre-fix, this diagnostic would only ever say the generic event kind
    // 'gameEvent' — never which of ~104 GameEventType values threw.
    expect(logged).toContain('UpdateHealth');
    expect(logged).not.toContain('undefined');
    expect(logged).toContain(String(0x5000abcd));

    errorSpy.mockRestore();
  });

  it('a throw in one unguarded case does not affect handling of a subsequent unrelated event', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    handler.handleMessage(event(GameEventType.UpdateHealth, 1, new Uint8Array(0)));
    expect(calls).toHaveLength(0);

    const w = new BinaryWriter(8);
    w.writeUInt32(0x50009999);
    w.writeFloat32(1);
    handler.handleMessage(event(GameEventType.UpdateHealth, 0x50009999, w.toBuffer()));

    expect(calls).toHaveLength(1);
    expect(calls[0].guid).toBe(0x50009999);

    errorSpy.mockRestore();
  });
});
