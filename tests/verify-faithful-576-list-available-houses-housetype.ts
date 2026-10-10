/**
 * FAITHFUL.576 — listAvailableHouses must ship a HouseType u32, not an empty payload.
 *
 * SOURCE-PIN.faithful-576-578-outbound-gameaction-payloads: this suite
 * previously readFileSync'd main.ts and regex-matched the helper's source
 * text (pulling the "block" out via a docblock-marker regex) instead of
 * driving the real send-path with constructed inputs and inspecting the
 * actual bytes produced — a field-order or byte-count bug in the payload
 * itself would have passed silently since nothing ever built or decoded a
 * buffer. Fixed by extracting the payload construction into
 * `buildListAvailableHousesPayload()` / `parseListAvailableHousesPayload()`
 * in packages/network/src/MessageSerializer.ts (mirrors the existing
 * buildJumpActionPayload/buildUseWithTargetPayload convention, and follows
 * the established pattern from tests/verify-jump-gameaction-send.ts +
 * tests/verify-usewithtarget-gameaction-send.ts). main.ts's
 * `listAvailableHouses` helper now calls the shared, exported, testable
 * function instead of constructing a `new BinaryWriter(4)` inline.
 *
 * Pre-fix (original FAITHFUL.576 bug) the `acDebug.listAvailableHouses`
 * helper shipped a zero-byte payload (`new Uint8Array(0)`), but ACE
 * `reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionHouseListAvailable.cs:14-19`
 * reads ONE u32 off the payload:
 *
 *     var houseType = (HouseType)message.Payload.ReadUInt32();
 *     session.Player.HandleActionListAvailable(houseType);
 *
 * With an empty payload the server's `BinaryReader.ReadUInt32` throws
 * `EndOfStreamException`. ACE catches it in `InboundMessageManager.cs:135-143`
 * and logs an error — the response `GameEventHouseAvailableHouses` is
 * never enqueued. Visible bug (pre-fix): the housing browser sits empty
 * even though the slumlord world inventory has dozens of cottages/villas
 * for sale.
 *
 * HouseType enum per ACE `ACE.Entity/Enum/HouseType.cs`:
 *   Undef=0, Cottage=1, Villa=2, Mansion=3, Apartment=4.
 *
 * Helper defaults to Cottage (1) — the smallest tier, matches the
 * @hslist command default that this GameAction backs. Sibling to
 * FAITHFUL.577 (QueryLord) and FAITHFUL.578 (ListChannels) — same shape,
 * one mandatory u32 field the pre-fix client dropped silently.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildListAvailableHousesPayload, parseListAvailableHousesPayload, BinaryReader } from '@ac/network';

const REPO = resolve(__dirname, '..');

const ACE_ACTION_CS = resolve(
  REPO,
  'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionHouseListAvailable.cs',
);
const ACE_HOUSETYPE_CS = resolve(
  REPO,
  'reference/ACE/Source/ACE.Entity/Enum/HouseType.cs',
);
const ACE_INBOUND_CS = resolve(
  REPO,
  'reference/ACE/Source/ACE.Server/Network/Managers/InboundMessageManager.cs',
);
const HAS_ACE_SRC = aceReferenceExists(ACE_ACTION_CS) && aceReferenceExists(ACE_HOUSETYPE_CS) && aceReferenceExists(ACE_INBOUND_CS);

describe('FAITHFUL.576 — ACE source anchors for ListAvailableHouses HouseType wire field', () => {
  it.skipIf(!HAS_ACE_SRC)('GameActionHouseListAvailable.cs reads `(HouseType)message.Payload.ReadUInt32()`', () => {
    const src = readFileSync(ACE_ACTION_CS, 'utf8');
    expect(src).toMatch(/\(HouseType\)message\.Payload\.ReadUInt32\(\)/);
    expect(src).toMatch(/HandleActionListAvailable\(houseType\)/);
  });

  it.skipIf(!HAS_ACE_SRC)('HouseType enum places Cottage at 1 (matches our default)', () => {
    const src = readFileSync(ACE_HOUSETYPE_CS, 'utf8');
    const lines = src.split('\n').map(l => l.trim());
    const order = ['Undef', 'Cottage', 'Villa', 'Mansion', 'Apartment'];
    const positions = order.map(name =>
      lines.findIndex(l => new RegExp(`^${name}\\b`).test(l)),
    );
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1]);
    }
  });

  it.skipIf(!HAS_ACE_SRC)('InboundMessageManager catches the empty-payload exception silently — no server error message goes back to the client', () => {
    const src = readFileSync(ACE_INBOUND_CS, 'utf8');
    expect(src).toMatch(/actionHandlerInfo\.Handler\.Invoke\(message,\s*session\)/);
    expect(src).toMatch(/catch\s*\(Exception\s+ex\)[\s\S]+log\.Error/);
  });
});

describe('buildListAvailableHousesPayload produces byte-exact wire bytes (behavioral)', () => {
  it('is exactly 4 bytes (never the pre-fix empty payload)', () => {
    expect(buildListAvailableHousesPayload(1).length).toBe(4);
  });

  it('round-trips through parseListAvailableHousesPayload', () => {
    const payload = buildListAvailableHousesPayload(3); // Mansion
    expect(parseListAvailableHousesPayload(payload)).toEqual({ houseType: 3 });
  });

  it('matches GameActionHouseListAvailable.cs field order via a raw BinaryReader', () => {
    // Bypass parseListAvailableHousesPayload entirely so this test can't
    // share a bug with it.
    const payload = buildListAvailableHousesPayload(2); // Villa
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(2);
    expect(reader.remaining).toBe(0);
  });

  it('carries every HouseType enum value distinctly (Undef=0 through Apartment=4)', () => {
    for (const houseType of [0, 1, 2, 3, 4]) {
      const parsed = parseListAvailableHousesPayload(buildListAvailableHousesPayload(houseType));
      expect(parsed.houseType).toBe(houseType);
    }
  });
});
