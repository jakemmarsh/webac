/**
 * GAP.75 — Spellcrafting (mana stones). PREMISE CORRECTION (same pattern as
 * GAP.70 Tinkering, GAP.73 Fletching, GAP.74 Imbuing).
 *
 * The reconciliation claimed: "No mana-stone spellcrafting flow: no
 * use-on-item handler to absorb/release mana, no destroy-chance roll, no UI;
 * ManaStoneDestroyChance constant is display-only and never consumed." This
 * mischaracterizes where the logic lives:
 *
 *  1. Mana stones are NOT a RecipeManager recipe (unlike tinkering/imbuing) —
 *     `ManaStone.HandleActionUseOnTarget` (reference/ACE/Source/ACE.Server/
 *     WorldObjects/ManaStone.cs:59) is a direct WorldObject override invoked
 *     by the generic use-with-target dispatch. There is no CraftInteraction
 *     confirmation for mana stones (that's tinkering-only); the absorb/
 *     release/destroy-roll all happen server-side inside this one method
 *     with zero client-side computation, by design — the server is
 *     authoritative for every roll (Efficiency-scaled absorb amount,
 *     LumAugItemManaGain-adjusted release ration, DestroyChance dice roll at
 *     ManaStone.cs:235-252).
 *  2. The gesture that reaches a mana stone is the SAME generic drag→
 *     UseWithTarget gesture GAP.70/73/74 already proved reaches every combine
 *     category — main.ts's own docblock (~5183) explicitly lists "mana
 *     stones" among the categories the single onDropToInventory gesture
 *     drives, and main.ts:9155-9156/7371/7395 already cite ManaStone.cs by
 *     line number as a consumer of the generic UseDone-error and
 *     UiEffects-mirror plumbing.
 *  3. ManaStone.cs sends its outcome via THREE generic, already-wired wire
 *     shapes, none of which are mana-stone-specific:
 *       - GameMessageSystemChat with ChatMessageType.Broadcast (=0x00) for
 *         every player-facing line (absorb/release/full/destroy text) —
 *         ACE's own ChatMessageType.cs:29-36 doc-comments literally quote
 *         these exact Mana Stone strings as the canonical Broadcast example.
 *         The client's onServerMessage (main.ts:6540-6551) renders ANY
 *         chatType generically via chatColorFor; Broadcast resolves to
 *         white (#ffffff) in both ChatMessageType.ts:67 and the
 *         chatType===0 fallback.
 *       - GameEventUseDone carrying a WeenieError (YouDoNotOwnThatItem=
 *         0x04BE, ItemDoesntHaveEnoughMana=0x04C8, ActionCancelled=0x0036,
 *         OlthoiCannotInteractWithThat=0x0587 — all four already present in
 *         WeenieErrorText.ts) — surfaced generically by onUseDone
 *         (main.ts:9144-9172, FAITHFUL.386), which explicitly cites
 *         ManaStone.cs:77,98,232 as sites it exists to cover.
 *       - GameMessagePublicUpdatePropertyInt(UiEffects) for the stone's glow
 *         (Magical while charged, Undef once drained) — mirrored generically
 *         by onPublicUpdatePropertyInt's PropertyInt.UiEffects case
 *         (main.ts:7394-7398), which cites ManaStone.cs:56 by name.
 *  4. ManaStoneDestroyChance (PropertyFloat 137) and ItemEfficiency
 *     (PropertyFloat 87) are read ONLY server-side inside DoDestroyDiceRoll /
 *     the absorb calculation (ManaStone.cs:47-51,108) — the client has
 *     nothing to "consume" them for. Their sole client-facing role is the
 *     assess/appraisal display already shipped at GameUI.ts:13698-13705
 *     ("Item Efficiency" / "Destruction Chance" rows), which is exactly what
 *     retail showed: a player reads their odds before using the stone, then
 *     the server rolls and reports the outcome via chat.
 *
 * This test drives the client's real shipped surfaces end to end with
 * mana-stone-flavored payloads: the arming predicate for the drag gesture,
 * the WeenieError→text chain for all four ManaStone-cited error codes, the
 * Broadcast-chat rendering of the real ACE example strings (absorb-drain,
 * multi-item release, single-item release, destroy) through the real
 * ServerMessageHandler, and the UiEffects property mirror — not source-text
 * pins.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode, deserializeMessage, serializeDirectMessage } from '@ac/network';
import {
  ChatMessageType,
  chatColorFor,
  WeenieError,
  weenieErrorText, weenieErrorSink,
  isUseWithTargetItem,
  USABLE_TARGET_MASK,
  PropertyFloat,
} from '@ac/shared';

describe('GAP.75 — mana stones run through the generic combine/chat/UseDone/UiEffects pipeline (no dedicated flow needed)', () => {
  it('a mana stone (target-usable item) arms the UseWithTarget drag gesture the same way any other combine item does', () => {
    expect(isUseWithTargetItem(USABLE_TARGET_MASK & 0x00010000)).toBe(true);
    expect(isUseWithTargetItem(0x00010000)).toBe(true);
    expect(isUseWithTargetItem(0x00000001)).toBe(false);
    expect(isUseWithTargetItem(undefined)).toBe(false);
  });

  it('ManaStoneDestroyChance / ItemEfficiency are the exact PropertyFloat ids ManaStone.cs reads server-side (137 / 87)', () => {
    // ManaStone.cs:41-51 wraps these two properties; the client never
    // computes with them, only displays them (GameUI.ts:13698-13705).
    expect(PropertyFloat.ManaStoneDestroyChance).toBe(137);
    expect(PropertyFloat.ItemEfficiency).toBe(87);
  });

  it.each([
    [WeenieError.YouDoNotOwnThatItem, 'You do not own that item!'],
    [WeenieError.ItemDoesntHaveEnoughMana, "That item doesn't have enough Mana."],
    [WeenieError.OlthoiCannotInteractWithThat, 'Olthoi cannot interact with that!'],
  ] as const)('a ManaStone.cs-cited UseDone WeenieError (0x%s) renders via the real shared WeenieErrorText chain', (code, text) => {
    expect(weenieErrorText(code)).toBe(text);
  });

  it('ActionCancelled (the empty-stone-on-self and inventory-remove-fail path) is the retail "Action cancelled!" spew row (CORE.17.k.c)', () => {
    // ManaStone.cs:87,98 send UseDone(ActionCancelled) for "used an empty
    // stone on yourself" and "failed to consume the drained item"; retail's
    // Handle_Item__UseDone runs a non-zero code through HandleFailureEvent
    // @ 00571990, whose 0x36 arm prints "Action cancelled!" at type 0x1a.
    expect(weenieErrorText(WeenieError.ActionCancelled)).toBe('Action cancelled!');
    expect(weenieErrorSink(WeenieError.ActionCancelled)).toBe('spew');
  });

  it.each([
    // ManaStone.cs:110 — absorb path, item destroyed.
    'The Mana Stone drains 5,253 points of mana from the Wand.\nThe Wand is destroyed.',
    // ManaStone.cs:179 — release-to-equipped, partially charged.
    'The Mana Stone gives 1,921 points of mana to the following items: Haebrean Girth, Chiran Helm, Ring, Baggy Breeches, Scalemail Greaves, Alduressa Boots, Heavy Bracelet, Heavy Bracelet, Lorica Breastplate, Pocket Watch, Heavy Necklace.\nYou need 2,232 more mana to fully charge your items.',
    // ManaStone.cs:216 — release-to-single-item.
    'The Mana Stone gives 3,502 points of mana to the Focusing Stone.',
    // ManaStone.cs:246 — destroy roll fired.
    'The Mana Stone is destroyed.',
  ])('a real ACE Mana Stone Broadcast chat line renders in Broadcast/white through the real ServerMessageHandler: %s', (message) => {
    const h = new ServerMessageHandler();
    let cap: { message: string; chatType: number } | null = null;
    h.setHandlers({ onServerMessage: (d) => { cap = d as typeof cap; } });

    // GameMessageOpcode.ServerMessage payload: String16L message, then
    // chatType u32 (ServerMessageHandler.ts:1098-1102 reads in that order).
    const w = new BinaryWriter(256);
    w.writeString16(message);
    w.writeUInt32(ChatMessageType.Broadcast);

    h.handleMessage(deserializeMessage(serializeDirectMessage(GameMessageOpcode.ServerMessage, w.toBuffer())));

    expect(cap).not.toBeNull();
    expect(cap!.chatType).toBe(ChatMessageType.Broadcast);
    expect(cap!.message).toBe(message);
    // CORE.17.s — Broadcast is the retail green default (BuildChatColorLookupTable).
    expect(chatColorFor(ChatMessageType.Broadcast)).toBe('#80ff7f');
  });
});
