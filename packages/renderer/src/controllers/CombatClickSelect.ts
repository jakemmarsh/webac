/**
 * Whether a click may select an object in a combat mode (SWEEP1999.input CM-3).
 *
 * The 1999 client.exe's PanelUI::HandleMouseDownOnObject @ 0x004f83c0 (called by Box3D::FoundObject
 * for a click in the 3D view and by RadarUI::Global_MouseDown for one on the radar) works out
 * `refuse = (mode == melee || mode == missile) && !PanelUI_ObjectIsAttackable(obj)`. A single
 * click that is refused shows "You cannot select that while in combat mode" and leaves the
 * selection alone; a double click selects only when not refused and uses the object either way.
 * PanelUI_ObjectIsAttackable @ 0x004f8710 counts the player itself (and id 0) as attackable.
 * The end-of-retail client has neither the check nor the string: every click selects
 * (eraClientRules().combatClickSelect 'any').
 */
import { CombatMode } from '@ac/shared';

export type CombatClickSelectRule = 'any' | 'attackableOnly';

/** True when `rule` refuses to select `guid` in combat `mode`. */
export function combatClickSelectRefused(
  rule: CombatClickSelectRule, mode: CombatMode, guid: number, playerGuid: number,
  isAttackable: (guid: number) => boolean,
): boolean {
  if (rule !== 'attackableOnly') return false;
  if (mode !== CombatMode.Melee && mode !== CombatMode.Missile) return false;
  if (!guid || guid === playerGuid) return false;
  return !isAttackable(guid);
}
