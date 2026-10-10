/**
 * GAP.51 — "Augmentation panel" is a WRONG PREMISE. End-of-retail AC had
 * NO dedicated interactive Augmentation panel. Augmentations are applied
 * by USING an augmentation gem (ACE AugmentationDevice), which triggers a
 * generic server CONFIRMATION dialog, then grants the aug and prints a
 * message ("You earned the <X> augmentation…"); current augs are shown in
 * a READ-ONLY report (CharacterInfoReport — already implemented).
 *
 * DAT: 31 "augmentation" strings, all gem-use confirmation/earned messages
 * ("You earned the Frenzy of the Slayer augmentation…", "You have
 * specialized Salvaging using the Ciandra's Essence Augmentation Gem"),
 * plus read-only report headers ("Luminance Augmentations:", "Enlightenment
 * Tiers:"). No "Augmentation Panel" title/tab; no augmentation LayoutDesc.
 *
 * ACE: AugmentationDevice.ActOnUse(activator, confirmed=false) enqueues a
 * Confirmation_Augmentation ("This action will augment your character with
 * <Name> and will cost <cost> available experience.") of
 * ConfirmationType.Augmentation (0x06). On confirm, DoAugmentation grants
 * the aug, consumes XP + the gem, and sends property updates.
 *
 * So the ONLY interactive augmentation UI in retail is item-use + the
 * generic confirmation dialog + the read-only report — all present in our
 * client (type-agnostic ConfirmationRequest handler → showConfirmationDialog
 * → ConfirmationResponse GameAction). This test proves an augmentation-type
 * confirmation (the real interactive path) round-trips through the shipped
 * ServerMessageHandler with the retail cost text — no panel needed.
 */
import { describe, it, expect } from 'vitest';
import { ServerMessageHandler } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { BinaryWriter, GameMessageOpcode, GameEventType } from '@ac/network';
import { ConfirmationType } from '@ac/shared';

function event(eventType: number, payload: Uint8Array) {
  return {
    type: 'event' as const,
    opcode: GameMessageOpcode.GameEvent as GameMessageOpcode.GameEvent,
    objectGuid: 0,
    sequence: 1,
    eventType,
    payload,
  };
}

function writeString16L(w: BinaryWriter, s: string): void {
  const bytes = new TextEncoder().encode(s);
  w.writeUInt16(bytes.length);
  w.writeBytes(bytes);
  const total = 2 + bytes.length;
  const rem = total % 4;
  if (rem !== 0) for (let i = 0; i < 4 - rem; i++) w.writeUInt8(0);
}

describe('GAP.51 — augmentation is gem-use + confirmation + read-only report (no panel)', () => {
  it('ConfirmationType.Augmentation is 0x06 (anchored to ACE ConfirmationType.cs)', () => {
    expect(ConfirmationType.Augmentation).toBe(0x06);
  });

  it('an augmentation-purchase ConfirmationRequest round-trips through the generic dialog handler', () => {
    const h = new ServerMessageHandler();
    let cap: { confirmationType: number; context: number; text: string } | null = null;
    h.setHandlers({ onConfirmationRequest: (d) => { cap = d as typeof cap; } });

    // The exact shape ACE AugmentationDevice.ActOnUse sends:
    // ConfirmationType u32 (Augmentation=6) + context u32 + String16L text.
    const w = new BinaryWriter(128);
    w.writeUInt32(ConfirmationType.Augmentation);
    w.writeUInt32(0x7000abcd); // context (aug device guid handle)
    const retailText =
      'This action will augment your character with Innate Strength and will cost 4,000,000,000 available experience.';
    writeString16L(w, retailText);

    h.handleMessage(event(GameEventType.ConfirmationRequest, w.toBuffer()));

    expect(cap).not.toBeNull();
    expect(cap!.confirmationType).toBe(0x06);
    expect(cap!.context).toBe(0x7000abcd);
    expect(cap!.text).toBe(retailText);
  });

  it('the aug confirmation is handled by the SAME generic path as other types (e.g. SwearAllegiance)', () => {
    // Proves the handler is type-agnostic: augmentation (6) and allegiance
    // (1) both surface identically — no aug-specific panel branch exists or
    // is needed.
    const h = new ServerMessageHandler();
    const seen: Array<{ confirmationType: number; text: string }> = [];
    h.setHandlers({ onConfirmationRequest: (d) => seen.push({ confirmationType: d.confirmationType, text: d.text }) });

    for (const [type, text] of [
      [ConfirmationType.SwearAllegiance, 'Swear allegiance to Lord Bob?'],
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
      { confirmationType: 0x06, text: 'This action will augment your character with Jack of All Trades.' },
    ]);
  });
});
