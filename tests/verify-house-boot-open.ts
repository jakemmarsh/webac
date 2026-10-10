/**
 * FAITHFUL.418 — Additional /house subcommands: boot + open|close.
 *
 * Pre-fix the /house dispatcher only knew add/remove/guests/hooks
 * (FAITHFUL.409 + .410). Two more retail homeowner commands were
 * unwired: boot a specific guest, toggle public-access status.
 *
 * Pre-fix this test only regex-matched the `case 'house'` dispatch
 * block in main.ts for opcode names and rough payload shape — it never
 * drove the actual wire-format builders end-to-end. main.ts's boot and
 * open|close branches now call buildBootSpecificHouseGuestPayload /
 * buildSetOpenHouseStatusPayload (packages/network/src/MessageSerializer.ts),
 * the same shared-builder pattern used for every other outbound
 * GameAction in this codebase (e.g. buildChangeStoragePermissionPayload).
 * The @house boot / open / close commands are now the retail DoHouse port
 * (chat/commands/DeathTravelHouseCommands.ts, verify-retail-commands-death-
 * travel-house.ts). This test drives the payload builders directly and round-trips them through
 * their paired parsers to assert on the actual emitted bytes.
 *
 * ACE refs:
 *   reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionHouseBootSpecificGuest.cs
 *     — playerName String16L.
 *   GameActionHouseSetOpenStatus.cs — openHouse u32 (bool).
 */
import { describe, it, expect } from 'vitest';
import {
  buildBootSpecificHouseGuestPayload, parseBootSpecificHouseGuestPayload,
  buildSetOpenHouseStatusPayload, parseSetOpenHouseStatusPayload,
} from '@ac/network';

describe('buildBootSpecificHouseGuestPayload (FAITHFUL.418 — behavioral)', () => {
  it('round-trips the target player name as a String16L', () => {
    const payload = buildBootSpecificHouseGuestPayload('SammyBob');
    expect(parseBootSpecificHouseGuestPayload(payload)).toEqual({ playerName: 'SammyBob' });
  });

  it('round-trips names containing spaces', () => {
    const payload = buildBootSpecificHouseGuestPayload('Sammy Bob');
    expect(parseBootSpecificHouseGuestPayload(payload)).toEqual({ playerName: 'Sammy Bob' });
  });
});

describe('buildSetOpenHouseStatusPayload (FAITHFUL.418 — behavioral)', () => {
  it('round-trips open as a true uint32 bool', () => {
    const payload = buildSetOpenHouseStatusPayload(true);
    expect(parseSetOpenHouseStatusPayload(payload)).toEqual({ openHouse: true });
  });

  it('round-trips close as a false uint32 bool', () => {
    const payload = buildSetOpenHouseStatusPayload(false);
    expect(parseSetOpenHouseStatusPayload(payload)).toEqual({ openHouse: false });
  });
});
