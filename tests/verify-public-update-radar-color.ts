/**
 * FAITHFUL.344 — Apply visible-state PublicUpdatePropertyInt updates to
 * the mirrored ServerObject so observers see the change live.
 *
 * ACE emits `GameMessagePublicUpdatePropertyInt` (opcode 0x02CE) for
 * property changes that need to be visible to all nearby players, not
 * just the affected object's owner. The keys handled here:
 *
 *   PropertyInt.RadarBlipColor       — ACE AdvocateItem.cs:35,44 fires
 *     when an admin advocate-item activates / deactivates. The player's
 *     radar dot must flip to the new color immediately for nearby
 *     observers.
 *   PropertyInt.PlayerKillerStatus   — ACE Player_Death.cs:966,971,1018
 *     emits this on PK transitions (becoming a Player Killer after
 *     death etc.). GAP.64: this mirror feeds the examine/assess panel's
 *     PK-status row — it does NOT drive radar coloring (ACE sets a
 *     player's RadarColor only for Advocate/Lifestone overrides, and
 *     radarColorToTargetType keys off obj.radarColor, not this field).
 *   PropertyInt.UiEffects            — ACE ManaStone.cs:56,
 *     RecipeManager.cs:737 broadcast this when an item's magical-glow
 *     visual state changes (charged ↔ uncharged, recipe-result item).
 *   PropertyInt.Level                — FAITHFUL.384, ACE Player_Xp.cs
 *     broadcasts on every level-up / fellowship member join.
 *
 * Converted from a source-text pin (regex-matched raw main.ts source for
 * `case PropertyInt.X:` / `obj.field = val` strings) to a behavioral test:
 * this drives the real ServerMessageHandler.handleMessage() with a
 * synthetic ACE-shaped wire payload to verify the parser, and the real
 * exported applyPublicUpdatePropertyInt() routing function (extracted out
 * of main.ts's inline onPublicUpdatePropertyInt closure specifically so it
 * is independently testable) to verify the routing table main.ts's
 * consumer relies on (CLAUDE.md "Never Break Tests" — source-text pins
 * catch nothing).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { ServerMessageHandler, type PropertyUpdateData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { applyPublicUpdatePropertyInt, type ServerObject } from '../packages/renderer/src/world/ServerObjectManager.js';
import { GameMessageOpcode } from '@ac/network';
import { PropertyInt } from '@ac/shared';

function u8(v: number): Uint8Array {
  return new Uint8Array([v & 0xff]);
}
function u32(v: number): Uint8Array {
  return new Uint8Array([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff]);
}
function i32(v: number): Uint8Array {
  return u32(v >>> 0);
}
function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function makeServerObject(overrides: Partial<ServerObject> = {}): ServerObject {
  return {
    guid: 1,
    name: 'Test Object',
    radarColor: 0,
    ...overrides,
  } as unknown as ServerObject;
}

describe('ServerMessageHandler decodes a real GameMessagePublicUpdatePropertyInt payload', () => {
  let handler: ServerMessageHandler;
  const calls: PropertyUpdateData[] = [];

  beforeEach(() => {
    calls.length = 0;
    handler = new ServerMessageHandler();
    handler.setHandlers({ onPublicUpdatePropertyInt: (d) => calls.push(d) });
  });

  it('decodes seq(u8) + guid(u32) + property(u32) + value(int32) in ACE wire order', () => {
    // ACE GameMessagePublicUpdatePropertyInt.cs: seq(u8) + guid(u32) + property(u32) + value(int32)
    const payload = concat(
      u8(0x01),
      u32(0x50001234),
      u32(PropertyInt.RadarBlipColor),
      i32(3),
    );
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PublicUpdatePropertyInt, payload } as any);

    expect(calls).toHaveLength(1);
    expect(calls[0].guid).toBe(0x50001234);
    expect(calls[0].key).toBe(PropertyInt.RadarBlipColor);
    expect(calls[0].value).toBe(3);
  });

  it('decodes a negative int32 value correctly (sign-extended, not treated as unsigned)', () => {
    const payload = concat(u8(0x02), u32(0x50001234), u32(PropertyInt.UiEffects), i32(-1));
    handler.handleMessage({ type: 'direct', opcode: GameMessageOpcode.PublicUpdatePropertyInt, payload } as any);
    expect(calls[0].value).toBe(-1);
  });
});

describe('applyPublicUpdatePropertyInt routes visible properties to the mirrored ServerObject (FAITHFUL.344)', () => {
  it('RadarBlipColor updates obj.radarColor', () => {
    const obj = makeServerObject();
    applyPublicUpdatePropertyInt(obj, PropertyInt.RadarBlipColor, 5);
    expect(obj.radarColor).toBe(5);
  });

  it('PlayerKillerStatus updates obj.playerKillerStatus, and does NOT touch radarColor', () => {
    const obj = makeServerObject({ radarColor: 2 });
    applyPublicUpdatePropertyInt(obj, PropertyInt.PlayerKillerStatus, 1);
    expect(obj.playerKillerStatus).toBe(1);
    // ACE only flips RadarColor for Advocate/Lifestone overrides, not PK
    // transitions — radarColorToTargetType keys off obj.radarColor, so a
    // regression that routed PlayerKillerStatus into radarColor would
    // wrongly recolor every PK-flagged player's dot.
    expect(obj.radarColor).toBe(2);
  });

  it('UiEffects updates obj.uiEffects', () => {
    const obj = makeServerObject();
    applyPublicUpdatePropertyInt(obj, PropertyInt.UiEffects, 7);
    expect(obj.uiEffects).toBe(7);
  });

  it('Level updates obj.level', () => {
    const obj = makeServerObject();
    applyPublicUpdatePropertyInt(obj, PropertyInt.Level, 42);
    expect(obj.level).toBe(42);
  });

  it('an unhandled key is a no-op — does not throw and does not touch tracked fields', () => {
    const obj = makeServerObject({ radarColor: 9, playerKillerStatus: 0, uiEffects: 0, level: 1 });
    expect(() => applyPublicUpdatePropertyInt(obj, PropertyInt.MaxStackSize, 999)).not.toThrow();
    expect(obj.radarColor).toBe(9);
    expect(obj.playerKillerStatus).toBe(0);
    expect(obj.uiEffects).toBe(0);
    expect(obj.level).toBe(1);
  });
});
