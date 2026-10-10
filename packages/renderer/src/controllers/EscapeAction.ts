/**
 * DECOMP.escape-key-action — plain Escape: KeyMap action 0x27 in the
 * gameplay input map 0x10000009 (unnamed in the ActionMap, so the generated
 * keybind tables drop it). ClientUISystem::OnAction case 0x27 (decomp
 * ~:347472) does, in order:
 *
 *  1. a jump charge (GetJumpPowerLevel > 0): cancel it (cmdinterp +0x50,
 *     FinishJump) — nothing else;
 *  2. a UI element has keyboard focus: RelinquishFocus — nothing else;
 *  3. standing still (CommandInterpreter::IsStandingStill) and no repeat
 *     attack in progress (RepeatAttackInProgress @ 0056a860):
 *     a pending vendor open → SetTargetMode(NONE); no selection →
 *     DoVisibilityToggleAction(0x1000001b), the Options panel's Gameplay
 *     page; else targetWillinglyLost = true and SetSelectedObject(0);
 *  4. otherwise StopCompletely; "Action interrupted" (0x1a) when the player
 *     was not standing still; AbortAutomaticAttack @ 0056ae90 when a repeat
 *     attack was in progress.
 *
 * Shift+Escape is a different KeyMap entry (End Character Session,
 * 0x10000026) and never reaches this.
 */

export const ACTION_INTERRUPTED_TEXT = 'Action interrupted';

export interface EscapeActionDeps {
  /** ClientCombatSystem::GetJumpPowerLevel > 0 — a jump charge is pending. */
  jumpCharging(): boolean;
  /** cmdinterp +0x50: FinishJump — the charge ends without a jump. */
  cancelJumpCharge(): void;
  /** UIElementManager::m_focusElement: a UI element holds keyboard focus. */
  hasUiFocus(): boolean;
  /** m_focusElement->RelinquishFocus(). */
  relinquishUiFocus(): void;
  /** CommandInterpreter::IsStandingStill (CMotionInterp::is_standing_still). */
  isStandingStill(): boolean;
  /** ClientCombatSystem::RepeatAttackInProgress. */
  repeatAttackInProgress(): boolean;
  /** ClientCombatSystem::AbortAutomaticAttack. */
  abortAutomaticAttack(): void;
  /** ClientUISystem::attemptOpenVendorID != 0. */
  vendorOpenPending(): boolean;
  /** SetTargetMode(TARGET_MODE_NONE). */
  clearTargetMode(): void;
  /** ACCWeenieObject::selectedID. */
  selectedId(): number;
  /** DoVisibilityToggleAction(0x1000001b). */
  toggleGameplayOptions(): void;
  /** targetWillinglyLost = true; SetSelectedObject(0). */
  deselectWillingly(): void;
  /** CommandInterpreter::StopCompletely. */
  stopCompletely(): void;
  /** AddTextToScroll(text, 0x1a). */
  notice(text: string): void;
}

export type EscapeOutcome =
  | 'cancel-jump' | 'relinquish-focus' | 'clear-target-mode' | 'toggle-gameplay-options' | 'deselect' | 'stop';

/** ClientUISystem::OnAction case 0x27. */
export function escapeAction(d: EscapeActionDeps): EscapeOutcome {
  if (d.jumpCharging()) {
    d.cancelJumpCharge();
    return 'cancel-jump';
  }
  if (d.hasUiFocus()) {
    d.relinquishUiFocus();
    return 'relinquish-focus';
  }
  const standing = d.isStandingStill();
  if (standing && !d.repeatAttackInProgress()) {
    if (d.vendorOpenPending()) {
      d.clearTargetMode();
      return 'clear-target-mode';
    }
    if (d.selectedId() === 0) {
      d.toggleGameplayOptions();
      return 'toggle-gameplay-options';
    }
    d.deselectWillingly();
    return 'deselect';
  }
  d.stopCompletely();
  if (!standing) d.notice(ACTION_INTERRUPTED_TEXT);
  if (d.repeatAttackInProgress()) d.abortAutomaticAttack();
  return 'stop';
}
