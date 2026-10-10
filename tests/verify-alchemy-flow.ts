/**
 * GAP.72 — Alchemy. PREMISE CORRECTION (same pattern as GAP.70 Tinkering and
 * GAP.71 Cooking).
 *
 * The reconciliation doc (docs/gap-reconciliation-2026-06-12.md:557-559)
 * claimed Alchemy is "missing": "No alchemy crafting flow client-side: no
 * ingredient-combine UI, no recipe data wiring, UseWithTarget never sent."
 * That evidence is stale for the same reasons GAP.70/71 found their claims
 * stale:
 *
 *  1. ACE has no per-category recipe engine. RecipeManager.UseObjectOnTarget
 *     (reference/ACE/Source/ACE.Server/Managers/RecipeManager.cs:43) is the
 *     single execution path for every UseWithTarget combine; the recipe row's
 *     own `Skill` field (picked up around RecipeManager.cs:179
 *     player.ConvertToMoASkill(playerSkill.Skill)) determines which skill —
 *     Cooking, Fletching, Tinkering, Alchemy, whatever the source/target wcid
 *     pair resolves to via GetRecipe's cook_book lookup — governs the combine.
 *     There is no Alchemy-specific server branch to wire up client-side; the
 *     client never touches recipe rows directly.
 *  2. The client already ships the ONE gesture that drives all of this: drag
 *     one inventory item onto another sends GameActionUseWithTarget(src,tgt)
 *     unconditionally for any non-stack/non-container pair
 *     (packages/renderer/src/main.ts onDropToInventory ~5217, docblock ~5183
 *     explicitly lists "mana stones" among the categories this single
 *     gesture already drives). Nothing gates the send on item category, so
 *     "UseWithTarget never sent" is false for Alchemy exactly as it was false
 *     for Tinkering and Cooking.
 *  3. There is no dedicated "ingredient-combine UI" in retail AC for any
 *     craft category (era-correct, established by GAP.70's decompiled-client
 *     research) — the era-correct UX IS the generic drag gesture.
 *  4. CraftTool.HandleActionUseOnTarget (reference/ACE/Source/ACE.Server/
 *     WorldObjects/CraftTool.cs:31-52) special-cases Aetheria mana stones
 *     (Aetheria.IsAetheriaManaStone/IsAetheria) BEFORE falling back to the
 *     generic RecipeManager path — but that is the separate ToD-era Aetheria
 *     socketing system, not the traditional Alchemy skill (potions, gems,
 *     healing kits) this task targets. Ordinary alchemy ingredients are plain
 *     WorldObjects with no CraftTool override, so they fall straight into
 *     WorldObject.HandleActionUseOnTarget -> RecipeManager.UseObjectOnTarget
 *     (reference/ACE/Source/ACE.Server/WorldObjects/WorldObject_Use.cs:66-68),
 *     the exact same generic path Cooking/Tinkering already proved wired.
 *  5. What the client DOES own — the generic result-rendering path for any
 *     craft outcome — is already shipped and category-agnostic: the
 *     CraftInteraction "N percent chance" confirmation (RecipeManager.cs:
 *     322-357, ConfirmationType.CraftInteraction=0x05), the Craft-colored
 *     system chat line for the success/fail message (ChatMessageType.Craft=
 *     0x18), and the WeenieError -> text chain for a failed requirements
 *     check (WeenieError.YouDoNotPassCraftingRequirements=0x0437,
 *     RecipeManager.cs VerifyRequirements failure path, RecipeManager.cs:77).
 *     None of these are Alchemy-specific — they are the same generic
 *     wire->UI plumbing already exercised by GAP.70/71's tests, which is
 *     exactly why no dedicated "alchemy flow" needed to be built.
 *
 * This test drives the client's real shipped surfaces end to end with
 * alchemy-flavored payloads/text distinct from GAP.70/71's assertions: the
 * WeenieError event -> weenieErrorText chain, the Craft chat color, and a
 * CraftInteraction confirmation round-trip through the real
 * ServerMessageHandler — all with real wire bytes, not source-text pins.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode, GameEventType } from '@ac/network';
import { ConfirmationType, ChatMessageType, chatColorFor, WeenieError, weenieErrorText, isUseWithTargetItem, USABLE_TARGET_MASK } from '@ac/shared';

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

describe('GAP.72 — alchemy runs through the generic combine/confirmation/error pipeline (no dedicated flow needed)', () => {
  it('a failed alchemy requirements check renders via the real WeenieError -> text chain', () => {
    const h = new ServerMessageHandler();
    let captured: { errorType: number } | null = null;
    h.setHandlers({ onWeenieError: (d) => { captured = d; } });

    // RecipeManager.VerifyRequirements failure sends a plain WeenieError event
    // regardless of the recipe's skill (Cooking/Tinkering/Alchemy/etc.):
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

  it('an alchemy success/fail message renders in the Craft chat color (retail default green #80ff7f)', () => {
    // ACE sends the recipe's SuccessMessage/FailMessage (e.g. an alchemy
    // ingredient combine's "You successfully create..." / a wasted-reagent
    // failure line) via GameMessageSystemChat with ChatMessageType.Craft —
    // the same generic chat path every other craft category uses, not an
    // alchemy-specific renderer.
    expect(ChatMessageType.Craft).toBe(0x18);
    expect(chatColorFor(ChatMessageType.Craft)).toBe('#80ff7f');
  });

  it('the CraftInteraction confirmation round-trips an alchemy-flavored chance string through the shipped handler', () => {
    const h = new ServerMessageHandler();
    let cap: { confirmationType: number; context: number; text: string } | null = null;
    h.setHandlers({ onConfirmationRequest: (d) => { cap = d as typeof cap; } });

    // RecipeManager.ShowDialog builds this exact sentence regardless of
    // category — alchemy rolls the same GetRecipeChance formula as cooking,
    // tinkering, salvage, etc. (RecipeManager.cs:159-198), so the wire shape
    // is identical.
    const w = new BinaryWriter(128);
    w.writeUInt32(ConfirmationType.CraftInteraction);
    w.writeUInt32(0xa1cbe57e); // context (source/target handle)
    const alchemyText = 'You determine that you have a 53 percent chance to succeed.';
    writeString16L(w, alchemyText);

    h.handleMessage(event(GameEventType.ConfirmationRequest, w.toBuffer()));

    expect(cap).not.toBeNull();
    expect(cap!.confirmationType).toBe(0x05);
    expect(cap!.context).toBe(0xa1cbe57e);
    expect(cap!.text).toBe(alchemyText);
  });

  it('an alchemy reagent (usable-on-target) arms the UseWithTarget gesture the same way a tinker tool does', () => {
    // isUseWithTargetItem gates the drag-combine send purely on the item's
    // Usable bitmask (USABLE_TARGET_MASK), not on skill/category — an
    // alchemy flask or reagent that carries a target-usable bit arms the
    // gesture exactly like a tinker tool or salvage bag (GAP.70's test
    // proved the same predicate for tinkering payloads).
    expect(isUseWithTargetItem(USABLE_TARGET_MASK & 0x00020000)).toBe(true);
    expect(isUseWithTargetItem(0x00020000)).toBe(true); // a bit inside the target mask
    // A plain non-targeting usable (low bits only) does NOT arm the gesture.
    expect(isUseWithTargetItem(0x00000001)).toBe(false);
    expect(isUseWithTargetItem(0)).toBe(false);
    expect(isUseWithTargetItem(undefined)).toBe(false);
  });
});
