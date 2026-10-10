/**
 * BUG.shortcut-bar-restore-dropped — the toolbar item-shortcut bar
 * assignments shipped in the login PlayerDescription were parsed only to
 * skip bytes, never applied.
 *
 * ACE writes the player's full toolbar shortcut-bar list (item quick-slots,
 * restored from `CharacterPropertiesShortcutBar`) into PlayerDescription
 * whenever `CharacterOptionDataFlag.Shortcut` is set — per
 * `GameEventPlayerDescription.cs:345-362` and `Shortcut.cs:44-56`. Each
 * entry is `Index` (u32, bar slot 0-8) + `ObjectId` (u32, the assigned
 * item's guid) + a `LayeredSpell` (`SpellId` u16 + `Layer` u16) — 12 bytes.
 *
 * Pre-fix, `PlayerDescriptionParser` read the leading count then did
 * `r.skip(shortcutCount * 12)` purely to stay byte-aligned for the fields
 * that follow (SpellLists8 etc.) — every Index/ObjectId/SpellId/Layer was
 * discarded and `PlayerDescriptionResult` had no `shortcuts` field at all.
 * Meanwhile the SAVE side (`gameActions.addShortcut`/`removeShortcut`,
 * `buildAddShortcutPayload`) was already fully wired with the identical
 * 12-byte format. Retail impact: a player who assigned items to the
 * item-shortcut toolbar slots saw them reset to empty on every login even
 * though the server still had the assignments.
 *
 * Fix: `PlayerDescriptionParser` now builds `result.shortcuts` (every
 * Index/ObjectId/SpellId/Layer record, in wire order) instead of skipping
 * the bytes. main.ts's `onPlayerDescription` handler consumes it by
 * resolving each entry's `objectId` against `playerState.inventory` and
 * calling `gameUI.setItemShortcutIcon(index, iconDid, title)` — thin glue
 * over already-tested APIs (`InventoryManager.getItem`,
 * `buildItemIconElement`). The behavioral coverage below targets the
 * actual bug surface: the binary parsing itself (byte layout, per-entry
 * field order, alignment into the fields that follow).
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePlayerDescription } from '../packages/renderer/src/network/PlayerDescriptionParser';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const ACE_SHORTCUT = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Structure/Shortcut.cs'), 'utf-8');
const ACE_LAYERED_SPELL = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Structure/LayeredSpell.cs'), 'utf-8');
const ACE_PD = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameEvent/Events/GameEventPlayerDescription.cs'), 'utf-8');

const CHAR_OPT_SHORTCUT = 0x00000001;

class PayloadWriter {
  private buf = new ArrayBuffer(65536);
  private dv = new DataView(this.buf);
  private p = 0;
  u32(v: number): this { this.dv.setUint32(this.p, v, true); this.p += 4; return this; }
  u16(v: number): this { this.dv.setUint16(this.p, v, true); this.p += 2; return this; }
  bytes(): Uint8Array { return new Uint8Array(this.buf, 0, this.p); }
}

// Minimal header every payload needs before optionFlags: propertyFlags(0) +
// weenieType(0) + vectorFlags(0, no attributes/skills/spells/enchantments) +
// _hasHealth(0, unconditional per PlayerDescriptionParser).
function header(w: PayloadWriter): void {
  w.u32(0).u32(0).u32(0).u32(0);
}

describe('BUG.shortcut-bar-restore-dropped — ACE ground truth', () => {
  it('ACE Shortcut.ReadShortcut/Write reads/writes Index + ObjectId + LayeredSpell, in that order', () => {
    expect(ACE_SHORTCUT).toMatch(/shortcut\.Index = reader\.ReadUInt32\(\)/);
    expect(ACE_SHORTCUT).toMatch(/shortcut\.ObjectId = reader\.ReadUInt32\(\)/);
    expect(ACE_SHORTCUT).toMatch(/shortcut\.Spell = reader\.ReadLayeredSpell\(\)/);
  });

  it('ACE LayeredSpell is SpellId (ushort) + Layer (ushort) — 4 bytes', () => {
    expect(ACE_LAYERED_SPELL).toMatch(/layeredSpell\.SpellId = reader\.ReadUInt16\(\)/);
    expect(ACE_LAYERED_SPELL).toMatch(/layeredSpell\.Layer = reader\.ReadUInt16\(\)/);
  });

  it('GameEventPlayerDescription gates the shortcut list on CharacterOptionDataFlag.Shortcut', () => {
    expect(ACE_PD).toMatch(/CharacterOptionDataFlag\.Shortcut/);
  });
});

describe('BUG.shortcut-bar-restore-dropped — default result (no Shortcut bit)', () => {
  it('shortcuts defaults to an empty array when optionFlags has no Shortcut bit', () => {
    const w = new PayloadWriter();
    header(w);
    w.u32(0);       // optionFlags — no Shortcut bit
    w.u32(0);       // CharacterOptions1
    w.u32(0);       // single 0u placeholder (no SpellLists8)

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.shortcuts).toEqual([]);
  });

  it('shortcuts is empty (not undefined) when the field is never touched', () => {
    // Regression guard: pre-fix there was no `shortcuts` field on the result
    // type at all — this would have been `undefined`, not `[]`.
    const w = new PayloadWriter();
    header(w);
    w.u32(0).u32(0).u32(0);
    const result = parsePlayerDescription(w.bytes());
    expect(Array.isArray(result!.shortcuts)).toBe(true);
  });
});

describe('BUG.shortcut-bar-restore-dropped — full roundtrip', () => {
  it('parses N shortcut entries (Index, ObjectId, SpellId, Layer) in wire order', () => {
    const w = new PayloadWriter();
    header(w);
    w.u32(CHAR_OPT_SHORTCUT); // optionFlags = Shortcut only
    w.u32(0);                 // CharacterOptions1
    w.u32(3);                 // shortcutCount
    // Slot 0: a plain item shortcut, no spell.
    w.u32(0).u32(0x50001234).u16(0).u16(0);
    // Slot 3: another item, non-contiguous index (bar slots aren't
    // necessarily filled in order).
    w.u32(3).u32(0x50005678).u16(0).u16(0);
    // Slot 8: last valid bar slot, with a non-zero LayeredSpell (ACE marks
    // this "unused?" on the Shortcut class but still writes it on the wire).
    w.u32(8).u32(0x5000ABCD).u16(1234).u16(1);
    w.u32(0); // single 0u placeholder (no SpellLists8)

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.shortcuts).toHaveLength(3);
    expect(result!.shortcuts[0]).toEqual({ index: 0, objectId: 0x50001234, spellId: 0, layer: 0 });
    expect(result!.shortcuts[1]).toEqual({ index: 3, objectId: 0x50005678, spellId: 0, layer: 0 });
    expect(result!.shortcuts[2]).toEqual({ index: 8, objectId: 0x5000ABCD, spellId: 1234, layer: 1 });
  });

  it('parsing shortcuts keeps the cursor aligned for the SpellLists8 section that follows', () => {
    const w = new PayloadWriter();
    header(w);
    w.u32(CHAR_OPT_SHORTCUT | 0x400); // Shortcut | SpellLists8
    w.u32(0);                          // CharacterOptions1
    w.u32(2);                          // shortcutCount
    w.u32(0).u32(0x11111111).u16(0).u16(0);
    w.u32(1).u32(0x22222222).u16(0).u16(0);
    // SpellLists8: bar 0 has one spell, bars 1-7 empty.
    w.u32(1).u32(999);
    for (let i = 1; i < 8; i++) w.u32(0);

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.shortcuts).toHaveLength(2);
    expect(result!.shortcuts[1]).toEqual({ index: 1, objectId: 0x22222222, spellId: 0, layer: 0 });
    // If the shortcut loop mis-sized a single entry, this would read as
    // garbage (or throw) instead of the true bar-0 spell list.
    expect(result!.spellBars[0]).toEqual([999]);
  });

  it('a zero shortcutCount reads no entries and leaves the cursor untouched', () => {
    const w = new PayloadWriter();
    header(w);
    w.u32(CHAR_OPT_SHORTCUT);
    w.u32(0);
    w.u32(0); // shortcutCount = 0
    w.u32(0); // single 0u placeholder (no SpellLists8)

    const result = parsePlayerDescription(w.bytes());
    expect(result).not.toBeNull();
    expect(result!.shortcuts).toEqual([]);
  });
});
