/**
 * ContractStage enum + label helper (FAITHFUL.284).
 *
 * Pre-fix main.ts had `CONTRACT_STAGE_NAMES: Record<number, string> =
 * { 1: 'Available', 2: 'In Progress', 3: 'Complete' }`. Per ACE
 * ContractTracker.cs the enum is 4 values:
 *   Available           = 0x1
 *   InProgress          = 0x2
 *   DoneOrPendingRepeat = 0x3
 *   ProgressCounter     = 0x4
 *
 * The pre-fix map missed value 4 entirely (any contract with the
 * progress-counter stage hit the 'Active' fallback) and labeled value
 * 3 simply "Complete" — but the ACE name `DoneOrPendingRepeat` signals
 * EITHER truly done OR awaiting the repeat cooldown. The retail AC
 * client distinguished these via the accompanying `timeWhenRepeats`
 * field; our label now reads "Done" for value 3 and "In Progress" for
 * value 4 (the ProgressCounter stage is mid-progress per ACE source).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ContractStage, contractProgressText, contractTimedText } from '@ac/shared';
import { buildContractRows, contractContact, contractLocText } from '../packages/renderer/src/network/contractRows.js';

const REPO = resolve(__dirname, '..');
const ACE_SRC = resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Structure/ContractTracker.cs');

describe('ContractStage enum (FAITHFUL.284)', () => {
  it('matches ACE numeric values', () => {
    expect(ContractStage.Available).toBe(0x1);
    expect(ContractStage.InProgress).toBe(0x2);
    expect(ContractStage.DoneOrPendingRepeat).toBe(0x3);
    expect(ContractStage.ProgressCounter).toBe(0x4);
  });
});

describe.skipIf(!aceReferenceExists(ACE_SRC))('ACE source faithfulness (FAITHFUL.284)', () => {
  let src: string;
  // Loaded in beforeAll: skipIf does not skip the describe body (CLAUDE.md).
  beforeAll(() => {
    src = readFileSync(ACE_SRC, 'utf8');
  });
  it('ACE ContractTracker.cs has the 4-value ContractStage enum', () => {
    expect(src).toMatch(/enum ContractStage/);
    expect(src).toMatch(/Available\s*=\s*0x1/);
    expect(src).toMatch(/InProgress\s*=\s*0x2/);
    expect(src).toMatch(/DoneOrPendingRepeat\s*=\s*0x3/);
    expect(src).toMatch(/ProgressCounter\s*=\s*0x4/);
  });
});

describe('contractProgressText covers all 4 ACE stages (FAITHFUL.284, BUG.contract-status-strings-not-retail)', () => {
  const t = (stage: number) => ({ stage, timeWhenDone: 0, timeWhenRepeats: 0, updatedAtSec: 0, hasTimerFlag: false, hasRepeatFlag: false, descriptionProgress: '' });
  it('renders each of the 4 ACE stages in retail FillProgressString wording', () => {
    expect(contractProgressText(t(ContractStage.Available), 0)).toBe('Available');
    expect(contractProgressText(t(ContractStage.InProgress), 0)).toBe('In Progress');
    expect(contractProgressText(t(ContractStage.DoneOrPendingRepeat), 0)).toBe('Done');
    // ProgressCounter=0x4 with no progress format — the value the pre-fix map missed.
    expect(contractProgressText(t(ContractStage.ProgressCounter), 0)).toBe('In Progress');
  });
  it('no invented "Active" fallback: an unknown stage prints nothing', () => {
    expect(contractProgressText(t(0), 0)).toBe('');
  });
});

// CORE.15.a — the former "main.ts wiring" source-text pins (regex over
// publishContracts in main.ts) are converted to behavioral tests: the row
// building now lives in network/contractRows.ts, imported and executed
// for real here. main.ts's publishContracts is a two-line delegation.
describe('buildContractRows (behavioral — FAITHFUL.284/206, GAP.32/35, CORE.15.a)', () => {
  const entry = (contractId: number, stage: number, timeWhenDone = 0, timeWhenRepeats = 0) =>
    ({ version: 1, contractId, stage, timeWhenDone, timeWhenRepeats, updatedAtSec: 50 });

  it('rows carry the tracker values + receipt time; the status words them per stage (no meta)', () => {
    const rows = buildContractRows(
      [entry(1, 1), entry(2, 2), entry(3, 3), entry(4, 4)], () => undefined);
    expect(rows.map(r => contractProgressText(r.timing, 50))).toEqual(['Available', 'In Progress', 'Done', 'In Progress']);
    // No ContractTable meta: no Notes text (the invented stage-label fallback is gone).
    expect(rows.map(r => r.description)).toEqual(['', '', '', '']);
    expect(rows[0].timing.updatedAtSec).toBe(50);
  });

  it('GAP.35 — a stage-3 repeat cooldown reads "Done (… to Repeat)" while it runs', () => {
    const rows = buildContractRows([entry(1, 3, 0, 600), entry(2, 3, 0, 0)], () => undefined);
    expect(contractProgressText(rows[0].timing, 50)).toBe('Done (10m 0s to Repeat)');
    expect(contractProgressText(rows[1].timing, 50)).toBe('Done');
  });

  it('GAP.32 — Timed reads the remaining-seconds countdown when the contract has a timer flag, else None', () => {
    const timed = { contractName: 'T', description: '', nameNpcStart: '', questflagTimer: 'timerflag' };
    const rows = buildContractRows([entry(1, 2, 7830, 0), entry(2, 2, 7830, 0)], (id) => (id === 1 ? timed : undefined));
    expect(contractTimedText(rows[0].timing, 50)).toBe('2h 10m 30s');
    expect(contractTimedText(rows[1].timing, 50)).toBe('None');
  });

  it('the ContractTable flags reach the timing record', () => {
    const meta = { contractName: 'R', description: '', nameNpcStart: '', descriptionProgress: '%d of 5', questflagRepeatTime: 'r' };
    const [row] = buildContractRows([entry(1, 6)], () => meta);
    expect(row.timing).toMatchObject({ hasRepeatFlag: true, hasTimerFlag: false, descriptionProgress: '%d of 5' });
    expect(contractProgressText(row.timing, 50)).toBe('2 of 5');
  });

  it('locations read as gmContractsUI::UpdateButtons prints them: the cell\'s map coords, Indoors, or blank', () => {
    // 0x7D64001C: landblock 0x7D/0x64, cell index 0x1B → lcoord (1003, 803) → (c − 1024) × 0.1 + 0.5.
    expect(contractLocText({ objCellId: 0x7D64001C, frame: { origin: { x: 50, y: 60 } } })).toBe('21.6S, 1.6W');
    // Only the cell id counts, not the frame (gid_to_lcoord).
    expect(contractLocText({ objCellId: 0x7D64001C, frame: { origin: { x: 1, y: 1 } } })).toBe('21.6S, 1.6W');
    // Holtburg's outdoor cell reads as the radar does, not ACE's 0.1-lower server text.
    expect(contractLocText({ objCellId: 0xA9B40019, frame: { origin: { x: 0, y: 0 } } })).toBe('42.1N, 33.6E');
    expect(contractLocText({ objCellId: 0x01D90108, frame: { origin: { x: 0, y: 0 } } })).toBe('Indoors');
    expect(contractLocText({ objCellId: 0, frame: { origin: { x: 0, y: 0 } } })).toBe('');
    expect(contractLocText(undefined)).toBe('');
  });

  it('Contact names the start NPC until the contract is handed in to a different end NPC', () => {
    const start = { objCellId: 0xA9B4001A, frame: { origin: { x: 0, y: 0 } } };
    const end = { objCellId: 0x01D90108, frame: { origin: { x: 0, y: 0 } } };
    const meta = { contractName: 'Q', description: '', nameNpcStart: 'Giver', nameNpcEnd: 'Taker', locationNpcStart: start, locationNpcEnd: end };
    expect(contractContact(meta, 1)).toEqual({ name: 'Giver', location: start });
    expect(contractContact(meta, 3)).toEqual({ name: 'Giver', location: start });
    expect(contractContact(meta, 2)).toEqual({ name: 'Taker', location: end });
    expect(contractContact(meta, 4)).toEqual({ name: 'Taker', location: end });
    // No end NPC: always the start one.
    expect(contractContact({ ...meta, nameNpcEnd: '' }, 2)).toEqual({ name: 'Giver', location: start });
    // No start NPC: the end one, whatever the stage.
    expect(contractContact({ ...meta, nameNpcStart: '' }, 1)).toEqual({ name: 'Taker', location: end });
    const rows = buildContractRows([{ version: 1, contractId: 7, stage: 2, timeWhenDone: 0, timeWhenRepeats: 0 }], () => meta);
    expect(rows[0].contact).toBe('Taker');
    expect(rows[0].contactLoc).toBe('Indoors');
  });

  it('FAITHFUL.206 — ContractTable meta supplies name/description/contact; fallback is Contract #N', () => {
    const meta = {
      contractName: 'The Reign of Terror', description: 'Recover the idol.',
      nameNpcStart: 'Fiun Luuk',
      locationNpcStart: { objCellId: 0x7D64001C, frame: { origin: { x: 50, y: 60 } } },
      locationQuestArea: { objCellId: 0, frame: { origin: { x: 0, y: 0 } } },
    };
    const rows = buildContractRows([entry(100, 2), entry(101, 2)],
      id => (id === 100 ? meta : undefined));
    expect(rows[0].name).toBe('The Reign of Terror');
    expect(rows[0].description).toBe('Recover the idol.');
    expect(rows[0].contact).toBe('Fiun Luuk');
    expect(rows[0].contactLoc).toBe(contractLocText(meta.locationNpcStart));
    expect(rows[0].contactLoc).toMatch(/[NS], .*[EW]$/);
    // objCellId 0 = no authored location → empty string.
    expect(rows[0].questLoc).toBe('');
    expect(rows[1].name).toBe('Contract #101');
  });

  it('CORE.15.a — raw stage + repeat time pass through for the Status header sort', () => {
    const rows = buildContractRows([entry(1, 3, 0, 500), entry(2, 2, 30, 0)], () => undefined);
    expect(rows[0].stage).toBe(3);
    expect(rows[0].timing.timeWhenRepeats).toBe(500);
    expect(rows[1].stage).toBe(2);
    expect(rows[1].timing.timeWhenRepeats).toBe(0);
  });
});

// RECON.contracts-tracker-retail — the AbandonContract round trip: the
// server answers with a ContractTracker carrying deleteContract, and the row
// is gone from the next rebuild (gmContractsUI::RecvNotice_UpdateContractTracker
// @ 0049a390 → RebuildContractList). The Abandon button (0x100005dc) sends
// at once — no confirmation (ListenToElementMessage @ 0049a3b0).
describe('contract tracker state: table, update, delete', async () => {
  const { applyContractTrackerTable, applyContractTracker } = await import('../packages/renderer/src/network/contractRows.js');
  const e = (contractId: number, stage = 2) => ({ version: 1, contractId, stage, timeWhenDone: 0, timeWhenRepeats: 0 });
  it('a table replaces the state, an update upserts with its receipt time, a delete drops the row', () => {
    const state = new Map();
    applyContractTrackerTable(state, [e(1), e(2)], 10);
    expect([...state.keys()]).toEqual([1, 2]);
    applyContractTracker(state, e(2, 3), false, 20);
    expect(state.get(2)).toMatchObject({ stage: 3, updatedAtSec: 20 });
    applyContractTracker(state, e(1), true, 30);
    const rows = buildContractRows(state.values(), () => undefined);
    expect(rows.map((r) => r.id)).toEqual([2]);
    applyContractTrackerTable(state, [e(5)], 40);
    expect([...state.keys()]).toEqual([5]);
  });
});
