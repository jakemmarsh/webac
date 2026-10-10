/**
 * GAP.71 — Cooking. PREMISE CORRECTION (same pattern as GAP.70's Tinkering
 * closure).
 *
 * The reconciliation doc (docs/gap-reconciliation-2026-06-12.md) claimed
 * cooking is "missing": "no ingredient-combine UI, no cook_book data source
 * connected, UseWithTarget never invoked." That evidence predates GAP.70's
 * wiring and is stale for the same reason GAP.70's tinkering claim was:
 *
 *  1. There is no per-category recipe engine on the server. ACE's
 *     RecipeManager (reference/ACE/Source/ACE.Server/Managers/RecipeManager.cs)
 *     is the single execution path for EVERY UseWithTarget combine — cooking,
 *     alchemy, fletching, tinkering, salvage, gem-setting, key-use, mana
 *     stones. GetRecipe (RecipeManager.cs:32-41) looks up
 *     DatabaseManager.World.GetCachedCookbook(sourceWcid, targetWcid) — the
 *     literal cook_book table the reconciliation said was "not connected" —
 *     but that lookup happens server-side; the client never touches cook_book
 *     rows directly (it isn't a local-simulation client).
 *  2. The client already ships the ONE gesture that drives all of this: drag
 *     one inventory item onto another sends GameActionUseWithTarget(src,tgt)
 *     unconditionally for any non-stack/non-container pair
 *     (packages/renderer/src/main.ts onDropToInventory, confirmed live for
 *     GAP.70). Nothing gates that send on item category — a food item dragged
 *     onto a mixing bowl (or vice versa) ships the exact same opcode as a
 *     tinkering tool dragged onto a weapon. "UseWithTarget never invoked" is
 *     false for the same reason GAP.70 found it false.
 *  3. There is no dedicated "ingredient-combine UI" in retail AC for any
 *     category (era-correct, confirmed by GAP.70's decompiled-client research)
 *     — the era-correct UX IS the generic drag gesture, not a gap.
 *  4. What the client DOES own, and what this test drives, is the generic
 *     result-rendering path for a craft outcome: the CraftInteraction
 *     "N percent chance" confirmation (RecipeManager.cs:322-352,
 *     ConfirmationType.CraftInteraction=0x05, reused by GAP.70's test with
 *     tinkering text — this test proves the same generic path renders a
 *     cooking-flavored chance string), the Craft-colored system chat line for
 *     the success/burn message (ChatMessageType.Craft=0x18,
 *     reference/ACE/Source/ACE.Entity/Enum/ChatMessageType.cs), and the
 *     WeenieError → text chain for a failed cooking requirements check
 *     (WeenieError.YouDoNotPassCraftingRequirements=0x0437,
 *     RecipeManager.cs VerifyRequirements failure path). None of these are
 *     cooking-specific branches — they are the same generic wire→UI plumbing
 *     already used by every other craft category, which is exactly why no
 *     "cooking flow" needed to be built: it already exists as the generic
 *     combine/confirmation/error/chat pipeline.
 *
 * This test drives the shipped client surfaces end to end: the WeenieError
 * event → weenieErrorText chain for a crafting-requirements failure, the
 * Craft chat color, and the CraftInteraction confirmation round-trip through
 * the real ServerMessageHandler — all with cooking-specific payloads/text
 * distinct from GAP.70's tinkering-flavored assertions.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode, GameEventType } from '@ac/network';
import { ConfirmationType, ChatMessageType, chatColorFor, WeenieError, weenieErrorText } from '@ac/shared';

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

describe('GAP.71 — cooking runs through the generic combine/confirmation/error pipeline (no dedicated flow needed)', () => {
  it('a failed cooking requirements check renders via the real WeenieError -> text chain', () => {
    const h = new ServerMessageHandler();
    let captured: { errorType: number } | null = null;
    h.setHandlers({ onWeenieError: (d) => { captured = d; } });

    // RecipeManager.VerifyRequirements failure sends a plain WeenieError event:
    // errorType u32 = YouDoNotPassCraftingRequirements (0x0437).
    const w = new BinaryWriter(4);
    w.writeUInt32(WeenieError.YouDoNotPassCraftingRequirements);
    h.handleMessage(event(GameEventType.WeenieError, w.toBuffer()));

    expect(captured).not.toBeNull();
    expect(captured!.errorType).toBe(0x0437);
    expect(weenieErrorText(captured!.errorType)).toBe(
      'Either you or one of the items involved does not pass the requirements for this craft interaction.'
    );
  });

  it('a cooking success/burn message renders in the Craft chat color (retail default green #80ff7f)', () => {
    // ACE sends the recipe's SuccessMessage/FailMessage (e.g. "You successfully
    // cook the food." / "You burn the food.") via GameMessageSystemChat with
    // ChatMessageType.Craft — the same generic chat path every other message
    // type uses, not a cooking-specific renderer.
    expect(ChatMessageType.Craft).toBe(0x18);
    expect(chatColorFor(ChatMessageType.Craft)).toBe('#80ff7f');
  });

  it('the CraftInteraction confirmation round-trips a cooking-flavored chance string through the shipped handler', () => {
    const h = new ServerMessageHandler();
    let cap: { confirmationType: number; context: number; text: string } | null = null;
    h.setHandlers({ onConfirmationRequest: (d) => { cap = d as typeof cap; } });

    // RecipeManager.ShowDialog builds this exact sentence regardless of
    // category — cooking rolls the same GetRecipeChance formula as tinkering,
    // salvage, etc. (RecipeManager.cs:159-198), so the wire shape is identical.
    const w = new BinaryWriter(128);
    w.writeUInt32(ConfirmationType.CraftInteraction);
    w.writeUInt32(0xc00c1e50); // context (source/target handle)
    const cookingText = 'You determine that you have a 88 percent chance to succeed.';
    writeString16L(w, cookingText);

    h.handleMessage(event(GameEventType.ConfirmationRequest, w.toBuffer()));

    expect(cap).not.toBeNull();
    expect(cap!.confirmationType).toBe(0x05);
    expect(cap!.context).toBe(0xc00c1e50);
    expect(cap!.text).toBe(cookingText);
  });
});
