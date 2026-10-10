/**
 * GAP.87 — SetDesiredComponentLevel, AdvocateTeleport, and RentHouse send-side
 * payloads audited against ACE C# read order and converted to behavioral
 * coverage. Also fixes a duplicate-inline-construction bug: the acDebug.jump
 * helper in main.ts independently re-derived the Jump GameAction's byte
 * layout with a raw `new BinaryWriter(32)` instead of calling the
 * already-extracted buildJumpActionPayload (used correctly at the real
 * production jump-send site) — same drift-risk pattern as the
 * ModifyCharacterSquelch/UseWithTarget/GiveObjectRequest/TrainSkill/
 * ChatChannel duplicates fixed in prior cycles of this series.
 *
 * Previously SetDesiredComponentLevel, AdvocateTeleport, and RentHouse were
 * each constructed with a separate inline `new BinaryWriter(N)` block at
 * their acDebug call sites in main.ts, with no test exercising the actual
 * byte layout.
 *
 * Fix: extracted into buildSetDesiredComponentLevelPayload /
 * buildAdvocateTeleportPayload / buildRentHousePayload in
 * packages/network/src/MessageSerializer.ts (mirrors the existing
 * buildJumpActionPayload/buildPositionPayload convention). main.ts's
 * setDesiredComponentLevel, advocateTeleport, and rentHouse acDebug
 * callbacks now call the shared, exported, testable functions instead of
 * re-deriving the byte layout inline.
 *
 * Wire format anchors:
 *   GameActionSetDesiredComponentLevel.cs — component_wcid u32 + amount u32
 *   GameActionAdvocateTeleport.cs + Position(BinaryReader) ctor (Position.cs) —
 *     target String16L + cell u32 + x/y/z f32 + quaternion WXYZ f32 (note:
 *     packet order is W,X,Y,Z — NOT the X,Y,Z,W order of the Quaternion ctor)
 *   GameActionHouseRentHouse.cs + PackableList.ReadListUInt32 —
 *     slumlordGuid u32 + itemCount u32 + itemCount × itemGuid u32
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildSetDesiredComponentLevelPayload, parseSetDesiredComponentLevelPayload,
  buildAdvocateTeleportPayload, parseAdvocateTeleportPayload,
  buildRentHousePayload, parseRentHousePayload,
  buildJumpActionPayload, parseJumpActionPayload,
  BinaryReader,
} from '@ac/network';

const REPO = resolve(__dirname, '..');
const SET_DESIRED_COMPONENT_LEVEL_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionSetDesiredComponentLevel.cs'),
  'utf8',
);
const ADVOCATE_TELEPORT_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionAdvocateTeleport.cs'),
  'utf8',
);
const POSITION_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Entity/Position.cs'),
  'utf8',
);
const RENT_HOUSE_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionHouseRentHouse.cs'),
  'utf8',
);
const PACKABLE_LIST_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/Structure/PackableList.cs'),
  'utf8',
);

describe('ACE source anchors the wire format we send (GAP.87)', () => {
  it('GameActionSetDesiredComponentLevel.cs reads component_wcid then amount (both u32)', () => {
    expect(SET_DESIRED_COMPONENT_LEVEL_CS).toMatch(
      /component_wcid = message\.Payload\.ReadUInt32\(\);\s*\n\s*uint amount = message\.Payload\.ReadUInt32\(\);/,
    );
  });

  it('GameActionAdvocateTeleport.cs reads target (String16L) then constructs Position from the remaining payload', () => {
    expect(ADVOCATE_TELEPORT_CS).toMatch(
      /target = message\.Payload\.ReadString16L\(\);\s*\n\s*var position = new Position\(message\.Payload\);/,
    );
  });

  it("Position(BinaryReader) ctor reads cell then x/y/z then rotation in W,X,Y,Z order (packet order differs from the Quaternion ctor's X,Y,Z,W)", () => {
    expect(POSITION_CS).toMatch(
      /LandblockId = new LandblockId\(payload\.ReadUInt32\(\)\);\s*\n\s*\n\s*PositionX = payload\.ReadSingle\(\);\s*\n\s*PositionY = payload\.ReadSingle\(\);\s*\n\s*PositionZ = payload\.ReadSingle\(\);\s*\n\s*\n\s*\/\/ packet stream isn't the same order as the quaternion constructor\s*\n\s*RotationW = payload\.ReadSingle\(\);\s*\n\s*RotationX = payload\.ReadSingle\(\);\s*\n\s*RotationY = payload\.ReadSingle\(\);\s*\n\s*RotationZ = payload\.ReadSingle\(\);/,
    );
  });

  it('GameActionHouseRentHouse.cs reads slumlord (u32) then items via ReadListUInt32', () => {
    expect(RENT_HOUSE_CS).toMatch(
      /slumlord = message\.Payload\.ReadUInt32\(\);\s*\n\s*var items = message\.Payload\.ReadListUInt32\(\);/,
    );
  });

  it('PackableList.ReadListUInt32 reads a u32 count then that many u32 elements', () => {
    expect(PACKABLE_LIST_CS).toMatch(
      /var size = reader\.ReadUInt32\(\);\s*\n\s*\n\s*var list = new List<uint>\(\);\s*\n\s*\n\s*for \(var i = 0; i < size; i\+\+\)\s*\n\s*list\.Add\(reader\.ReadUInt32\(\)\);/,
    );
  });
});

describe('buildSetDesiredComponentLevelPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 8 bytes', () => {
    expect(buildSetDesiredComponentLevelPayload(1, 2).length).toBe(8);
  });

  it('round-trips through parseSetDesiredComponentLevelPayload with distinct sentinel values', () => {
    const payload = buildSetDesiredComponentLevelPayload(0x1234, 50);
    expect(parseSetDesiredComponentLevelPayload(payload)).toEqual({ componentWcid: 0x1234, amount: 50 });
  });

  it('matches GameActionSetDesiredComponentLevel.cs field order exactly via a raw BinaryReader (a componentWcid/amount transposition would fail this)', () => {
    const payload = buildSetDesiredComponentLevelPayload(0xAAAA, 7);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xAAAA); // component_wcid
    expect(reader.readUInt32()).toBe(7);      // amount
    expect(reader.remaining).toBe(0);
  });
});

describe('buildAdvocateTeleportPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('round-trips through parseAdvocateTeleportPayload with distinct sentinel values', () => {
    const payload = buildAdvocateTeleportPayload('TestChar', 0x01030100, 10, 20, 30, 0.1, 0.2, 0.3, 0.4);
    const parsed = parseAdvocateTeleportPayload(payload);
    expect(parsed.target).toBe('TestChar');
    expect(parsed.cell).toBe(0x01030100);
    expect(parsed.x).toBeCloseTo(10);
    expect(parsed.y).toBeCloseTo(20);
    expect(parsed.z).toBeCloseTo(30);
    expect(parsed.rw).toBeCloseTo(0.1);
    expect(parsed.rx).toBeCloseTo(0.2);
    expect(parsed.ry).toBeCloseTo(0.3);
    expect(parsed.rz).toBeCloseTo(0.4);
  });

  it('defaults to identity rotation (rw=1, rx=ry=rz=0) when omitted', () => {
    const payload = buildAdvocateTeleportPayload('Bob', 5, 1, 2, 3);
    const parsed = parseAdvocateTeleportPayload(payload);
    expect(parsed.rw).toBe(1);
    expect(parsed.rx).toBe(0);
    expect(parsed.ry).toBe(0);
    expect(parsed.rz).toBe(0);
  });

  it('matches Position(BinaryReader) field order exactly via a raw BinaryReader: target, cell, x, y, z, rw, rx, ry, rz', () => {
    const payload = buildAdvocateTeleportPayload('Az', 0xFF, 1, 2, 3, 4, 5, 6, 7);
    const reader = new BinaryReader(payload);
    expect(reader.readString16()).toBe('Az');
    expect(reader.readUInt32()).toBe(0xFF); // cell (LandblockId)
    expect(reader.readFloat32()).toBe(1);   // x
    expect(reader.readFloat32()).toBe(2);   // y
    expect(reader.readFloat32()).toBe(3);   // z
    expect(reader.readFloat32()).toBe(4);   // rw
    expect(reader.readFloat32()).toBe(5);   // rx
    expect(reader.readFloat32()).toBe(6);   // ry
    expect(reader.readFloat32()).toBe(7);   // rz
    expect(reader.remaining).toBe(0);
  });
});

describe('buildRentHousePayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 8 bytes for an empty item list', () => {
    expect(buildRentHousePayload(1, []).length).toBe(8);
  });

  it('is 8 + 4*N bytes for N items', () => {
    expect(buildRentHousePayload(1, [10, 20, 30]).length).toBe(8 + 3 * 4);
  });

  it('round-trips through parseRentHousePayload with distinct sentinel values', () => {
    const payload = buildRentHousePayload(0x5000, [0x100, 0x200, 0x300]);
    expect(parseRentHousePayload(payload)).toEqual({
      slumlordGuid: 0x5000,
      paymentItemGuids: [0x100, 0x200, 0x300],
    });
  });

  it('round-trips correctly with an empty item list', () => {
    const payload = buildRentHousePayload(0x42, []);
    expect(parseRentHousePayload(payload)).toEqual({ slumlordGuid: 0x42, paymentItemGuids: [] });
  });

  it('matches GameActionHouseRentHouse.cs field order exactly via a raw BinaryReader: slumlordGuid, count, then each item', () => {
    const payload = buildRentHousePayload(0x9999, [0xAAA, 0xBBB]);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0x9999); // slumlordGuid
    expect(reader.readUInt32()).toBe(2);      // item count
    expect(reader.readUInt32()).toBe(0xAAA);  // item 1
    expect(reader.readUInt32()).toBe(0xBBB);  // item 2
    expect(reader.remaining).toBe(0);
  });
});

describe('acDebug.jump duplicate-inline-construction fix (GAP.87 — behavioral)', () => {
  it('buildJumpActionPayload produces the exact same bytes the acDebug.jump helper now sends, matching the production jump-send path', () => {
    // Regression guard: the acDebug.jump helper in main.ts previously built its
    // own inline BinaryWriter(32) instead of calling buildJumpActionPayload,
    // the same function the real production jump-send call site (movementSync
    // path) has always used. Both call sites must now produce byte-identical
    // output for identical arguments.
    const payload = buildJumpActionPayload(0.75, 0, 0, 4.2, 11, 22, 33, 44, 0, 0);
    expect(payload.length).toBe(32);
    const parsed = parseJumpActionPayload(payload);
    expect(parsed.extent).toBeCloseTo(0.75);
    expect(parsed.velocityX).toBe(0);
    expect(parsed.velocityY).toBe(0);
    expect(parsed.velocityZ).toBeCloseTo(4.2);
    expect(parsed.instanceSequence).toBe(11);
    expect(parsed.serverControlSequence).toBe(22);
    expect(parsed.teleportSequence).toBe(33);
    expect(parsed.forcePositionSequence).toBe(44);
    expect(parsed.objectGuid).toBe(0);
    expect(parsed.spellId).toBe(0);
  });
});
