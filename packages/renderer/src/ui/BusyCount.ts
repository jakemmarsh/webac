/**
 * BusyCount — ClientUISystem's m_cBusy (GAP.client-busy-cursor-count).
 *
 * Retail: `ClientUISystem::IncrementBusyCount @ 00564870` /
 * `DecrementBusyCount @ 00564890` bump `m_cBusy` and call
 * `UpdateCursorState @ 00564630` at the 0 ↔ 1 edges. While `m_cBusy != 0`
 * UpdateCursorState skips every target-mode and combat-mode branch and maps
 * `bVar8 + 0xe` through the UICURSOR DidMapper: 14 = "Wait", 15 =
 * "Wait_OverObject" (0x06004d74 / 0x06004d75), hotspot (0, 0). That is the
 * hourglass ACE's Player_Melee.cs:286 means by "client shows hourglass,
 * until attack done is received".
 *
 * The callers (every one in the decomp):
 *   - every Use / UseWithTarget send — ItemHolder::UseObject @ 00588a80 (x2),
 *     ItemHolder::TargetAcquired @ 00588ef0, ClientUISystem::UsageCallback
 *     @ 00565b20 and TargetedUsageCallback @ 00565960 (inline ++m_cBusy);
 *   - every cast send — ClientMagicSystem::FreeHandsAndCastSpell @ 00566ef0
 *     (x2) and CastSpell @ 00568040;
 *   - every vendor Buy / Sell send — gmVendorUI::SendShopEvent @ 004c0220,
 *     BuySingleItem @ 004c2820, SellSingleItem @ 004c2b40,
 *     HandleButtonClicks @ 004c50d0;
 *   all four kinds released by the server's UseDone:
 *   `Handle_Item__UseDone @ 00564900` decrements inline (ACE sends a UseDone
 *   after every Use, cast and Buy / Sell, success or failure);
 *   - ClientCombatSystem::HandleCommenceAttackEvent @ 0056ad20 (increment,
 *     unconditional) / HandleAttackDoneEvent @ 0056c500 (decrement only while
 *     attackInProgress) — AttackRequestController;
 *   - CPlayerSystem::SetTeleportInProgress @ 0055d580 (edge-triggered): set
 *     by gmSmartBoxUI::UseTime when the teleport starts, cleared at the end
 *     of TAS_WORLD_FADE_IN with SendLoginCompleteNotification;
 *   - gmExaminationUI::RecvNotice_ExamineObject @ 004ab7b0 (increment when no
 *     appraisal is awaited) / SetAppraiseInfo @ 004adae0 (decrement when the
 *     awaited object's appraisal arrives) — ExamineAwait below;
 *   - gmAllegianceUI's m_bAwaitingUpdate pair (not ported: our allegiance
 *     panel sends no AllegianceUpdateRequest of its own);
 *   - ClientUISystem::OnEndCharacterSession @ 00564ad0 zeroes the count.
 *
 * One deliberate difference: retail's m_cBusy is a `ulong` that
 * Handle_Item__UseDone decrements unconditionally, so an unpaired UseDone
 * would wrap it and pin the hourglass for the session. Retail's pairing is
 * complete; a UseDone we cannot pair (an increment site not yet ported here)
 * must not do that, so decrement stops at 0.
 */
import { GameActionType } from '@ac/network';

/** The sends whose retail call sites increment m_cBusy; each is answered by a UseDone. */
export const BUSY_COUNT_ACTIONS: ReadonlySet<GameActionType> = new Set([
  GameActionType.Use,
  GameActionType.UseWithTarget,
  GameActionType.CastUntargetedSpell,
  GameActionType.CastTargetedSpell,
  GameActionType.Buy,
  GameActionType.Sell,
]);

export class BusyCount {
  private count = 0;

  /** `onEdge` is UpdateCursorState: called when the count crosses 0 ↔ 1. */
  constructor(private readonly onEdge: () => void) {}

  /** m_cBusy. */
  get value(): number { return this.count; }
  /** m_cBusy != 0: UpdateCursorState picks Wait / Wait_OverObject. */
  get busy(): boolean { return this.count !== 0; }

  /** IncrementBusyCount @ 00564870. */
  increment(): void {
    if (++this.count === 1) this.onEdge();
  }

  /** DecrementBusyCount @ 00564890 / Handle_Item__UseDone's inline decrement (floored at 0, see above). */
  decrement(): void {
    if (this.count === 0) return;
    if (--this.count === 0) this.onEdge();
  }

  /** The increment that follows a Use / UseWithTarget / cast / Buy / Sell send. */
  noteActionSent(actionType: GameActionType): void {
    if (BUSY_COUNT_ACTIONS.has(actionType)) this.increment();
  }

  /** OnEndCharacterSession @ 00564ad0: m_cBusy = 0, then UpdateCursorState. */
  reset(): void {
    this.count = 0;
    this.onEdge();
  }
}

/** CPlayerSystem::teleportInProgress + SetTeleportInProgress @ 0055d580. */
export class TeleportBusy {
  private inProgress = false;
  constructor(private readonly busy: BusyCount) {}
  get value(): boolean { return this.inProgress; }
  set(inProgress: boolean): void {
    if (this.inProgress === inProgress) return;
    this.inProgress = inProgress;
    if (inProgress) this.busy.increment();
    else this.busy.decrement();
  }
  /** OnEndCharacterSession: the count is zeroed by BusyCount.reset. */
  reset(): void { this.inProgress = false; }
}

/** gmExaminationUI::awaiting_appraisal_ID and its busy-count pairing. */
export class ExamineAwait {
  private awaiting = 0;
  constructor(private readonly busy: BusyCount) {}
  get awaitingId(): number { return this.awaiting; }

  /** RecvNotice_ExamineObject @ 004ab7b0: an explicit examine (not the 0.75 s UseTime re-appraise). */
  examineObject(guid: number): void {
    if (guid === 0) return;
    if (this.awaiting === 0) this.busy.increment();
    this.awaiting = guid;
  }

  /** SetAppraiseInfo @ 004adae0: the awaited object's appraisal arrived. */
  appraisalReceived(guid: number): void {
    if (guid === 0 || guid !== this.awaiting) return;
    this.awaiting = 0;
    this.busy.decrement();
  }

  reset(): void { this.awaiting = 0; }
}
