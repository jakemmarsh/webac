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
import { ContractStage, contractStageLabel } from '@ac/shared';
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

describe('contractStageLabel (FAITHFUL.284)', () => {
  it('renders each of the 4 ACE stages', () => {
    expect(contractStageLabel(ContractStage.Available)).toBe('Available');
    expect(contractStageLabel(ContractStage.InProgress)).toBe('In Progress');
    expect(contractStageLabel(ContractStage.DoneOrPendingRepeat)).toBe('Done');
    expect(contractStageLabel(ContractStage.ProgressCounter)).toBe('In Progress');
  });

  it('falls back to "Active" for unknown values', () => {
    expect(contractStageLabel(0)).toBe('Active');
    expect(contractStageLabel(99)).toBe('Active');
  });

  it('the pre-fix bug — stage 4 (ProgressCounter) no longer falls back', () => {
    // Pre-fix this returned 'Active' because the map only had 1/2/3.
    expect(contractStageLabel(4)).not.toBe('Active');
    expect(contractStageLabel(4)).toBe('In Progress');
  });
});

// CORE.15.a — the former "main.ts wiring" source-text pins (regex over
// publishContracts in main.ts) are converted to behavioral tests: the row
// building now lives in network/contractRows.ts, imported and executed
// for real here. main.ts's publishContracts is a two-line delegation.
describe('buildContractRows (behavioral — FAITHFUL.284/206, GAP.32/35, CORE.15.a)', () => {
  const entry = (contractId: number, stage: number, timeWhenDone = 0, timeWhenRepeats = 0) =>
    ({ version: 1, contractId, stage, timeWhenDone, timeWhenRepeats });

  it('status + description run through contractStageLabel for all 4 ACE stages (no meta)', () => {
    const rows = buildContractRows(
      [entry(1, 1), entry(2, 2), entry(3, 3), entry(4, 4)], () => undefined);
    expect(rows.map(r => r.status)).toEqual(['Available', 'In Progress', 'Done', 'In Progress']);
    // With no ContractTable meta the description falls back to the label.
    expect(rows.map(r => r.description)).toEqual(['Available', 'In Progress', 'Done', 'In Progress']);
    // The pre-fix inline map fell back to 'Active' for ProgressCounter=4.
    expect(rows[3].status).not.toBe('Active');
  });

  it('GAP.35 — DoneOrPendingRepeat splits Pending Repeat (cooldown) vs Done', () => {
    const rows = buildContractRows([entry(1, 3, 0, 600), entry(2, 3, 0, 0)], () => undefined);
    expect(rows[0].status).toBe('Pending Repeat');
    expect(rows[1].status).toBe('Done');
  });

  it('GAP.32 — timer renders remaining-seconds countdowns, not epochs', () => {
    const rows = buildContractRows(
      [entry(1, 2, 7830, 0), entry(2, 3, 0, 100), entry(3, 1, 0, 0)], () => undefined);
    expect(rows[0].timer).toMatch(/^Done in /);
    expect(rows[0].timer).not.toContain('1970');
    expect(rows[1].timer).toMatch(/^Repeats in /);
    expect(rows[2].timer).toBe('');
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

  it('CORE.15.a — raw stage + repeatsSec pass through for the Status header sort', () => {
    const rows = buildContractRows([entry(1, 3, 0, 500), entry(2, 2, 30, 0)], () => undefined);
    expect(rows[0].stage).toBe(3);
    expect(rows[0].repeatsSec).toBe(500);
    expect(rows[1].stage).toBe(2);
    expect(rows[1].repeatsSec).toBe(0);
  });
});
