/**
 * SpellCharge1999 — the 1999 client's per-spell Charge (VISUAL.ac1999-spell-charge), the
 * release-era mechanic the spell examine panel prints as "Charge: %u%%".
 *
 * From the 1999 client.exe (reference/ac1999 kb structures/SpellBookPage, live-confirmed there):
 *  - SpellBookPage +0x4, seeded by the 0x0013 spellbook table (UnPack @ 0x005ed9a0, no clamp);
 *    a page made for a new spell starts at 1.0 (ctor @ 0x005176c0).
 *  - 0x4C UpdateSpell for a spell the book already holds decays it: charge × 0.92
 *    (SpellBookPage_DecayCharge @ 0x005ed8c0), clamped to [0.5, 1.0] (0x005f10d0).
 *  - Global_Loop regenerates every page at least 5 s apart: charge + dt / 120, clamped.
 *  - InqSpellCharge (0x00517820): the page's charge, 1.0 for a spell not in the book.
 *  - ExamineSpell @ 0x00511110 prints ftol(charge × 100 + 0.5) as "Charge: %u%%".
 */

export const SPELL_CHARGE_1999 = Object.freeze({
  min: 0.5, max: 1.0, decay: 0.92, regenPerSecond: 1 / 120, regenStepSeconds: 5,
});

const clamp = (c: number): number => Math.min(SPELL_CHARGE_1999.max, Math.max(SPELL_CHARGE_1999.min, c));

export class SpellCharge1999 {
  private readonly charges = new Map<number, number>();
  private lastRegen: number | null = null;

  /** The login spellbook: each spell's charge as the server sent it (not clamped, as UnPack). */
  seed(charges: ReadonlyMap<number, number>, nowSec: number): void {
    this.charges.clear();
    for (const [id, c] of charges) this.charges.set(id, c);
    this.lastRegen = nowSec;
  }

  /** 0x4C UpdateSpell: a known spell decays, a new one joins at full charge. */
  updateSpell(spellId: number, nowSec: number): void {
    this.regen(nowSec);
    const c = this.charges.get(spellId);
    this.charges.set(spellId, c === undefined ? 1.0 : clamp(c * SPELL_CHARGE_1999.decay));
  }

  /** 0x4D RemoveSpell: the page goes. */
  removeSpell(spellId: number): void {
    this.charges.delete(spellId);
  }

  /** Global_Loop's regeneration, applied at least 5 s apart. */
  regen(nowSec: number): void {
    if (this.lastRegen === null) { this.lastRegen = nowSec; return; }
    const dt = nowSec - this.lastRegen;
    if (dt < SPELL_CHARGE_1999.regenStepSeconds) return;
    for (const [id, c] of this.charges) this.charges.set(id, clamp(c + dt * SPELL_CHARGE_1999.regenPerSecond));
    this.lastRegen = nowSec;
  }

  /** InqSpellCharge: the spell's charge, 1.0 when the book lacks it. */
  inq(spellId: number, nowSec: number): number {
    this.regen(nowSec);
    return this.charges.get(spellId) ?? 1.0;
  }
}

/** ExamineSpell's line: "Charge: %u%%" of ftol(charge × 100 + 0.5). */
export function spellChargeText1999(charge: number): string {
  return `Charge: ${Math.trunc(charge * 100 + 0.5)}%`;
}
