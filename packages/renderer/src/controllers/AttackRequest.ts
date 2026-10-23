/**
 * BUG.combat-attack-charge-build — retail's melee/missile attack request and
 * power-bar build, ported from ClientCombatSystem (EoL acclient.exe). Pure
 * logic: the clock, the target, the stance check and every side effect come
 * in through AttackRequestDeps, so the state machine runs the same in tests.
 *
 * The classic (non-Advanced) combat UI, which is retail's default:
 *   - key / button DOWN → SetRequestedAttackHeight @ 0056c8f0 →
 *     StartAttackRequest @ 0056c040: needs an attackable target ("You must
 *     select a valid combat target before attacking" in the spew box
 *     otherwise), then cmdinterp->MaybeStopCompletely stands the player
 *     still (controllers/StopCompletely.ts) and AttemptStartBuildingAttack
 *     @ 0056bb00 starts the meter at 0.0.
 *   - every frame UseTime @ 0056c1f0 pushes GetPowerBarLevel @ 0056ade0 =
 *     (now − buildStartTime) / ATTACK_POWERUP_TIME (1 s; 0.8 s dual wield),
 *     clamped 0..1, to the bar (SetPowerBarLevel @ 0056a890).
 *   - key / button UP → EndAttackRequest @ 0056c0e0 at USE_POWER_BAR_LEVEL:
 *     the requested power is max(bar, slider). A bar at or past the slider
 *     swings now at the bar's power, and then again at the slider's (the
 *     binary really calls ExecuteAttack twice; ACE queues the second power
 *     in Player.AttackQueue for the next swing). A bar short of the slider
 *     keeps building, and UseTime swings once it reaches the slider.
 *   - ExecuteAttack @ 0056bb70 sends TargetedMelee/MissileAttack and holds
 *     the bar until the server's AttackDone (HandleAttackDoneEvent @
 *     0056c500), which clears it (0.0) or, while auto-repeating, rebuilds it
 *     (StartPowerBarBuild @ 0056adb0, an automatic build that never sends).
 *   - a selection change (RecvNotice_SelectionChanged @ 0056bd80) cancels a
 *     live repeat attack, and a selection lost to anything but Escape in
 *     melee / missile mode runs AutoTarget @ 0056bc80 when the Auto Target
 *     option is on: select the last attacker if it hit or swung at us in the
 *     last 15 s, else the nearest compass item (SelectNext). It never swings.
 */

/** ATTACK_POWERUP_TIME (acclient global, 1.0 s). */
export const ATTACK_POWERUP_TIME = 1.0;
/** DUAL_WIELD_POWERUP_TIME (acclient global, 0.8 s). */
export const DUAL_WIELD_POWERUP_TIME = 0.8;
/** USE_POWER_BAR_LEVEL (acclient global, -1): EndAttackRequest reads the bar. */
export const USE_POWER_BAR_LEVEL = -1;
/** The DualWieldCombat motion style GetPowerBarLevel tests (0x80000046). */
export const DUAL_WIELD_COMBAT_STYLE = 0x80000046;
/** AUTO_TARGET_LAST_ATTACKER_MAX_INTERVAL (acclient global, 15 s). */
export const AUTO_TARGET_LAST_ATTACKER_MAX_INTERVAL = 15;
/** HandleAttackDoneEvent's |requested − slider| threshold (___real_3c23d70a). */
const POWER_EPSILON = 0.01;

export const NO_TARGET_TEXT = 'You must select a valid combat target before attacking';

export type AttackHeightName = 'high' | 'medium' | 'low';

/**
 * HandleCombatAction @ 0056d600: the melee (0x1000005d-5f) and missile
 * (0x100000f1-f3) Low / Medium / High Attack commands. Null for any other.
 */
export function attackHeightForAction(id: number): AttackHeightName | null {
  switch (id) {
    case 0x1000005d: case 0x100000f1: return 'low';
    case 0x1000005e: case 0x100000f2: return 'medium';
    case 0x1000005f: case 0x100000f3: return 'high';
    default: return null;
  }
}

/**
 * HandleAttackDoneEvent's repeat test: the attack chain survives an
 * AttackDone only when the code is 0 (the server queued the next swing)
 * and Repeat Attacks is on. ACE's end-of-swing ActionCancelled (0x36) and
 * every real rejection end it.
 */
export function attackDoneEndsChain(errorCode: number, autoRepeat: boolean): boolean {
  return errorCode !== 0 || !autoRepeat;
}

export interface AttackRequestDeps {
  /** Timer::cur_time, in seconds. */
  now(): number;
  /** GetAttackTarget: the selected object's guid, 0 for none. */
  getTarget(): number;
  /** ObjectIsAttackable @ 0056a600. */
  isAttackable(guid: number): boolean;
  /**
   * PlayerInReadyPosition(true) @ 0056b820: melee with a combat table, or a
   * missile style while the interpreted forward command is Ready (moving
   * forward / backward is not ready; strafing and turning are).
   */
  inReadyPosition(): boolean;
  /** 'melee' | 'missile' for the current COMBAT_MODE, null otherwise. */
  combatMode(): 'melee' | 'missile' | null;
  /** The player's current motion style (dual wield shortens the build). */
  currentStyle(): number;
  /** m_rUIRequestedPower: the combat bar's power slider, 0..1. */
  sliderPower(): number;
  /** PlayerModule::AutoRepeatAttack: the "Repeat Attacks" option. */
  autoRepeat(): boolean;
  /** CM_Combat::Event_TargetedMelee/MissileAttack. */
  sendAttack(mode: 'melee' | 'missile', target: number, height: AttackHeightName, power: number): void;
  /** CM_Character::SendNotice_SetPowerbarLevel(PBM_COMBAT, level): the combat bar's meter. */
  setPowerBarLevel(level: number): void;
  /**
   * PlayerModule::AdvancedCombatUI — the "Advanced Combat Interface"
   * option, latched into m_bAdvancedCombatMode by SetCombatMode @ 0056be30
   * (latchAdvancedCombatMode). Absent → off.
   */
  advancedCombatUI?(): boolean;
  /**
   * PBM_ADVANCED_COMBAT: SendNotice_BeginPowerbar(2) — gmPowerbarUI::
   * RecvNotice_BeginPowerbar @ 004da730 shows the floaty power bar in its
   * melee (0x10000043) or missile (0x10000044) state.
   */
  beginAdvancedPowerBar?(mode: 'melee' | 'missile'): void;
  /** SendNotice_SetPowerbarLevel(PBM_ADVANCED_COMBAT, level): the floaty bar's fill. */
  setAdvancedPowerBarLevel?(level: number): void;
  /** SendNotice_FinishPowerbar(PBM_ADVANCED_COMBAT) — @ 004da580 empties and hides the floaty bar. */
  finishAdvancedPowerBar?(): void;
  /** AddTextToScroll(text, 0x1a): the spew box. */
  showError(text: string): void;
  /** CM_Combat::Event_CancelAttack. */
  sendCancelAttack(): void;
  /** PlayerModule::AutoTarget: the "Auto Target" option. */
  autoTarget(): boolean;
  /** InqInstanceID(CurrentAttacker = 0xb): the player's last attacker, 0 for none. */
  lastAttacker(): number;
  /** GetWeenieObject(guid) exists and is not beingRemoved. */
  objectPresent(guid: number): boolean;
  /** ACCWeenieObject::SetSelectedObject(guid, 0); 0 clears the selection. */
  selectObject(guid: number): void;
  /** ACCWeenieObject::selectedID: the raw selection, 0 for none (defaults to getTarget). */
  selectedId?(): number;
  /**
   * GetAttackTarget @ 0056a8f0 on the current selection: 0 for none, an
   * unknown object or one the player owns (a pack or worn item), the
   * physics parent for a held child part (defaults to getTarget).
   */
  attackTarget?(): number;
  /** SmartBox::smartbox->player_id (defaults to 0). */
  playerId?(): number;
  /** CPlayerSystem::SelectNext(1, 1, SELECTION_TYPE_COMPASS_ITEM, 0). */
  selectNextCompassItem(): void;
  /** ClientUISystem::IncrementBusyCount / DecrementBusyCount (ui/BusyCount.ts): the Wait cursor. */
  incrementBusyCount?(): void;
  decrementBusyCount?(): void;
  /** cmdinterp->MaybeStopCompletely (controllers/StopCompletely.ts). */
  maybeStopCompletely?(): void;
  /** cmdinterp->FinishJump (+0x50): a jump charge ends without a jump. */
  finishJump?(): void;
}

export class AttackRequestController {
  /** m_bAdvancedCombatMode — the "Advanced Combat Interface" option, latched at each SetCombatMode. */
  advancedCombatMode = false;
  attackRequestInProgress = false;
  buildInProgress = false;
  buildStartTime = 0;
  requestedAttackPower = 0;
  requestedAttackHeight: AttackHeightName = 'medium';
  attackServerResponsePending = false;
  attackWhenResponseReceived = false;
  attackWhenResponseReceivedPower = 0;
  currentBuildIsAutomatic = false;
  repeatAttacking = false;
  /** attackInProgress: CommenceAttack received, AttackDone not yet. */
  attackInProgress = false;
  /** targetWillinglyLost: the selection was dropped by Escape, so no AutoTarget. */
  targetWillinglyLost = false;
  /** lastAttackedTime: the last Defender / EvasionDefender notification. */
  lastAttackedTime = 0;
  /**
   * powerBarMode: PBM_UNDEF (0), PBM_COMBAT (1, the combat bar's meter) or
   * PBM_ADVANCED_COMBAT (2, the floaty power bar). The jump bar (PBM_JUMP)
   * is the movement code's.
   */
  powerBarMode: 0 | 1 | 2 = 0;
  latestPowerBarLevel = 0;

  constructor(private readonly deps: AttackRequestDeps) {
    this.latchAdvancedCombatMode();
  }

  /**
   * SetCombatMode @ 0056be30: `m_bAdvancedCombatMode =
   * PlayerModule::AdvancedCombatUI()` on every mode change, so toggling the
   * option takes effect at the next combat-mode change.
   */
  latchAdvancedCombatMode(): void {
    this.advancedCombatMode = !!this.deps.advancedCombatUI?.();
  }

  /** The bar a build drives: (m_bAdvancedCombatMode != 0) + PBM_COMBAT. */
  private openPowerBar(): void {
    this.powerBarMode = this.advancedCombatMode ? 2 : 1;
    if (this.powerBarMode === 1) {
      this.deps.setPowerBarLevel(0);
    } else {
      const mode = this.deps.combatMode();
      if (mode) this.deps.beginAdvancedPowerBar?.(mode);
    }
  }

  /** SetRequestedAttackHeight @ 0056c8f0 — the key / button press. */
  setRequestedAttackHeight(height: AttackHeightName): void {
    const prev = this.requestedAttackHeight;
    this.requestedAttackHeight = height;
    if (prev !== height || !this.attackRequestInProgress) this.startAttackRequest();
  }

  /** StartAttackRequest @ 0056c040. */
  startAttackRequest(): void {
    const target = this.deps.getTarget();
    if (!this.advancedCombatMode && (target === 0 || !this.deps.isAttackable(target))) {
      this.deps.showError(NO_TARGET_TEXT);
      return;
    }
    this.attackRequestInProgress = true;
    this.requestedAttackPower = 1.0;
    // cmdinterp->FinishJump() (+0x50), then MaybeStopCompletely() (+0xc0): an
    // attack request abandons a jump charge and stands the player still
    // (held movement keys need a fresh press).
    this.deps.finishJump?.();
    this.deps.maybeStopCompletely?.();
    this.currentBuildIsAutomatic = false;
    this.attemptStartBuildingAttack();
  }

  /** EndAttackRequest @ 0056c0e0 — the key / button release. */
  endAttackRequest(height: AttackHeightName = this.requestedAttackHeight, power = USE_POWER_BAR_LEVEL): void {
    if (!this.attackRequestInProgress) return;
    this.attackRequestInProgress = false;
    const level = this.getPowerBarLevel();
    const slider = this.deps.sliderPower();
    if (power === USE_POWER_BAR_LEVEL) {
      this.requestedAttackPower = this.advancedCombatMode ? level : Math.max(level, slider);
    } else {
      this.requestedAttackPower = power;
    }
    if (this.attackServerResponsePending) {
      this.attackWhenResponseReceived = true;
      this.attackWhenResponseReceivedPower = this.requestedAttackPower;
      return;
    }
    if (this.advancedCombatMode || slider <= level || this.repeatAttacking) {
      this.executeAttack(height, true);
      if (!this.advancedCombatMode && slider < this.requestedAttackPower) {
        this.requestedAttackPower = slider;
        this.executeAttack(height, true);
      }
    }
  }

  /** GetPowerBarLevel @ 0056ade0. */
  getPowerBarLevel(): number {
    if (!this.buildInProgress) return 0;
    const powerup = this.deps.currentStyle() === DUAL_WIELD_COMBAT_STYLE ? DUAL_WIELD_POWERUP_TIME : ATTACK_POWERUP_TIME;
    const level = (this.deps.now() - this.buildStartTime) / powerup;
    return level > 1 ? 1 : level < 0 ? 0 : level;
  }

  /** UseTime @ 0056c1f0 — once per frame. */
  useTime(): void {
    if (this.buildInProgress && this.powerBarMode !== 0) {
      const level = this.getPowerBarLevel();
      if (this.deps.inReadyPosition()) {
        if (this.attackRequestInProgress || this.advancedCombatMode || level < this.requestedAttackPower) {
          this.setPowerBarLevel(level);
        } else {
          this.setPowerBarLevel(Math.min(this.requestedAttackPower, level));
          if (!this.currentBuildIsAutomatic) {
            this.executeAttack(this.requestedAttackHeight, true);
          } else {
            this.buildInProgress = false;
            this.buildStartTime = 0;
          }
        }
      } else {
        // Out of the ready position mid-build (a missile build while moving
        // forward / back): with Repeat Attacks on the attack is cancelled.
        if (this.deps.autoRepeat()) {
          this.deps.sendCancelAttack();
          this.repeatAttacking = false;
        }
        if (!this.attackRequestInProgress) {
          this.hidePowerBar();
        } else {
          this.buildInProgress = false;
          this.buildStartTime = 0;
          this.setPowerBarLevel(0);
        }
      }
    }
    if (this.attackRequestInProgress && !this.buildInProgress && !this.attackServerResponsePending) {
      this.attemptStartBuildingAttack();
    }
  }

  /**
   * HandleAttackDoneEvent @ 0056c500 (the server's AttackDone). Code 0 means
   * the server queued the next swing itself (ACE Player_Melee / Player_
   * Missile repeat at the AttackQueue power), so the client sends nothing
   * unless the slider moved: then it re-sends once at the slider's power,
   * which ACE only enqueues for the next swing. Any other code ends the
   * repeat with AbortAutomaticAttack, CancelAttack included.
   */
  handleAttackDone(errorCode: number): void {
    // The busy count is released only for an attack it counted.
    if (this.attackInProgress) this.deps.decrementBusyCount?.();
    this.attackInProgress = false;
    this.attackServerResponsePending = false;
    // BUG.ac1999-melee-never-swings — a refusal while repeating is AbortAutomaticAttack, which
    // sends CancelAttack (EoL @ 0056c500 → 0056ae90 → CM_Combat::Event_CancelAttack; 1999
    // @ 0x004f8bb0 → 0x004f94b0 → 0x004f9530). The AC1999 server refuses a request without
    // touching the repeat it is running (Monster.cpp TryMeleeAttack "too soon"), so without the
    // cancel that repeat went on unseen while this client had stopped.
    if (errorCode !== 0 && this.repeatAttacking) this.abortAutomaticAttack();
    if (!this.attackRequestInProgress && !this.advancedCombatMode && this.deps.autoRepeat() && this.repeatAttacking) {
      const slider = this.deps.sliderPower();
      if (Math.abs(this.requestedAttackPower - slider) > POWER_EPSILON) {
        this.requestedAttackPower = slider;
        this.executeAttack(this.requestedAttackHeight, false);
      }
    }
    if (this.deps.autoRepeat() && this.repeatAttacking) {
      if (!this.attackRequestInProgress) {
        this.startPowerBarBuild();
        this.currentBuildIsAutomatic = true;
      }
    } else {
      this.repeatAttacking = false;
      this.hidePowerBar();
    }
    if (this.attackRequestInProgress && !this.buildInProgress && !this.attackServerResponsePending) {
      this.attemptStartBuildingAttack();
    }
    if (this.attackWhenResponseReceived) {
      const power = this.attackWhenResponseReceivedPower;
      this.attackWhenResponseReceived = false;
      this.attackWhenResponseReceivedPower = 0;
      this.startAttackRequest();
      this.endAttackRequest(this.requestedAttackHeight, power);
    }
  }

  /**
   * HandleCommenceAttackEvent @ 0056ad20 (offsets via objdump:
   * attackInProgress +0x3c, attackServerResponsePending +0x3d,
   * attackRequestInProgress +0x3e, requestedAttackPower +0x40,
   * latestPowerBarLevel +0x38, buildInProgress +0x30). With no key held the
   * bar opens if undefined and holds at the swing's power, stopping any
   * automatic rebuild until AttackDone. The response stays pending, so a
   * release now queues (attackWhenResponseReceived) instead of swinging.
   * Every CommenceAttack ends with IncrementBusyCount (the Wait cursor until
   * AttackDone), the request-in-progress early-out included.
   */
  handleCommenceAttack(): void {
    this.attackInProgress = true;
    this.attackServerResponsePending = true;
    if (!this.attackRequestInProgress) {
      if (this.powerBarMode === 0) this.openPowerBar();
      this.setPowerBarLevel(this.requestedAttackPower);
      this.buildInProgress = false;
      this.buildStartTime = 0;
    }
    this.deps.incrementBusyCount?.();
  }

  /** HandleDefenderNotificationEvent @ 0056c920 / HandleEvasionDefenderNotificationEvent @ 0056c620. */
  noteAttacked(): void {
    this.lastAttackedTime = this.deps.now();
    // Both handlers' tail (0056c620 / 0056c920): in melee or missile mode,
    // with Auto Target on and nothing selected, select the attacker (or the
    // nearest compass item). targetWillinglyLost plays no part here.
    if (this.deps.combatMode() !== null && this.deps.autoTarget() && this.selectedId() === 0) this.autoTarget();
  }

  /**
   * SetCombatMode @ 0056be30, after the mode is set: entering melee or
   * missile swaps the selection for its attack target (the holder of a
   * selected child part; nothing for an NPC, a pack item or anything else
   * not attackable), leaving the player selected alone, then runs
   * AutoTarget when the option is on and no attackable target remains.
   */
  onCombatModeSet(): void {
    this.latchAdvancedCombatMode();
    if (this.deps.combatMode() === null) return;
    const selected = this.selectedId();
    const playerId = this.deps.playerId?.() ?? 0;
    if (selected !== playerId) {
      const t = this.attackTarget();
      // ObjectIsAttackable(0) is true, so an empty attack target clears.
      const attackable = t === 0 || this.deps.isAttackable(t);
      if (!attackable || selected !== t) this.deps.selectObject(attackable ? t : 0);
    }
    if (!this.deps.autoTarget()) return;
    const t = this.attackTarget();
    if (t !== 0 && this.deps.isAttackable(t)) return;
    this.autoTarget();
  }

  private selectedId(): number {
    return this.deps.selectedId ? this.deps.selectedId() : this.deps.getTarget();
  }

  private attackTarget(): number {
    return this.deps.attackTarget ? this.deps.attackTarget() : this.deps.getTarget();
  }

  /** ClientUISystem::OnAction's Escape deselect (and CleanUpGameUI). */
  setSelectionWillinglyLost(): void {
    this.targetWillinglyLost = true;
  }

  /**
   * RecvNotice_SelectionChanged @ 0056bd80, with the new selection (0 for
   * none). Offsets from the binary: attackInProgress +0x3c,
   * attackServerResponsePending +0x3d, attackRequestInProgress +0x3e,
   * repeatAttacking +0x44, targetWillinglyLost +0x46, combatMode +0x1c.
   */
  onSelectionChanged(selectedId: number): void {
    if (this.deps.autoRepeat()
      && (this.attackInProgress || this.powerBarMode === 1)
      && (this.attackServerResponsePending || this.attackRequestInProgress || this.attackInProgress || this.repeatAttacking)) {
      this.deps.sendCancelAttack();
      this.repeatAttacking = false;
      if (this.buildInProgress && this.powerBarMode === 1) this.hidePowerBar();
    }
    if (selectedId !== 0) return;
    if (this.targetWillinglyLost) {
      this.targetWillinglyLost = false;
      return;
    }
    if (this.deps.combatMode() !== null && this.deps.autoTarget()) this.autoTarget();
  }

  /** AutoTarget @ 0056bc80: select, never attack. */
  autoTarget(): void {
    const attacker = this.deps.lastAttacker();
    if (attacker !== 0
      && this.deps.now() - this.lastAttackedTime < AUTO_TARGET_LAST_ATTACKER_MAX_INTERVAL
      && this.deps.objectPresent(attacker)) {
      this.deps.selectObject(attacker);
    } else {
      this.deps.selectNextCompassItem();
    }
  }

  /** Leaving combat, dying, teleporting: drop the request and the bar. */
  reset(): void {
    this.attackRequestInProgress = false;
    // Retail clears attackInProgress only in HandleAttackDoneEvent (and
    // ClientCombatSystem::Begin); this reset clears it early, so it releases
    // the busy count with it rather than leave the Wait cursor unpaired.
    if (this.attackInProgress) this.deps.decrementBusyCount?.();
    this.attackInProgress = false;
    this.attackServerResponsePending = false;
    this.attackWhenResponseReceived = false;
    this.attackWhenResponseReceivedPower = 0;
    this.repeatAttacking = false;
    this.currentBuildIsAutomatic = false;
    this.hidePowerBar();
  }

  /** ExecuteAttack @ 0056bb70. */
  private executeAttack(height: AttackHeightName, keepPending: boolean): void {
    this.buildInProgress = false;
    this.buildStartTime = 0;
    const target = this.deps.getTarget();
    const attackable = target !== 0 && this.deps.isAttackable(target);
    const mode = this.deps.combatMode();
    if (this.deps.inReadyPosition()) {
      if (attackable && mode) {
        this.deps.sendAttack(mode, target, height, this.requestedAttackPower);
        if (this.deps.autoRepeat()) this.repeatAttacking = true;
        this.attackServerResponsePending = true;
      } else {
        this.deps.showError(NO_TARGET_TEXT);
      }
    } else if (!attackable) {
      this.deps.showError(NO_TARGET_TEXT);
    }
    if (!this.attackServerResponsePending) this.hidePowerBar();
    if (!keepPending) this.attackServerResponsePending = false;
  }

  /** AttemptStartBuildingAttack @ 0056bb00. */
  private attemptStartBuildingAttack(): void {
    if (this.deps.inReadyPosition() && !this.buildInProgress) {
      this.openPowerBar();
      this.startPowerBarBuild();
    }
  }

  /** StartPowerBarBuild @ 0056adb0. */
  private startPowerBarBuild(): void {
    if (this.powerBarMode === 0) this.powerBarMode = this.advancedCombatMode ? 2 : 1;
    this.buildInProgress = true;
    this.buildStartTime = this.deps.now();
    this.setPowerBarLevel(0);
  }

  /**
   * HidePowerBar @ 0056a8b0: PBM_COMBAT sets the meter back to 0.0; any
   * other mode is SendNotice_FinishPowerbar (the floaty bar hides).
   */
  private hidePowerBar(): void {
    this.buildInProgress = false;
    this.buildStartTime = 0;
    if (this.powerBarMode === 1) this.deps.setPowerBarLevel(0);
    else if (this.powerBarMode === 2) this.deps.finishAdvancedPowerBar?.();
    this.latestPowerBarLevel = 0;
    this.powerBarMode = 0;
  }

  /** AbortAutomaticAttack's local half: the repeat ends and a combat build's bar hides. */
  private stopRepeating(): void {
    this.repeatAttacking = false;
    if (this.buildInProgress && this.powerBarMode === 1) this.hidePowerBar();
  }

  /**
   * ClientCombatSystem::RepeatAttackInProgress @ 0056a860: the "Repeat
   * Attacks" option is on and an attack is in progress or the combat power
   * bar is up (powerBarMode == PBM_COMBAT).
   */
  repeatAttackInProgress(): boolean {
    return this.deps.autoRepeat() && (this.attackInProgress || this.powerBarMode === 1);
  }

  /**
   * ClientCombatSystem::AbortAutomaticAttack @ 0056ae90: with any of
   * attackServerResponsePending / attackRequestInProgress / attackInProgress
   * / repeatAttacking set, send CancelAttack, end the repeat, and hide the
   * power bar when a combat build is running. Otherwise nothing.
   */
  abortAutomaticAttack(): void {
    if (!(this.attackServerResponsePending || this.attackRequestInProgress || this.attackInProgress || this.repeatAttacking)) return;
    this.deps.sendCancelAttack();
    this.stopRepeating();
  }

  /**
   * SWEEP1006 jump vs repeat — ClientCombatSystem::CommenceJump @ 0056af90:
   * once charge_jump accepts the jump, with the Repeat Attacks option on it
   * sends CancelAttack and ends the repeat, and the power bar becomes the
   * jump bar (PBM_JUMP, level 0): a combat build stops.
   */
  commenceJump(): void {
    if (this.deps.autoRepeat()) {
      this.deps.sendCancelAttack();
      this.repeatAttacking = false;
    }
    // SendNotice_SetPowerbarLevel(powerBarMode, 0.0), then the bar becomes
    // the jump bar (BeginPowerbar(PBM_JUMP), the caller's): no Finish.
    if (this.powerBarMode !== 0) this.setPowerBarLevel(0);
    this.buildInProgress = false;
    this.buildStartTime = 0;
    this.latestPowerBarLevel = 0;
    this.powerBarMode = 0;
  }

  /** SetPowerBarLevel @ 0056a890: SendNotice_SetPowerbarLevel(powerBarMode, level). */
  private setPowerBarLevel(level: number): void {
    if (this.powerBarMode === 2) this.deps.setAdvancedPowerBarLevel?.(level);
    else this.deps.setPowerBarLevel(level);
    this.latestPowerBarLevel = level;
  }
}
