/**
 * FAITHFUL.194 — Contract + Housing event wiring.
 *
 * Pre-FAITHFUL.194 the network layer parsed ContractTracker + House*
 * events into structured handler callbacks, but main.ts didn't register
 * any. Result: contract panel rendered empty even when the server had
 * sent contract data, and house events vanished silently.
 *
 * This test asserts main.ts now installs:
 *   - onContractTrackerTable → gameUI.setContractData
 *   - onContractTracker (single-contract update — logged)
 *   - onHouseStatus → chat surface
 *   - onHouseProfile → chat surface (with house type + owner)
 *   - onHouseData → chat surface (with rent days + maintenance flag)
 *   - onHouseUpdateHAR → chat surface (guest + roommate count)
 *
 * Mirrors the existing wiring-drift-guard pattern (FAITHFUL.190).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN_SRC = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf-8');

describe('FAITHFUL.194/202 — Contract wiring + delta tracking', () => {
  it('registers onContractTrackerTable that patches the contract state', () => {
    expect(MAIN_SRC).toContain('onContractTrackerTable:');
    const idx = MAIN_SRC.indexOf('onContractTrackerTable:');
    const block = MAIN_SRC.slice(idx, idx + 1500);
    // FAITHFUL.202: full-table broadcast now routes through contractState +
    // publishContracts() shared helper rather than calling setContractData
    // inline. Verify both pieces are present.
    expect(block).toMatch(/contractState\.(clear|set)\b/);
    expect(block).toContain('publishContracts(');
  });

  it('publishContracts forwards into gameUI.setContractData', () => {
    expect(MAIN_SRC).toContain('publishContracts = (): void =>');
    const idx = MAIN_SRC.indexOf('publishContracts = (): void =>');
    // Window widened for the CORE.15 detail fields (contact/contactLoc/
    // questLoc) added inside the map.
    const block = MAIN_SRC.slice(idx, idx + 2600);
    expect(block).toContain('gameUI.setContractData(');
  });

  it('registers onContractTracker single-update handler with delete + display flags', () => {
    expect(MAIN_SRC).toContain('onContractTracker:');
    const idx = MAIN_SRC.indexOf('onContractTracker:');
    const block = MAIN_SRC.slice(idx, idx + 1500);
    expect(block).toContain('deleteContract');
    expect(block).toContain('setAsDisplayContract');
    expect(block).toContain('contractState.delete(');
    expect(block).toContain('contractState.set(');
  });
});

describe('FAITHFUL.194 — Housing wiring', () => {
  // CORE.17.k.b.b.a.g.d — the 0x226 HouseStatus is retail's
  // RecvNotice_FailedHouseTransaction: gmMapUI @ 004a18a0 clears the map's
  // house position, gmHouseUI::Update(ulong) @ 004a3460 drops its data and
  // redraws the panel, gmSlumlordUI @ 004c7fc0 likewise — none prints a
  // line (tests/verify-core17kbbagd-map-house-drag-tooltip.ts pins the
  // decomp). ACE answers every no-house QueryHouse (sent at PlayerCreate as
  // InitializePlayer does) with BadParam, so the former system line would
  // have greeted every login.
  it('registers onHouseStatus that clears the map house position and surfaces NOTHING to chat', () => {
    expect(MAIN_SRC).toContain('onHouseStatus:');
    const idx = MAIN_SRC.indexOf('onHouseStatus:');
    const block = MAIN_SRC.slice(idx, MAIN_SRC.indexOf('onHouseProfile:', idx));
    expect(block).toContain('gameUI.clearMapHousePosition()');
    expect(block).not.toContain('addSystemMessage');
  });

  it('registers onHouseProfile with house-type-name decode (FAITHFUL.289)', () => {
    // Pre-FAITHFUL.289 this was an inline `houseTypeNames` array with the
    // 5 entries Undef/Cottage/Villa/Mansion/Apartment duplicated across 3
    // handlers. Now uses the @ac/shared houseTypeName helper. See
    // verify-house-type-name.ts for the helper-output assertions.
    expect(MAIN_SRC).toContain('onHouseProfile:');
    const idx = MAIN_SRC.indexOf('onHouseProfile:');
    const block = MAIN_SRC.slice(idx, idx + 1500);
    expect(block).toMatch(/houseTypeName\(data\.houseType\)/);
  });

  it('registers onHouseData with rent-time decode', () => {
    expect(MAIN_SRC).toContain('onHouseData:');
    const idx = MAIN_SRC.indexOf('onHouseData:');
    const block = MAIN_SRC.slice(idx, idx + 1500);
    expect(block).toContain('data.rentTime');
    expect(block).toContain('maintenanceFree');
  });

  it('registers onHouseUpdateHAR with guest + roommate forwarding', () => {
    expect(MAIN_SRC).toContain('onHouseUpdateHAR:');
    const idx = MAIN_SRC.indexOf('onHouseUpdateHAR:');
    const block = MAIN_SRC.slice(idx, idx + 1000);
    // FAITHFUL.203: now forwards into the housing panel via setHouseData
    // instead of just logging a count to chat.
    expect(block).toContain('gameUI.setHouseData(');
    expect(block).toContain('data.guests.map');
    expect(block).toContain('data.roommates');
  });
});

describe('FAITHFUL.194/202/284 — ContractTracker stage decode', () => {
  it('contract rows decode stages via contractStageLabel (behavioral — CORE.15.a converted the source pin)', async () => {
    // Pre-FAITHFUL.284 this was a hardcoded CONTRACT_STAGE_NAMES Record map
    // with only 3 of 4 ACE values + the wrong "Complete" label. The row
    // building now lives in network/contractRows.ts (main.ts delegates);
    // execute the real builder instead of regexing main.ts source. Full
    // stage/timer/meta coverage: verify-contract-stage-enum.ts.
    const { buildContractRows } = await import('../packages/renderer/src/network/contractRows.js');
    const rows = buildContractRows(
      [{ version: 1, contractId: 9, stage: 4, timeWhenDone: 0, timeWhenRepeats: 0 }],
      () => undefined);
    // ProgressCounter=0x4 — the value the pre-fix map missed entirely.
    expect(rows[0].status).toBe('In Progress');
    expect(rows[0].status).not.toBe('Active');
  });
});
