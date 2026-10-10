/**
 * BUG.identify-response-no-partial-recovery — handleIdentifyResponse()'s
 * single ~200-line try/catch had zero partial-result recovery, unlike
 * PlayerDescriptionParser's deliberate FAITHFUL.594-era fix (see that
 * file's `catch` block, which explicitly rebuilds level/totalExperience/
 * etc. from properties already parsed, comment "Return partial results").
 *
 * A throw anywhere in the 12 flag-gated appraisal sections discarded data
 * already parsed correctly, not just the offending field — retail impact:
 * right-clicking Examine on an item/creature and the appraisal panel
 * simply never updates (no properties, no armor/weapon stats), with only
 * a console.warn the player never sees.
 *
 * Fix (packages/renderer/src/network/ServerMessageHandler.ts,
 * handleIdentifyResponse): mirror PlayerDescriptionParser.ts — `result` is
 * mutated in place as each section parses, so on a mid-parse throw the
 * catch now still invokes onIdentifyResponse with whatever sections
 * finished before the throw, plus logs the reader's position/byteLength
 * for diagnosis.
 *
 * Drives the real ServerMessageHandler.handleMessage() with a
 * constructed IdentifyObjectResponse GameEvent payload — never a
 * source-grep pin.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameEventType, GameMessageOpcode } from '@ac/network';
import { IdentifyResponseFlags } from '@ac/shared';

let seq = 300;
function event(eventType: GameEventType, payload: Uint8Array) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    sequence: seq++,
    eventType,
    objectGuid: 0,
    payload,
  };
}

describe('IdentifyObjectResponse partial-result recovery (BUG.identify-response-no-partial-recovery)', () => {
  let handler: ServerMessageHandler;
  const calls: any[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onIdentifyResponse: (d) => calls.push(d) });
  });

  it('a well-formed payload still parses normally (baseline, no regression)', () => {
    const w = new BinaryWriter(64);
    w.writeUInt32(0x50001234); // guid
    w.writeUInt32(IdentifyResponseFlags.IntStatsTable); // flags
    w.writeUInt32(1); // success
    w.writeUInt16(1); // IntStatsTable count
    w.writeUInt16(0); // bucketSize
    w.writeUInt32(25); // PropertyInt.Level key
    w.writeInt32(42); // value
    handler.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    expect(calls).toHaveLength(1);
    expect(calls[0].guid).toBe(0x50001234);
    expect(calls[0].propertiesInt.get(25)).toBe(42);
    expect(calls[0].success).toBe(true);
  });

  it('the success uint32 is kept (a failed creature appraisal shows ??? / health-only rows)', () => {
    const w = new BinaryWriter(16);
    w.writeUInt32(0x80000100);
    w.writeUInt32(0);
    w.writeUInt32(0); // success = false
    handler.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));
    expect(calls[0].success).toBe(false);
  });

  it('a mid-section throw still surfaces the sections parsed before it, not nothing', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const w = new BinaryWriter(64);
    w.writeUInt32(0x50005678); // guid
    w.writeUInt32(IdentifyResponseFlags.IntStatsTable); // flags — only IntStatsTable claimed
    w.writeUInt32(1); // success
    w.writeUInt16(2); // IntStatsTable claims 2 entries...
    w.writeUInt16(0); // bucketSize
    w.writeUInt32(25); // entry 1: key (PropertyInt.Level)
    w.writeInt32(10); // entry 1: value — fully readable
    w.writeUInt32(50); // entry 2: key only — buffer ends here, value read throws

    handler.handleMessage(event(GameEventType.IdentifyObjectResponse, w.toBuffer()));

    // Pre-fix: the throw during entry 2's value read discarded the whole
    // result — onIdentifyResponse was never called and entry 1 (already
    // parsed correctly) was lost along with it.
    expect(calls).toHaveLength(1);
    expect(calls[0].guid).toBe(0x50005678);
    expect(calls[0].flags).toBe(IdentifyResponseFlags.IntStatsTable);
    expect(calls[0].propertiesInt.get(25)).toBe(10);
    expect(calls[0].propertiesInt.size).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('a throw before guid/flags are even read never calls the handler and never throws uncaught', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(() => {
      handler.handleMessage(event(GameEventType.IdentifyObjectResponse, new Uint8Array(0)));
    }).not.toThrow();
    expect(calls).toHaveLength(0);
    warnSpy.mockRestore();
  });
});
