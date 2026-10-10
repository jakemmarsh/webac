/**
 * GAP.32 — contract tracker countdowns.
 *
 * ACE ContractTracker.cs fills TimeWhenDone (:116) and TimeWhenRepeats
 * (:83) from QuestManager.GetNextSolveTime().TotalSeconds — a
 * REMAINING-SECONDS countdown written as a float64 (:142-143), NOT a
 * Unix epoch. Pre-fix the client rendered timeWhenDone as an epoch date
 * ("Done at 1/1/1970, ...") and ignored timeWhenRepeats entirely (the
 * reconciliation's flagged missing half — repeat cooldowns never showed).
 */
import { describe, it, expect } from 'vitest';
import { formatContractTimer } from '../packages/shared/src/enums/ContractStage.js';

describe('GAP.32 — formatContractTimer (countdown semantics per ACE ContractTracker.cs)', () => {
  it('zero / negative / NaN → empty (no timer line)', () => {
    expect(formatContractTimer(0)).toBe('');
    expect(formatContractTimer(-5)).toBe('');
    expect(formatContractTimer(NaN)).toBe('');
  });

  it('sub-minute renders seconds', () => {
    expect(formatContractTimer(45)).toBe('45s');
    expect(formatContractTimer(1)).toBe('1s');
  });

  it('minutes render with trailing seconds trimmed to two units', () => {
    expect(formatContractTimer(90)).toBe('1m 30s');
    expect(formatContractTimer(600)).toBe('10m');
  });

  it('hours render h + m', () => {
    expect(formatContractTimer(3660)).toBe('1h 1m');
    expect(formatContractTimer(7200)).toBe('2h');
  });

  it('days render d + h (typical daily/weekly quest cooldowns)', () => {
    expect(formatContractTimer(86400 + 3600 * 5)).toBe('1d 5h');
    expect(formatContractTimer(86400 * 6)).toBe('6d');
  });

  it('float wire values floor cleanly (ACE writes float64 seconds)', () => {
    expect(formatContractTimer(59.9)).toBe('59s');
    expect(formatContractTimer(3600.7)).toBe('1h');
  });
});

describe('GAP.35 — contractStageLabel distinguishes pending-repeat (wire has no repeat flag; timeWhenRepeats>0 is the only signal)', async () => {
  const { contractStageLabel, ContractStage } = await import('../packages/shared/src/enums/ContractStage.js');

  it('DoneOrPendingRepeat + running cooldown → Pending Repeat', () => {
    expect(contractStageLabel(ContractStage.DoneOrPendingRepeat, 30)).toBe('Pending Repeat');
  });

  it('DoneOrPendingRepeat + no cooldown → Done (truly complete)', () => {
    expect(contractStageLabel(ContractStage.DoneOrPendingRepeat, 0)).toBe('Done');
    expect(contractStageLabel(ContractStage.DoneOrPendingRepeat)).toBe('Done');
  });

  it('other stages ignore the cooldown param', () => {
    expect(contractStageLabel(ContractStage.Available, 30)).toBe('Available');
    expect(contractStageLabel(ContractStage.InProgress, 30)).toBe('In Progress');
  });
});
