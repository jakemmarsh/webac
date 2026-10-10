/**
 * ContractStage — per-contract status sent by the server in the
 * ContractTracker GameEvent payload.
 *
 * Source: reference/ACE/Source/ACE.Server/Network/Structure/ContractTracker.cs:
 *
 *   public enum ContractStage
 *   {
 *       Available           = 0x1,
 *       InProgress          = 0x2,
 *       DoneOrPendingRepeat = 0x3,
 *       ProgressCounter     = 0x4
 *   };
 *
 * Wire format: serialized as a uint32 alongside ContractId / TimeWhenDone
 * / TimeWhenRepeats in the ContractTracker struct.
 *
 * FAITHFUL.284 — pre-fix main.ts had `CONTRACT_STAGE_NAMES: Record<number,
 * string> = { 1: 'Available', 2: 'In Progress', 3: 'Complete' }`. Missed
 * the 4th value (ProgressCounter = 0x4) entirely, and labeled 0x3
 * "Complete" — but ACE's name `DoneOrPendingRepeat` signals a more
 * specific semantic (the contract is done EITHER once-and-forever OR is
 * awaiting its repeatable cooldown). The retail AC client likely showed
 * a corresponding "Done" / "Repeating soon" cue here.
 */
export enum ContractStage {
  Available           = 0x1,
  InProgress          = 0x2,
  DoneOrPendingRepeat = 0x3,
  ProgressCounter     = 0x4,
}

/**
 * BUG.contract-status-strings-not-retail — one contract's tracker values and
 * the ContractTable flags retail's gmContractsUI reads to word it.
 * `updatedAtSec` is the client clock when the tracker arrived (retail
 * CContractTracker::_time_of_server_update = Timer::cur_time at receipt);
 * the wire's timeWhenDone / timeWhenRepeats are remaining seconds at that
 * moment (ACE ContractTracker.cs GetNextSolveTime().TotalSeconds).
 */
export interface ContractTiming {
  stage: number;
  timeWhenDone: number;
  timeWhenRepeats: number;
  updatedAtSec: number;
  /** ContractTable _questflag_timer is non-empty. */
  hasTimerFlag: boolean;
  /** ContractTable _questflag_repeat_time is non-empty. */
  hasRepeatFlag: boolean;
  /** ContractTable _description_progress (a printf format with one integer), '' when none. */
  descriptionProgress: string;
}

/** Retail's literals (.rdata 0x7a6990 / 0x7a6978 / 0x7a6968 / 0x7a6950 / 0x7a6944; UpdateButtons' "None" / "Finished"). */
export const CONTRACT_TEXT = {
  available: 'Available', inProgress: 'In Progress', doneOpen: 'Done (', toRepeat: ' to Repeat)', done: 'Done',
  none: 'None', finished: 'Finished',
} as const;

/** PStringBase<char>::sprintf of a ContractTable progress format with one integer. */
export function sprintfOneInt(format: string, n: number): string {
  let used = false;
  return format.replace(/%(%|[-+ 0#]*\d*(?:\.\d+)?[lh]?[diu])/g, (m, spec: string) => {
    if (spec === '%') return '%';
    if (used) return m;
    used = true;
    return String(Math.trunc(n));
  });
}

/**
 * gmContractsUI::FillProgressString @ 00498de0 — the Status column (row
 * element 0x100005d2) and the detail "Status:" value (m_pProgressText):
 *  - stage 1 → "Available"; stage 2 → "In Progress";
 *  - stage 3 with a repeat time: still counting down → "Done (" +
 *    DeltaTimeToString(left) + " to Repeat)", lapsed → "Available";
 *  - stage 3 without one: "Done" when the contract has no repeat flag,
 *    else "Available";
 *  - stage 4+: the progress format filled with (stage − 4), or
 *    "In Progress" when the contract has none;
 *  - anything else: nothing.
 * Replaces the invented 'Pending Repeat' / 'Active' labels.
 */
export function contractProgressText(c: ContractTiming, nowSec: number): string {
  const T = CONTRACT_TEXT;
  if (c.stage === ContractStage.Available) return T.available;
  if (c.stage === ContractStage.InProgress) return T.inProgress;
  if (c.stage === ContractStage.DoneOrPendingRepeat) {
    if (c.timeWhenRepeats > 0) {
      const left = c.timeWhenRepeats - (nowSec - c.updatedAtSec);
      return left > 0 ? T.doneOpen + deltaTimeToString(left) + T.toRepeat : T.available;
    }
    return c.hasRepeatFlag ? T.available : T.done;
  }
  if (c.stage > ContractStage.DoneOrPendingRepeat) {
    return c.descriptionProgress ? sprintfOneInt(c.descriptionProgress, c.stage - ContractStage.ProgressCounter) : T.inProgress;
  }
  return '';
}

/**
 * gmContractsUI::UpdateButtons @ 00499200 — the "Timed:" value
 * (m_pTimedText 0x100005e3): "None" for a contract without a timer flag;
 * else timeWhenDone's time left through DeltaTimeToString, or "Finished"
 * once it has run out. Replaces the invented 'Done in X' / 'Repeats in X'.
 */
export function contractTimedText(c: ContractTiming, nowSec: number): string {
  if (!c.hasTimerFlag) return CONTRACT_TEXT.none;
  const left = c.timeWhenDone - (nowSec - c.updatedAtSec);
  return left > 0 ? deltaTimeToString(left) : CONTRACT_TEXT.finished;
}

/** Repeat cooldown seconds left now — the Status sort key (ContractInfoSortStatus @ 004987a0). */
export function contractRepeatLeft(c: Pick<ContractTiming, 'timeWhenRepeats' | 'updatedAtSec'>, nowSec: number): number {
  return c.timeWhenRepeats > 0 ? Math.max(0, c.timeWhenRepeats - (nowSec - c.updatedAtSec)) : 0;
}

/**
 * CORE.15.b — retail ClientUISystem::DeltaTimeToString @ 00565e10:
 * "%dmo %dd %dh %dm %ds" where each zero unit is omitted EXCEPT seconds,
 * which always print (months are 30-day blocks of 2,592,000s); trailing
 * space trimmed. Used by the journal running timer (GetTimerText
 * @ 004956a0) and the contracts panel countdowns.
 */
export function deltaTimeToString(seconds: number): string {
  const s = Math.max(0, Math.trunc(seconds));
  const mo = Math.floor(s / 2_592_000);
  const d = Math.floor((s % 2_592_000) / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  const sec = s % 60;
  let out = '';
  if (mo !== 0) out += `${mo}mo `;
  if (d !== 0) out += `${d}d `;
  if (h !== 0) out += `${h}h `;
  if (m !== 0) out += `${m}m `;
  return out + `${sec}s`;
}
