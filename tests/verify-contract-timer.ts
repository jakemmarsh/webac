/**
 * Contract tracker texts, as retail's gmContractsUI words them
 * (BUG.contract-status-strings-not-retail, 2026-10-10).
 *
 * ACE ContractTracker.cs fills TimeWhenDone (:116) and TimeWhenRepeats
 * (:83) from QuestManager.GetNextSolveTime().TotalSeconds — REMAINING
 * seconds at the moment the tracker was sent (GAP.32), so both count down
 * from the client clock at receipt (retail _time_of_server_update).
 *
 * - FillProgressString @ 00498de0 (Status column + "Status:"): "Available" /
 *   "In Progress" / "Done (<DeltaTimeToString> to Repeat)" / "Done", the
 *   progress format for stage 4+ — literals at .rdata 0x7a6990 / 0x7a6978 /
 *   0x7a6968 + 0x7a6950 / 0x7a6944 (disassembly order of the branches).
 * - UpdateButtons @ 00499200 ("Timed:"): "None" without a timer flag, the
 *   time left through DeltaTimeToString, or "Finished".
 * The invented 'Pending Repeat' / 'Active' / 'Done in X' / 'Repeats in X'
 * wording these tests used to pin is gone.
 */
import { describe, it, expect } from 'vitest';
import {
  CONTRACT_TEXT, contractProgressText, contractTimedText, contractRepeatLeft, deltaTimeToString, sprintfOneInt,
  type ContractTiming,
} from '../packages/shared/src/enums/ContractStage.js';

const timing = (o: Partial<ContractTiming>): ContractTiming => ({
  stage: 1, timeWhenDone: 0, timeWhenRepeats: 0, updatedAtSec: 100,
  hasTimerFlag: false, hasRepeatFlag: false, descriptionProgress: '', ...o,
});

describe('FillProgressString — the Status texts', () => {
  it('stages 1 and 2 are Available / In Progress', () => {
    expect(contractProgressText(timing({ stage: 1 }), 100)).toBe('Available');
    expect(contractProgressText(timing({ stage: 2 }), 100)).toBe('In Progress');
  });

  it('stage 3 with a running repeat cooldown reads "Done (<left> to Repeat)" and counts down from receipt', () => {
    const t = timing({ stage: 3, timeWhenRepeats: 3725, hasRepeatFlag: true });
    expect(contractProgressText(t, 100)).toBe('Done (1h 2m 5s to Repeat)');
    expect(contractProgressText(t, 160)).toBe('Done (1h 1m 5s to Repeat)');
  });

  it('a lapsed repeat cooldown reads Available, not Done', () => {
    const t = timing({ stage: 3, timeWhenRepeats: 30, hasRepeatFlag: true });
    expect(contractProgressText(t, 131)).toBe(CONTRACT_TEXT.available);
  });

  it('stage 3 with no repeat time: Done for a one-off contract, Available for a repeatable one', () => {
    expect(contractProgressText(timing({ stage: 3 }), 100)).toBe('Done');
    expect(contractProgressText(timing({ stage: 3, hasRepeatFlag: true }), 100)).toBe('Available');
  });

  it('stage 4+ fills the contract\'s progress format with (stage − 4); no format reads In Progress', () => {
    expect(contractProgressText(timing({ stage: 7, descriptionProgress: 'Killed %d of 10' }), 100)).toBe('Killed 3 of 10');
    expect(contractProgressText(timing({ stage: 4, descriptionProgress: '%d%% done' }), 100)).toBe('0% done');
    expect(contractProgressText(timing({ stage: 9 }), 100)).toBe('In Progress');
  });

  it('an unknown stage prints nothing', () => {
    expect(contractProgressText(timing({ stage: 0 }), 100)).toBe('');
  });

  it('sprintfOneInt fills only the first integer conversion', () => {
    expect(sprintfOneInt('%d of %d', 2)).toBe('2 of %d');
    expect(sprintfOneInt('no number', 2)).toBe('no number');
  });
});

describe('UpdateButtons — the Timed text', () => {
  it('None without a timer flag', () => {
    expect(contractTimedText(timing({ stage: 2, timeWhenDone: 500 }), 100)).toBe('None');
  });
  it('the time left through DeltaTimeToString, then Finished', () => {
    const t = timing({ stage: 2, hasTimerFlag: true, timeWhenDone: 90 });
    expect(contractTimedText(t, 100)).toBe('1m 30s');
    expect(contractTimedText(t, 189.5)).toBe('0s');
    expect(contractTimedText(t, 190)).toBe('Finished');
  });
});

describe('the Status sort key and DeltaTimeToString', () => {
  it('repeat cooldown left now (never negative), 0 without one', () => {
    expect(contractRepeatLeft({ timeWhenRepeats: 600, updatedAtSec: 100 }, 160)).toBe(540);
    expect(contractRepeatLeft({ timeWhenRepeats: 60, updatedAtSec: 100 }, 400)).toBe(0);
    expect(contractRepeatLeft({ timeWhenRepeats: 0, updatedAtSec: 100 }, 100)).toBe(0);
  });
  it('omits zero units except seconds, months as 30-day blocks', () => {
    expect(deltaTimeToString(45)).toBe('45s');
    expect(deltaTimeToString(86400 * 6)).toBe('6d 0s');
    expect(deltaTimeToString(2_592_000 + 3600)).toBe('1mo 1h 0s');
  });
});
