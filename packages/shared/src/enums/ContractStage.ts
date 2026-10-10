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
 * Render a ContractStage value as a status label for the journal/quest
 * tracker UI. Falls back to "Active" for unknown values — same posture
 * as the pre-fix CONTRACT_STAGE_NAMES map.
 *
 * GAP.35 — DoneOrPendingRepeat carries two ACE-side meanings (truly
 * complete vs. waiting on the repeat cooldown). The wire has no
 * repeatability flag; the ONLY signal is a non-zero `timeWhenRepeats`
 * sitting alongside in the ContractTracker payload (ACE sets it from
 * GetNextSolveTime when the repeat quest flag is stamped and un-expired,
 * ContractTracker.cs:83-86). Pass it to get the distinction: 'Pending
 * Repeat' (derived from ACE's own enum name) while the cooldown runs,
 * 'Done' otherwise.
 */
export function contractStageLabel(stage: number, timeWhenRepeats = 0): string {
  switch (stage) {
    case ContractStage.Available:           return 'Available';
    case ContractStage.InProgress:          return 'In Progress';
    case ContractStage.DoneOrPendingRepeat: return timeWhenRepeats > 0 ? 'Pending Repeat' : 'Done';
    case ContractStage.ProgressCounter:     return 'In Progress';
    default:                                return 'Active';
  }
}

/**
 * GAP.32 — format a contract tracker countdown. ACE ContractTracker.cs
 * fills TimeWhenDone/TimeWhenRepeats from QuestManager.GetNextSolveTime()
 * .TotalSeconds — a REMAINING-SECONDS countdown (double on the wire),
 * NOT a Unix epoch. Renders retail-style "Xd Yh Zm Ws" trimmed to the
 * two most significant units; sub-minute shows seconds.
 */
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

export function formatContractTimer(seconds: number): string {
  if (!(seconds > 0)) return '';
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (parts.length === 0 || (d === 0 && h === 0 && sec > 0 && parts.length < 2)) parts.push(`${sec}s`);
  return parts.slice(0, 2).join(' ');
}
