/**
 * GAP.70 — Tinkering (Weapon/Magic/Item/Armor/Salvage). PREMISE CORRECTION.
 *
 * The reconciliation claimed "the useWithTarget send wrapper has ZERO callers,
 * so a player cannot trigger tinkering" and "the 5 categories are not surfaced
 * as distinct UI flows." BOTH are stale/wrong (like GAP.68's premise):
 *
 *  1. Tinkering IS initiable. Dragging one item onto another (or arm-and-
 *     select) ships GameActionUseWithTarget (main.ts drag-combine ~5221 +
 *     consumePendingUseWithTarget ~2445). That single gesture drives the whole
 *     server-side combine category — "salvage→bag, tinker tool→item, key→lock,
 *     gem-setting, mana stones, imbues" (main.ts docblock ~5182). An item arms
 *     the gesture when isUseWithTargetItem(usable) is true.
 *  2. There is NO 5-tab crafting UI in retail — that is era-correct. Tinkering
 *     EXECUTION is server-authoritative: the client sends UseWithTarget, ACE
 *     RecipeManager picks the tinkering skill by (tool material, target), rolls
 *     success, applies bonuses, increments NumItemsTinkered, and sends the
 *     result. The client does not compute outcomes or choose a category.
 *  3. The one interactive client surface is the CONFIRMATION dialog: before a
 *     tinker ACE sends Confirmation_CraftInteration (ConfirmationType
 *     CraftInteraction = 0x05, RecipeManager.cs:339) carrying "You determine
 *     that you have a N percent chance to succeed." The client surfaces it via
 *     the type-agnostic ConfirmationRequest handler → showConfirmationDialog →
 *     ConfirmationResponse GameAction (main.ts:8416) — already wired, same path
 *     as augmentation (GAP.51) and allegiance.
 *
 * The standalone TinkeringSystem module is un-wired solo-sim (never imported
 * into renderer/network); it is not the live path, so its community-formula
 * success-chance is not what governs a real tinker.
 *
 * This test drives the shipped client surface: the arming predicate + the
 * CraftInteraction confirmation round-trip through the real ServerMessageHandler.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode, GameEventType } from '@ac/network';
import { ConfirmationType, isUseWithTargetItem, USABLE_TARGET_MASK } from '@ac/shared';

function event(eventType: number, payload: Uint8Array) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    objectGuid: 0, sequence: 1, eventType, payload,
  };
}
function writeString16L(w: BinaryWriter, s: string): void {
  const bytes = new TextEncoder().encode(s);
  w.writeUInt16(bytes.length);
  w.writeBytes(bytes);
  const rem = (2 + bytes.length) % 4;
  if (rem !== 0) for (let i = 0; i < 4 - rem; i++) w.writeUInt8(0);
}

describe('GAP.70 — tinkering is UseWithTarget + a CraftInteraction confirmation (no 5-tab UI)', () => {
  it('ConfirmationType.CraftInteraction is 0x05 (anchored to ACE ConfirmationType.cs)', () => {
    expect(ConfirmationType.CraftInteraction).toBe(0x05);
  });

  it('an item usable-on-a-target arms the UseWithTarget gesture (tinkering is initiable)', () => {
    // A salvage bag / tinker tool carries a usable flag in USABLE_TARGET_MASK.
    expect(isUseWithTargetItem(USABLE_TARGET_MASK & 0x00010000)).toBe(true);
    expect(isUseWithTargetItem(0x00010000)).toBe(true); // a bit inside the target mask
    // A plain non-targeting usable (low bits only) does NOT arm the gesture.
    expect(isUseWithTargetItem(0x00000001)).toBe(false);
    expect(isUseWithTargetItem(0)).toBe(false);
    expect(isUseWithTargetItem(undefined)).toBe(false);
  });

  it('the tinker CraftInteraction confirmation round-trips through the shipped handler', () => {
    const h = new ServerMessageHandler();
    let cap: { confirmationType: number; context: number; text: string } | null = null;
    h.setHandlers({ onConfirmationRequest: (d) => { cap = d as typeof cap; } });

    // Exact shape ACE RecipeManager sends before a tinker:
    // ConfirmationType u32 (CraftInteraction=5) + context u32 + String16L text.
    const w = new BinaryWriter(128);
    w.writeUInt32(ConfirmationType.CraftInteraction);
    w.writeUInt32(0x5000beef); // context (source/target handle)
    const retailText = 'You determine that you have a 74 percent chance to succeed.';
    writeString16L(w, retailText);

    h.handleMessage(event(GameEventType.ConfirmationRequest, w.toBuffer()));

    expect(cap).not.toBeNull();
    expect(cap!.confirmationType).toBe(0x05);
    expect(cap!.context).toBe(0x5000beef);
    expect(cap!.text).toBe(retailText);
  });

  it('CraftInteraction is handled by the SAME generic path as other confirmation types', () => {
    // Proves no tinker-specific panel branch exists or is needed — craft (5),
    // augmentation (6) and allegiance (1) all surface identically.
    const h = new ServerMessageHandler();
    const seen: Array<{ confirmationType: number; text: string }> = [];
    h.setHandlers({ onConfirmationRequest: (d) => seen.push({ confirmationType: d.confirmationType, text: d.text }) });

    for (const [type, text] of [
      [ConfirmationType.SwearAllegiance, 'Swear allegiance to Lord Bob?'],
      [ConfirmationType.CraftInteraction, 'You determine that you have a 12 percent chance to succeed.'],
      [ConfirmationType.Augmentation, 'This action will augment your character with Jack of All Trades.'],
    ] as const) {
      const w = new BinaryWriter(128);
      w.writeUInt32(type);
      w.writeUInt32(0x1000);
      writeString16L(w, text);
      h.handleMessage(event(GameEventType.ConfirmationRequest, w.toBuffer()));
    }

    expect(seen).toEqual([
      { confirmationType: 0x01, text: 'Swear allegiance to Lord Bob?' },
      { confirmationType: 0x05, text: 'You determine that you have a 12 percent chance to succeed.' },
      { confirmationType: 0x06, text: 'This action will augment your character with Jack of All Trades.' },
    ]);
  });
});
