/**
 * CORE.12 — combat toggle with a casting item equipped must enter MAGIC
 * combat mode (spell bar), not melee.
 *
 * Retail ground truth — decompiled EoL client:
 *   ClientCombatSystem::ToggleCombatMode @ 0056c8c0: from peace, enter
 *     GetDefaultCombatMode(false); from any combat mode, back to peace.
 *   ClientCombatSystem::GetDefaultCombatMode @ 0056b310:
 *     1. item at EquipMask 0x2500000 (MeleeWeapon|MissileWeapon|TwoHanded):
 *        pwd._combatUse == COMBAT_USE_MISSILE → MISSILE, else MELEE.
 *     2. else item at EquipMask 0x1000000 (Held — the caster slot) → MAGIC.
 *     3. else MELEE.
 * ACE agrees on the slot→mode map (Player_Inventory.cs TryShuffleStance:
 * MissileWeapon → Missile, Held → Magic, default Melee).
 *
 * Pre-fix, HUD.toggleCombatMode's preferredMode parameter defaulted to
 * Melee and NO caller ever passed anything else, so toggling with a wand
 * wielded entered melee mode and showed the melee bar. The wielded item's
 * CombatUse byte was also read-and-discarded by parseCreateObject, so the
 * bow→Missile branch had no data to run on.
 *
 * This suite drives the shipped code:
 *  1. getDefaultCombatMode (shared) — the pure retail rule.
 *  2. parseCreateObject — CombatUse captured off the wire, not discarded.
 *  3. GameUI.toggleCombatMode (happy-dom, real GameUI) — with a wand in
 *     the Held slot the toggle enters Magic; with a bow, Missile; with a
 *     sword, Melee; toggling again always returns to peace.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import {
  getDefaultCombatMode, CombatMode, CombatUse, EquipMask,
} from '../packages/shared/src/index.js';
import { parseCreateObject } from '../packages/network/src/MessageSerializer.js';

describe('CORE.12 — getDefaultCombatMode (retail GetDefaultCombatMode @ 0056b310)', () => {
  it('nothing wielded → Melee (unarmed combat)', () => {
    expect(getDefaultCombatMode([])).toBe(CombatMode.Melee);
  });

  it('caster in the Held slot → Magic', () => {
    expect(getDefaultCombatMode([
      { slot: EquipMask.Held, combatUse: CombatUse.None },
    ])).toBe(CombatMode.Magic);
  });

  it('missile weapon (CombatUse.Missile) → Missile', () => {
    expect(getDefaultCombatMode([
      { slot: EquipMask.MissileWeapon, combatUse: CombatUse.Missile },
    ])).toBe(CombatMode.Missile);
  });

  it('melee weapon in MeleeWeapon slot → Melee', () => {
    expect(getDefaultCombatMode([
      { slot: EquipMask.MeleeWeapon, combatUse: CombatUse.Melee },
    ])).toBe(CombatMode.Melee);
  });

  it('two-handed weapon → Melee (weapon-slot branch, non-missile)', () => {
    expect(getDefaultCombatMode([
      { slot: EquipMask.TwoHanded, combatUse: CombatUse.TwoHanded },
    ])).toBe(CombatMode.Melee);
  });

  it('shield alone is NOT a weapon slot → Melee via the fall-through, not the weapon branch', () => {
    // Shield (0x0200000) is outside the 0x2500000 weapon mask; retail falls
    // through to the final MELEE return.
    expect(getDefaultCombatMode([
      { slot: EquipMask.Shield, combatUse: CombatUse.Shield },
    ])).toBe(CombatMode.Melee);
  });

  it('weapon slot is checked BEFORE the Held slot (retail branch order)', () => {
    // Cannot co-occur in practice (same hand), but the rule is ordered:
    // the 0x2500000 check runs first in the decompiled function.
    expect(getDefaultCombatMode([
      { slot: EquipMask.Held, combatUse: CombatUse.None },
      { slot: EquipMask.MissileWeapon, combatUse: CombatUse.Missile },
    ])).toBe(CombatMode.Missile);
  });

  it('armor/jewelry in non-weapon slots does not affect the result', () => {
    expect(getDefaultCombatMode([
      { slot: EquipMask.ChestArmor, combatUse: CombatUse.None },
      { slot: EquipMask.FingerWearLeft, combatUse: CombatUse.None },
      { slot: EquipMask.Held, combatUse: CombatUse.None },
    ])).toBe(CombatMode.Magic);
  });
});

/* ─── parseCreateObject captures CombatUse off the wire ─── */

// Wire-format writer mirroring BinaryReader semantics (same helper shape as
// verify-bug-icon-overlay-underlay-dropped.ts).
class Writer {
  private bytes: number[] = [];
  private get pos(): number { return this.bytes.length; }
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  packed(v: number): this {
    if (v >= 0x8000) throw new Error('packed() helper only supports the 2-byte form');
    return this.u16(v);
  }
  align(boundary = 4): this {
    const rem = this.pos % boundary;
    if (rem !== 0) for (let i = 0; i < boundary - rem; i++) this.u8(0);
    return this;
  }
  string16(s: string): this {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    const totalRead = 2 + s.length;
    const rem = totalRead % 4;
    if (rem !== 0) for (let i = 0; i < 4 - rem; i++) this.u8(0);
    return this;
  }
  toUint8Array(): Uint8Array { return new Uint8Array(this.bytes); }
}

const WEENIE_FLAG_COMBAT_USE = 0x00000200; // WeenieHeaderFlag.CombatUse

function buildCreateObjectPayload(opts: { combatUse?: number }): Uint8Array {
  const w = new Writer();
  w.u32(0x80001234); // guid
  w.u8(0x11).u8(0).u8(0).u8(0); // modelByte, numSubPalettes, numTexChanges, numAnimParts
  w.align(4);
  w.u32(0); // physFlags
  w.u32(0); // physicsState
  for (let i = 0; i < 9; i++) w.u16(0); // 9 sequence timestamps
  w.align(4);
  w.u32(opts.combatUse !== undefined ? WEENIE_FLAG_COMBAT_USE : 0); // weenieFlags
  w.string16('Sylvan Bow'); // name
  w.packed(300); // weenieClassId
  w.packed(1); // iconId
  w.u32(0); // itemType
  w.u32(0); // objectDescFlags (no second header)
  w.align(4);
  // No earlier conditional weenie field is gated on: CombatUse is the only
  // flag bit set, so the sbyte follows immediately.
  if (opts.combatUse !== undefined) w.u8(opts.combatUse & 0xff);
  w.align(4);
  return w.toUint8Array();
}

describe('CORE.12 — parseCreateObject captures CombatUse (was read-and-discarded)', () => {
  it('reads the CombatUse sbyte off the wire and returns it', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({ combatUse: CombatUse.Missile }));
    expect(obj).not.toBeNull();
    expect(obj!.guid).toBe(0x80001234);
    expect(obj!.combatUse).toBe(CombatUse.Missile);
  });

  it('defaults combatUse to 0 (None) when the flag bit is absent', () => {
    const obj = parseCreateObject(buildCreateObjectPayload({}));
    expect(obj).not.toBeNull();
    expect(obj!.combatUse).toBe(CombatUse.None);
  });
});

/* ─── GameUI.toggleCombatMode picks the equipped-derived mode ─── */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.12 — GameUI.toggleCombatMode (behavioral, real GameUI)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  function equipOnly(slot: number, combatUse: number): void {
    ui.setInventoryData([], [{
      id: 0x80005555, weenieClassId: 100, name: 'test item', value: 0,
      burden: 0, stackSize: 1, maxStackSize: 1, stackable: false,
      containerId: 0, slot, combatUse,
    }], 0, 100);
  }

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('wand in the Held slot: toggle enters MAGIC, second toggle returns to peace', () => {
    ui.hudState.setCombatMode(CombatMode.NonCombat);
    equipOnly(EquipMask.Held, CombatUse.None);
    ui.toggleCombatMode();
    expect(ui.hudState.combatMode).toBe(CombatMode.Magic);
    ui.toggleCombatMode();
    expect(ui.hudState.combatMode).toBe(CombatMode.NonCombat);
  });

  it('bow in the MissileWeapon slot: toggle enters MISSILE', () => {
    ui.hudState.setCombatMode(CombatMode.NonCombat);
    equipOnly(EquipMask.MissileWeapon, CombatUse.Missile);
    ui.toggleCombatMode();
    expect(ui.hudState.combatMode).toBe(CombatMode.Missile);
    ui.toggleCombatMode();
  });

  it('sword in the MeleeWeapon slot: toggle enters MELEE', () => {
    ui.hudState.setCombatMode(CombatMode.NonCombat);
    equipOnly(EquipMask.MeleeWeapon, CombatUse.Melee);
    ui.toggleCombatMode();
    expect(ui.hudState.combatMode).toBe(CombatMode.Melee);
    ui.toggleCombatMode();
  });

  it('nothing equipped: toggle enters MELEE (unarmed)', () => {
    ui.hudState.setCombatMode(CombatMode.NonCombat);
    ui.setInventoryData([], [], 0, 100);
    ui.toggleCombatMode();
    expect(ui.hudState.combatMode).toBe(CombatMode.Melee);
    ui.toggleCombatMode();
  });

  it('toolbar combat button click routes through the default-mode rule AND notifies the server', () => {
    // Pre-fix the click handler flipped only local HUD state (never fired
    // onCombatModeChange), so a toolbar-click toggle desynced from ACE.
    ui.hudState.setCombatMode(CombatMode.NonCombat);
    equipOnly(EquipMask.Held, CombatUse.None);
    const sent: number[] = [];
    ui.callbacks.onCombatModeChange = (m: number) => sent.push(m);
    ui.renderHUD(); // toolbar (and its combat button) is built by renderHUD, not the constructor
    const btn = domWindow.document.getElementById('combat-mode-btn');
    expect(btn).not.toBeNull();
    btn.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.hudState.combatMode).toBe(CombatMode.Magic);
    expect(sent).toEqual([CombatMode.Magic]);
    btn.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.hudState.combatMode).toBe(CombatMode.NonCombat);
    expect(sent).toEqual([CombatMode.Magic, CombatMode.NonCombat]);
    ui.callbacks.onCombatModeChange = undefined;
  });

  // SWEEP1006B.message-reactions.combat-mode-requests-skip-client —
  // ClientCombatSystem::SetCombatMode @ 0056be30 (:354345-354354): while
  // CPlayerSystem::teleportInProgress is set, every user mode change (into
  // combat AND back to peace) is refused with a 0x1a line and nothing is sent.
  it('portal space: key toggle and toolbar click both refuse, in either direction, and send nothing', async () => {
    const { BusyCount, TeleportBusy } = await import('../packages/renderer/src/ui/BusyCount.js');
    const { combatModeChangeRefusal, raiseClientNotice } = await import('../packages/renderer/src/ui/ClientNotices.js');
    const teleport = new TeleportBusy(new BusyCount(() => {}));
    const spew: string[] = [];
    const surface = { displayErrorText: (t: string) => spew.push(t), addSystemMessage: () => {} };
    ui.callbacks.refuseCombatModeChange = () => {
      const n = combatModeChangeRefusal({ teleportInProgress: teleport.value });
      if (n) raiseClientNotice(surface as never, n);
      return n !== null;
    };
    const sent: number[] = [];
    ui.callbacks.onCombatModeChange = (m: number) => sent.push(m);
    ui.renderHUD();
    const btn = domWindow.document.getElementById('combat-mode-btn');
    equipOnly(EquipMask.MeleeWeapon, CombatUse.Melee);

    ui.hudState.setCombatMode(CombatMode.NonCombat);
    teleport.set(true);
    expect(ui.toggleCombatMode()).toBe(false);
    btn.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.hudState.combatMode).toBe(CombatMode.NonCombat);

    // Back to peace is refused too.
    teleport.set(false);
    ui.hudState.setCombatMode(CombatMode.Melee);
    teleport.set(true);
    expect(ui.toggleCombatMode()).toBe(false);
    expect(ui.hudState.combatMode).toBe(CombatMode.Melee);

    expect(sent).toEqual([]);
    expect(spew).toEqual([
      "You can't enter combat mode while in portal space",
      "You can't enter combat mode while in portal space",
      "You can't enter combat mode while in portal space",
    ]);

    // Out of portal space the toggle works again.
    teleport.set(false);
    expect(ui.toggleCombatMode()).toBe(true);
    expect(ui.hudState.combatMode).toBe(CombatMode.NonCombat);
    ui.callbacks.refuseCombatModeChange = undefined;
    ui.callbacks.onCombatModeChange = undefined;
  });

  // SetCombatMode @ 0056be30 :354322 — the user path asks CompatibleCombatMode
  // @ 0056a580 about the mode it is ENTERING (peace → the default mode, any
  // combat mode → peace), before the portal-space check.
  it('the toggle asks the refusal about the mode it would enter', () => {
    const asked: number[] = [];
    ui.callbacks.refuseCombatModeChange = (m: number) => { asked.push(m); return false; };
    equipOnly(EquipMask.MissileWeapon, CombatUse.Missile);
    ui.hudState.setCombatMode(CombatMode.NonCombat);
    expect(ui.toggleCombatMode()).toBe(true);
    expect(ui.hudState.combatMode).toBe(CombatMode.Missile);
    expect(ui.toggleCombatMode()).toBe(true);
    expect(asked).toEqual([CombatMode.Missile, CombatMode.NonCombat]);
    // A refusal leaves the mode alone.
    ui.callbacks.refuseCombatModeChange = () => true;
    expect(ui.toggleCombatMode()).toBe(false);
    expect(ui.hudState.combatMode).toBe(CombatMode.NonCombat);
    ui.callbacks.refuseCombatModeChange = undefined;
  });

  it('CompatibleCombatMode: mode vs the worn EquipMask bits, and the refusal line', async () => {
    const { compatibleCombatMode, combatModeName, incompatibleCombatModeRefusal } = await import('../packages/renderer/src/controllers/CombatModeChange.js');
    const MELEE = EquipMask.MeleeWeapon, MISSILE = EquipMask.MissileWeapon, HELD = EquipMask.Held, TWO = EquipMask.TwoHanded;
    expect(compatibleCombatMode(CombatMode.Missile, MISSILE)).toBe(true);
    expect(compatibleCombatMode(CombatMode.Missile, MELEE)).toBe(false);
    expect(compatibleCombatMode(CombatMode.Missile, 0)).toBe(false);
    expect(compatibleCombatMode(CombatMode.Magic, HELD)).toBe(true);
    expect(compatibleCombatMode(CombatMode.Magic, MELEE)).toBe(false);
    // Melee: bare hands or a melee / two-handed weapon; refused while a bow or caster is the only weapon.
    expect(compatibleCombatMode(CombatMode.Melee, 0)).toBe(true);
    expect(compatibleCombatMode(CombatMode.Melee, EquipMask.Shield)).toBe(true);
    expect(compatibleCombatMode(CombatMode.Melee, TWO)).toBe(true);
    expect(compatibleCombatMode(CombatMode.Melee, MELEE | EquipMask.Shield)).toBe(true);
    expect(compatibleCombatMode(CombatMode.Melee, MISSILE)).toBe(false);
    expect(compatibleCombatMode(CombatMode.Melee, HELD)).toBe(false);
    expect(compatibleCombatMode(CombatMode.NonCombat, MISSILE | HELD)).toBe(true);
    expect([CombatMode.NonCombat, CombatMode.Melee, CombatMode.Missile, CombatMode.Magic, CombatMode.Undef].map(combatModeName))
      .toEqual(['peace', 'melee', 'missile', 'magic', 'unknown']);
    expect(incompatibleCombatModeRefusal(CombatMode.Melee, MISSILE, 'Longbow'))
      .toEqual({ text: "You can't enter melee mode while wielding the Longbow" });
    // No ready weapon: refused without a line.
    expect(incompatibleCombatModeRefusal(CombatMode.Missile, 0, null)).toEqual({ text: null });
    expect(incompatibleCombatModeRefusal(CombatMode.Missile, MISSILE, 'Longbow')).toBeNull();
  });
});
