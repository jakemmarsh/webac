/**
 * FAITHFUL.53 — Inbound GameEvent coverage audit.
 *
 * Walks `reference/ACE/Source/ACE.Server/Network/GameEvent/Events/*.cs` to
 * enumerate every event class ACE can emit, maps each to its GameEventType,
 * then asserts our ServerMessageHandler has a handler-or-acknowledged-no-op
 * case for it. This is the inbound mirror of FAITHFUL.52's outbound diff.
 *
 * Two events are explicitly DEPRECATED in ACE source comments
 *   - GameEventInscriptionResponse (0x00C3) — "DEPRECIATED AND HAS NO HANDLER IN ACCLIENT"
 *   - GameEventFellowshipFellowUpdateDone (0x01C9) — "outdated message, not found in end of retail?"
 * A 1-to-1 faithful reproduction matches the original client by NOT having
 * parsers for them. We still need a no-op tolerant case in ServerMessageHandler
 * so a misbehaving non-stock server can't blow up the connection by emitting
 * one — that case is asserted by the deprecated-list test below.
 */
import { describe, it, expect, vi } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { GameEventType, GameMessageOpcode } from '@ac/network';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';

const REPO_ROOT = join(import.meta.dirname, '..');
const ACE_EVENTS_DIR = join(REPO_ROOT, 'reference/ACE/Source/ACE.Server/Network/GameEvent/Events');

const aceDirExists = aceReferenceExists(ACE_EVENTS_DIR);

/**
 * Behavioural dispatch probe: feed the REAL ServerMessageHandler a GameEvent
 * of `eventType` and report whether it reached a case. Unknown events fall to
 * the switch's `default: this.logUnhandled('event', …)`; a matched case
 * either parses (and may throw on the empty payload — caught and logged by
 * handleGameEvent) or is a deliberate no-op. Either way it is NOT unhandled.
 */
function isHandled(eventType: number): boolean {
  const h = new ServerMessageHandler();
  const unhandled: number[] = [];
  (h as unknown as { logUnhandled: (t: string, c: number) => void }).logUnhandled = (_t, c) => { unhandled.push(c); };
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    h.handleMessage({
      type: 'event', opcode: GameMessageOpcode.GameEvent, objectGuid: 0, sequence: 0,
      eventType, payload: new Uint8Array(0),
    });
  } finally { err.mockRestore(); warn.mockRestore(); }
  return unhandled.length === 0;
}

describe('isHandled probe sanity', () => {
  it('an event id with no case is reported unhandled; a real one is handled', () => {
    expect(isHandled(0xfff0)).toBe(false);
    expect(isHandled(GameEventType.UpdateHealth)).toBe(true);
  });
});

describe.skipIf(!aceDirExists)('FAITHFUL.53 — ACE GameEvent inbound coverage audit', () => {

  // Build [{className, eventTypeName}] for every Events/*.cs file
  const aceEventFiles = aceDirExists ? readdirSync(ACE_EVENTS_DIR).filter(f => f.endsWith('.cs')) : [];
  const aceClassEventPairs: Array<{ file: string; eventTypeName: string }> = [];
  for (const file of aceEventFiles) {
    const src = readFileSync(join(ACE_EVENTS_DIR, file), 'utf8');
    const m = src.match(/GameEventType\.([A-Za-z][A-Za-z0-9_]*)/);
    if (m) aceClassEventPairs.push({ file, eventTypeName: m[1] });
  }

  it('found ACE event class files (sanity)', () => {
    expect(aceEventFiles.length).toBeGreaterThan(80);
    expect(aceClassEventPairs.length).toBeGreaterThan(80);
  });

  // Map ACE-side event name → acjs GameEventType name. Most are identical, but a
  // few have naming-style differences in our enum file:
  const aceToAcjsNameMap: Record<string, string> = {
    AllegianceAllegianceUpdateDone: 'AllegianceUpdateDone',
    CharacterConfirmationDone: 'ConfirmationDone',
    CharacterConfirmationRequest: 'ConfirmationRequest',
    FellowshipFellowStatsDone: 'FellowshipStatsDone',
    FellowshipFellowUpdateDone: 'FellowshipUpdateDone',
    MiscPortalstormSubsided: 'MiscPortalStormSubsided',
    VendorInfoEvent: 'ApproachVendor',  // ACE alias; same opcode 0x0062
  };

  for (const { file, eventTypeName } of aceClassEventPairs) {
    const acjsName = aceToAcjsNameMap[eventTypeName] ?? eventTypeName;
    it(`ACE ${file} (GameEventType.${eventTypeName} → acjs.${acjsName}) has enum entry + handler case`, () => {
      // (1) Our enum has the event
      expect(Object.keys(GameEventType)).toContain(acjsName);
      // (2) Either an explicit case (parsed) OR a deliberate no-op acknowledgement
      const value = (GameEventType as unknown as Record<string, number>)[acjsName];
      expect(isHandled(value), `GameEventType.${acjsName} falls through to logUnhandled`).toBe(true);
    });
  }
});

describe('FAITHFUL.53 — deprecated-but-tolerated event list', () => {
  it('GetInscriptionResponse (0x00C3) is tolerated (per ACE: "depreciated and has no handler in acclient")', () => {
    expect(isHandled(GameEventType.GetInscriptionResponse)).toBe(true);
  });
  it('FellowshipUpdateDone (0x01C9) is tolerated (per ACE: "outdated message, not found in end of retail")', () => {
    expect(isHandled(GameEventType.FellowshipUpdateDone)).toBe(true);
  });
});
