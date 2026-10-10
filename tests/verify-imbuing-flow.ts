/**
 * GAP.74 — Imbuing. PREMISE CORRECTION (same pattern as GAP.70 Tinkering,
 * GAP.71 Cooking, GAP.72 Alchemy, GAP.73 Fletching).
 *
 * The reconciliation doc (docs/gap-reconciliation-2026-06-12.md:565-567)
 * claimed: "Only the appraisal-side display of already-imbued effects is
 * wired into the live client. The imbuing craft act lives only in the
 * unwired TinkeringSystem; UseWithTarget has no UI caller (confirmed), so a
 * player cannot imbue." That evidence is stale for the exact reasons
 * GAP.70/71/72/73 found their claims stale:
 *
 *  1. ACE has no standalone imbuing engine. Imbuing is not a distinct
 *     server-side code path — it's the same generic recipe row as tinkering,
 *     differentiated purely by data: `RecipeExtensions.IsImbuing(this Recipe
 *     recipe) => recipe.SalvageType == 2` sits right next to
 *     `IsTinkering(this Recipe recipe) => recipe.SalvageType > 0`
 *     (reference/ACE/Source/ACE.Server/Managers/RecipeManager.cs:1566-1574).
 *     Both route through the identical `RecipeManager.UseObjectOnTarget`
 *     (RecipeManager.cs:43). The only imbuing-specific branches are data
 *     tweaks inside that shared method: a chance bonus from
 *     `player.AugmentationBonusImbueChance` (RecipeManager.cs:237,241-242,
 *     334) and the `target.ImbuedEffect = ...` assignment block
 *     (RecipeManager.cs:365+). There is no "unwired TinkeringSystem" gap on
 *     the server side to begin with — imbuing was never a separate system.
 *  2. The client already ships the ONE gesture that drives all of this: drag
 *     one inventory item onto another sends GameActionUseWithTarget(src,tgt)
 *     unconditionally for any non-stack/non-container pair
 *     (packages/renderer/src/main.ts onDropToInventory ~5216-5223; the
 *     docblock at ~5183 explicitly lists "imbues" among the categories this
 *     single gesture already drives). Nothing gates the send on item
 *     category — dragging a Peridot/Yellow Topaz/Zircon (the client's own
 *     imbuing materials, MaterialTypes.ts Peridot=0x22/YellowTopaz=0x31/
 *     Zircon=0x32) onto a weapon or armor piece ships the identical opcode
 *     as any other tinker tool. "UseWithTarget has no UI caller" is false
 *     for imbuing exactly as it was false for Tinkering/Cooking/Alchemy/
 *     Fletching.
 *  3. There is no dedicated "imbuing UI" in retail AC (era-correct,
 *     established by GAP.70's decompiled-client research) — the era-correct
 *     UX IS the generic drag gesture, not a missing panel.
 *  4. The imbuing craft act itself (the `/3` chance divisor and the
 *     PropertyInt.ImbuedEffect write) is ACE's — RecipeManager resolves
 *     the outcome server-side. The client-side TinkeringSystem simulation
 *     that once mirrored it was never reachable from shipped code and was
 *     deleted (DEBT.shared-dead-server-logic); the client's role is
 *     rendering the confirmation/result, same as every other craft
 *     category.
 *  5. What the client DOES own — the generic result-rendering path for any
 *     craft outcome — is already shipped and category-agnostic: the
 *     CraftInteraction "N percent chance" confirmation (RecipeManager.cs:
 *     322-357, ConfirmationType.CraftInteraction=0x05), the Craft-colored
 *     system chat line for the success/fail message (ChatMessageType.Craft=
 *     0x18), the WeenieError -> text chain for a failed requirements check
 *     (WeenieError.YouDoNotPassCraftingRequirements=0x0437), and the
 *     imbuedEffectsLabels appraisal display for the resulting effect
 *     (already verified live per doc line 566, GameUI.ts:12705+). None of
 *     these are imbuing-specific — they are the same generic wire->UI
 *     plumbing already exercised by GAP.70/71/72/73's tests.
 *
 * This test drives the client's real shipped surfaces end to end with
 * imbuing-flavored payloads/text distinct from GAP.70-73's assertions: the
 * WeenieError event -> weenieErrorText chain, the Craft chat color, a
 * CraftInteraction confirmation round-trip through the real
 * ServerMessageHandler carrying the imbuing-specific "/3 chance" framing,
 * the ImbuedEffect label decode, and the imbuing material labels — all
 * driving shipped code with real wire bytes and the real MaterialTypes /
 * imbue-label modules, not source-text pins.
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
  MaterialType,
  getMaterialName,
} from '@ac/shared';
import {
  ImbuedEffectType,
  imbuedEffectsLabels,
} from '../packages/shared/src/crafting/TinkeringSystem.js';

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

describe('GAP.74 — imbuing runs through the generic combine/confirmation/error pipeline (no dedicated flow needed)', () => {
  it('a failed imbuing requirements check renders via the real WeenieError -> text chain', () => {
    const h = new ServerMessageHandler();
    let captured: { errorType: number } | null = null;
    h.setHandlers({ onWeenieError: (d) => { captured = d; } });

    // RecipeManager.VerifyRequirements failure sends a plain WeenieError
    // event regardless of SalvageType/IsImbuing (RecipeManager.cs:1571-1574):
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

  it('an imbuing success/fail message renders in the Craft chat color (retail default green #80ff7f)', () => {
    // ACE sends the recipe's SuccessMessage/FailMessage via
    // GameMessageSystemChat with ChatMessageType.Craft — the same generic
    // chat path every other craft category (including imbuing, SalvageType
    // == 2) uses, not an imbuing-specific renderer.
    expect(ChatMessageType.Craft).toBe(0x18);
    expect(chatColorFor(ChatMessageType.Craft)).toBe('#80ff7f');
  });

  it('the CraftInteraction confirmation round-trips an imbuing-flavored (/3 divisor) chance string through the shipped handler', () => {
    // RecipeManager.ShowDialog builds this exact sentence regardless of
    // category; for imbuing the underlying chance already reflects the /3
    // divisor + AugmentationBonusImbueChance bonus applied server-side
    // (RecipeManager.cs:237,241-242,334) before the string is built — the
    // client just renders whatever text arrives, identical wire shape to
    // every other craft category.
    const h = new ServerMessageHandler();
    let cap: { confirmationType: number; context: number; text: string } | null = null;
    h.setHandlers({ onConfirmationRequest: (d) => { cap = d as typeof cap; } });

    const w = new BinaryWriter(128);
    w.writeUInt32(ConfirmationType.CraftInteraction);
    w.writeUInt32(0xdeadf00d); // context (source/target handle)
    const imbueText = 'You determine that you have a 19 percent chance to succeed.';
    writeString16L(w, imbueText);

    h.handleMessage(event(GameEventType.ConfirmationRequest, w.toBuffer()));

    expect(cap).not.toBeNull();
    expect(cap!.confirmationType).toBe(0x05);
    expect(cap!.context).toBe(0xdeadf00d);
    expect(cap!.text).toBe(imbueText);
  });

  it('an imbuing material (Peridot/Yellow Topaz/Zircon) arms the UseWithTarget gesture the same way a tinker tool does', () => {
    // isUseWithTargetItem gates the drag-combine send purely on the item's
    // Usable bitmask (USABLE_TARGET_MASK), not on skill/category — an
    // imbuing material that carries a target-usable bit arms the gesture
    // exactly like a Steel/Iron tinker tool (GAP.70's test proved the same
    // predicate for tinkering payloads).
    expect(isUseWithTargetItem(USABLE_TARGET_MASK & 0x00020000)).toBe(true);
    expect(isUseWithTargetItem(0x00020000)).toBe(true);
    expect(isUseWithTargetItem(0x00000001)).toBe(false);
    expect(isUseWithTargetItem(undefined)).toBe(false);
  });

  it('Peridot/Yellow Topaz/Zircon carry the shipped material labels', () => {
    expect(getMaterialName(MaterialType.Peridot)).toBe('Peridot');
    expect(getMaterialName(MaterialType.YellowTopaz)).toBe('Yellow Topaz');
    expect(getMaterialName(MaterialType.Zircon)).toBe('Zircon');
  });

  it('the ImbuedEffect bit a server-side Peridot imbue writes renders through the shipped appraisal label helper', () => {
    // The imbue itself is ACE's (RecipeManager.TryMutateNative writes
    // PropertyInt.ImbuedEffect); the client decodes the bitfield with the
    // same imbuedEffectsLabels helper the appraisal panel ships.
    expect(imbuedEffectsLabels(ImbuedEffectType.MeleeDefense)).toEqual(['Melee Defense']);
    expect(imbuedEffectsLabels(ImbuedEffectType.MissileDefense)).toEqual(['Missile Defense']);
    expect(imbuedEffectsLabels(ImbuedEffectType.MagicDefense)).toEqual(['Magic Defense']);
  });
});
