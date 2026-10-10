/**
 * GAP.73 — Fletching. PREMISE CORRECTION (same pattern as GAP.70 Tinkering,
 * GAP.71 Cooking, GAP.72 Alchemy).
 *
 * The reconciliation doc (docs/gap-reconciliation-2026-06-12.md:561-563)
 * claimed Fletching is "missing": "Fletching appears only as enum constants
 * (ace-enums.ts:59 Fletching=37; game-types.ts CraftFletchingBase/
 * Intermediate). No fletching logic, no arrowhead/shaft/nock handling, no
 * UI. UseWithTarget wrapper uncalled." That evidence is stale for the exact
 * reasons GAP.70/71/72 found their claims stale:
 *
 *  1. ACE has no per-category recipe engine, and grepping "fletch" across
 *     the entire ACE.Server source (reference/ACE/Source/ACE.Server/) turns
 *     up zero hits in RecipeManager.cs, Player_Crafting.cs, or CraftTool.cs
 *     — Fletching appears ONLY as a Skill enum value, spell names
 *     (FletchingMastery-prefixed / CANTRIPFLETCHINGPROWESS-prefixed), starterGear.json, and
 *     ItemType.CraftFletchingBase/Intermediate used generically in
 *     DeathItem.cs alongside every other craft-base item type. There is no
 *     "arrowhead/shaft/nock" server-side mini-system to wire up — arrow
 *     assembly is a plain cook_book recipe row like any other combine,
 *     executed by the same RecipeManager.UseObjectOnTarget
 *     (RecipeManager.cs:43) that drives cooking, alchemy, and tinkering.
 *     The recipe row's own `Skill` field determines Fletching governs a
 *     given combine; the client never branches on skill/category.
 *  2. The client already ships the ONE gesture that drives all of this: drag
 *     one inventory item onto another sends GameActionUseWithTarget(src,tgt)
 *     unconditionally for any non-stack/non-container pair
 *     (packages/renderer/src/main.ts onDropToInventory ~5217) — a fletching
 *     kit dragged onto a shaft/arrowhead pair ships the identical opcode as
 *     a tinker tool on a weapon or a food item on a mixing bowl.
 *     "UseWithTarget wrapper uncalled" is false for Fletching for the same
 *     reason it was false for Cooking/Alchemy/Tinkering.
 *  3. There is no dedicated "arrow assembly UI" in retail AC (era-correct,
 *     established by GAP.70's decompiled-client research) — the era-correct
 *     UX IS the generic drag gesture, not a missing panel.
 *  4. ItemType.CraftFletchingBase/CraftFletchingIntermediate already have
 *     shipped, category-agnostic label rendering via ItemTypeLabels
 *     (packages/shared/src/enums/ItemTypeLabels.ts:60-61), consumed by
 *     AssessmentSystem — the same appraisal path every other craft-base
 *     item type (tinkering, alchemy) already renders through. No
 *     fletching-specific appraisal branch was ever needed.
 *  5. What the client DOES own — the generic result-rendering path for any
 *     craft outcome — is already shipped and category-agnostic: the
 *     CraftInteraction "N percent chance" confirmation (RecipeManager.cs:
 *     322-357, ConfirmationType.CraftInteraction=0x05), the Craft-colored
 *     system chat line for the success/fail message (ChatMessageType.Craft=
 *     0x18), and the WeenieError -> text chain for a failed requirements
 *     check (WeenieError.YouDoNotPassCraftingRequirements=0x0437,
 *     RecipeManager.cs VerifyRequirements failure path). None of these are
 *     Fletching-specific — they are the same generic wire->UI plumbing
 *     already exercised by GAP.70/71/72's tests.
 *
 * This test drives the client's real shipped surfaces end to end with
 * fletching-flavored payloads/text distinct from GAP.70/71/72's assertions:
 * the WeenieError event -> weenieErrorText chain, the Craft chat color, a
 * CraftInteraction confirmation round-trip through the real
 * ServerMessageHandler, and the fletching craft-base item type labels — all
 * driving shipped code with real wire bytes, not source-text pins.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode, GameEventType } from '@ac/network';
import {
  ConfirmationType,
  ChatMessageType,
  chatColorFor,
  WeenieError,
  weenieErrorText,
  isUseWithTargetItem,
  USABLE_TARGET_MASK,
  ItemType,
  itemTypeLabel,
} from '@ac/shared';

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

describe('GAP.73 — fletching runs through the generic combine/confirmation/error pipeline (no dedicated flow needed)', () => {
  it('a failed fletching requirements check renders via the real WeenieError -> text chain', () => {
    const h = new ServerMessageHandler();
    let captured: { errorType: number } | null = null;
    h.setHandlers({ onWeenieError: (d) => { captured = d; } });

    // RecipeManager.VerifyRequirements failure sends a plain WeenieError event
    // regardless of the recipe's skill (Cooking/Alchemy/Tinkering/Fletching/
    // etc.): errorType u32 = YouDoNotPassCraftingRequirements (0x0437).
    const w = new BinaryWriter(4);
    w.writeUInt32(WeenieError.YouDoNotPassCraftingRequirements);
    h.handleMessage(event(GameEventType.WeenieError, w.toBuffer()));

    expect(captured).not.toBeNull();
    expect(captured!.errorType).toBe(0x0437);
    expect(weenieErrorText(captured!.errorType)).toBe(
      'Either you or one of the items involved does not pass the requirements for this craft interaction.'
    );
  });

  it('a fletching success/fail message renders in the Craft chat color (retail default green #80ff7f)', () => {
    // ACE sends the recipe's SuccessMessage/FailMessage (e.g. an arrow
    // assembly's "You successfully create..." / a broken-shaft failure
    // line) via GameMessageSystemChat with ChatMessageType.Craft — the same
    // generic chat path every other craft category uses, not a
    // fletching-specific renderer.
    expect(ChatMessageType.Craft).toBe(0x18);
    expect(chatColorFor(ChatMessageType.Craft)).toBe('#80ff7f');
  });

  it('the CraftInteraction confirmation round-trips a fletching-flavored chance string through the shipped handler', () => {
    // RecipeManager.ShowDialog builds this exact sentence regardless of
    // category — fletching rolls the same GetRecipeChance formula as
    // cooking, alchemy, tinkering, salvage, etc. (RecipeManager.cs:159-198),
    // so the wire shape is identical.
    const h = new ServerMessageHandler();
    let cap: { confirmationType: number; context: number; text: string } | null = null;
    h.setHandlers({ onConfirmationRequest: (d) => { cap = d as typeof cap; } });

    const w = new BinaryWriter(128);
    w.writeUInt32(ConfirmationType.CraftInteraction);
    w.writeUInt32(0xf1e7c40b); // context (source/target handle)
    const fletchingText = 'You determine that you have a 71 percent chance to succeed.';
    writeString16L(w, fletchingText);

    h.handleMessage(event(GameEventType.ConfirmationRequest, w.toBuffer()));

    expect(cap).not.toBeNull();
    expect(cap!.confirmationType).toBe(0x05);
    expect(cap!.context).toBe(0xf1e7c40b);
    expect(cap!.text).toBe(fletchingText);
  });

  it('a fletching craft-base item (shaft/arrowhead) arms the UseWithTarget gesture the same way a tinker tool does', () => {
    // isUseWithTargetItem gates the drag-combine send purely on the item's
    // Usable bitmask (USABLE_TARGET_MASK), not on skill/category — a
    // fletching component that carries a target-usable bit arms the gesture
    // exactly like a tinker tool, alchemy reagent, or cooking ingredient
    // (GAP.70/72's tests proved the same predicate for other categories).
    expect(isUseWithTargetItem(USABLE_TARGET_MASK & 0x00020000)).toBe(true);
    expect(isUseWithTargetItem(0x00020000)).toBe(true);
    expect(isUseWithTargetItem(0x00000001)).toBe(false);
    expect(isUseWithTargetItem(undefined)).toBe(false);
  });

  it('CraftFletchingBase / CraftFletchingIntermediate item types render through the shipped generic label path', () => {
    // ItemTypeLabels already carries both fletching craft-base types
    // (ItemTypeLabels.ts:60-61), consumed by AssessmentSystem's appraisal
    // panel the same way every other craft-base item type is — no
    // fletching-specific appraisal branch exists or is needed.
    expect(ItemType.CraftFletchingBase).toBe(0x02000000);
    expect(ItemType.CraftFletchingIntermediate).toBe(0x08000000);
    expect(itemTypeLabel(ItemType.CraftFletchingBase)).toBe('Fletching Base');
    expect(itemTypeLabel(ItemType.CraftFletchingIntermediate)).toBe('Fletching Intermediate');
  });
});
