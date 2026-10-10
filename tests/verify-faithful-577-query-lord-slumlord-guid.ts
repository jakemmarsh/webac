/**
 * FAITHFUL.577 — queryLord must ship a slumlord guid u32, not an empty payload.
 *
 * SOURCE-PIN.faithful-576-578-outbound-gameaction-payloads: this suite
 * previously readFileSync'd main.ts and regex-matched the helper's source
 * text instead of driving the real send-path and inspecting actual bytes.
 * Fixed by extracting the payload construction into `buildQueryLordPayload()`
 * / `parseQueryLordPayload()` in packages/network/src/MessageSerializer.ts
 * (mirrors buildJumpActionPayload/buildUseWithTargetPayload/
 * buildListAvailableHousesPayload); main.ts's `queryLord` helper now calls
 * the shared, exported, testable function.
 *
 * Pre-fix the `acDebug.queryLord` helper shipped a zero-byte payload
 * (`new Uint8Array(0)`), but ACE
 * `reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionHouseQueryLord.cs:13`
 * reads ONE u32 off the payload:
 *
 *     var lord = message.Payload.ReadUInt32();    // slumlord ID to request info for
 *
 * With an empty payload the server's `BinaryReader.ReadUInt32` throws
 * `EndOfStreamException`. ACE catches it in
 * `InboundMessageManager.cs:135-143` and silently log.Errors. The
 * handler is a no-op on the server side (`lord` is discarded —
 * GameActionHouseQueryLord has no body beyond the read), but the wire
 * format is still wrong: every invocation pollutes the server log,
 * which is a 1-to-1 faithfulness violation against the retail client's
 * actual wire shape.
 *
 * Sibling fix to FAITHFUL.576 (`listAvailableHouses` HouseType u32) and
 * FAITHFUL.578 (`listChannels` Channel u32) — all three correct a
 * one-field server-side read the client previously ignored.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildQueryLordPayload, parseQueryLordPayload, BinaryReader } from '@ac/network';

const REPO = resolve(__dirname, '..');

const ACE_ACTION_CS = resolve(
  REPO,
  'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionHouseQueryLord.cs',
);
const ACE_INBOUND_CS = resolve(
  REPO,
  'reference/ACE/Source/ACE.Server/Network/Managers/InboundMessageManager.cs',
);
const HAS_ACE_SRC = aceReferenceExists(ACE_ACTION_CS) && aceReferenceExists(ACE_INBOUND_CS);

describe('FAITHFUL.577 — ACE source still reads slumlord u32 off QueryLord payload', () => {
  it.skipIf(!HAS_ACE_SRC)('GameActionHouseQueryLord.cs reads `var lord = message.Payload.ReadUInt32()` exactly once', () => {
    const src = readFileSync(ACE_ACTION_CS, 'utf8');
    expect(src).toMatch(/var\s+lord\s*=\s*message\.Payload\.ReadUInt32\(\)/);
    const readCount = (src.match(/message\.Payload\.Read/g) ?? []).length;
    expect(readCount).toBe(1);
  });

  it.skipIf(!HAS_ACE_SRC)('InboundMessageManager catches read-past-end exceptions silently — no error chat goes back', () => {
    const src = readFileSync(ACE_INBOUND_CS, 'utf8');
    expect(src).toMatch(/actionHandlerInfo\.Handler\.Invoke\(message,\s*session\)/);
    expect(src).toMatch(/catch\s*\(Exception\s+ex\)[\s\S]+log\.Error/);
  });
});

describe('buildQueryLordPayload produces byte-exact wire bytes (behavioral)', () => {
  it('is exactly 4 bytes (never the pre-fix empty payload)', () => {
    expect(buildQueryLordPayload(0).length).toBe(4);
  });

  it('round-trips through parseQueryLordPayload with a distinct sentinel value', () => {
    const payload = buildQueryLordPayload(0xDEADBEEF);
    expect(parseQueryLordPayload(payload)).toEqual({ slumlordGuid: 0xDEADBEEF });
  });

  it('matches GameActionHouseQueryLord.cs field order via a raw BinaryReader', () => {
    // Bypass parseQueryLordPayload entirely so this test can't share a bug
    // with it.
    const payload = buildQueryLordPayload(0x12345678);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0x12345678);
    expect(reader.remaining).toBe(0);
  });

  it('supports the default value of 0 (server discards it, but the field is still mandatory)', () => {
    const payload = buildQueryLordPayload(0);
    expect(payload.length).toBe(4);
    expect(parseQueryLordPayload(payload)).toEqual({ slumlordGuid: 0 });
  });
});
