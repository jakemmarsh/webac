/**
 * GAP.87 — UseWithTarget send-side payload audited against ACE C# read
 * order and converted to behavioral coverage.
 *
 * Previously constructed with an inline `new BinaryWriter(8)` directly in
 * main.ts's consumePendingUseWithTarget() (GAP.21's use-with-target
 * selection path), with no test exercising the actual byte layout — the
 * same "one-shot audit, never re-verified" gap flagged for the Jump
 * GameAction (see verify-jump-gameaction-send.ts). It's a 2-field payload,
 * so a source/target guid transposition is a real, plausible failure mode.
 *
 * Fix: extracted into buildUseWithTargetPayload() in
 * packages/network/src/MessageSerializer.ts (mirrors the
 * buildJumpActionPayload convention). main.ts's consumePendingUseWithTarget()
 * now calls the shared, exported, testable function instead of re-deriving
 * the byte layout inline.
 *
 * Wire format anchor: GameActionUseWithTarget.cs:10-11 —
 *   uint sourceObjectGuid = message.Payload.ReadUInt32();
 *   uint targetObjectGuid = message.Payload.ReadUInt32();
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildUseWithTargetPayload, parseUseWithTargetPayload, BinaryReader } from '@ac/network';

const REPO = resolve(__dirname, '..');
const USEWITHTARGET_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionUseWithTarget.cs'),
  'utf8',
);

describe('ACE source anchors the wire format we send (GAP.87)', () => {
  it('GameActionUseWithTarget.cs reads sourceObjectGuid then targetObjectGuid', () => {
    expect(USEWITHTARGET_CS).toMatch(
      /sourceObjectGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*uint targetObjectGuid = message\.Payload\.ReadUInt32\(\);/,
    );
  });
});

describe('buildUseWithTargetPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 8 bytes', () => {
    expect(buildUseWithTargetPayload(1, 2).length).toBe(8);
  });

  it('round-trips through parseUseWithTargetPayload with distinct sentinel values', () => {
    const payload = buildUseWithTargetPayload(0x1234, 0x5678);
    expect(parseUseWithTargetPayload(payload)).toEqual({ sourceGuid: 0x1234, targetGuid: 0x5678 });
  });

  it('matches GameActionUseWithTarget.cs field order exactly via a raw BinaryReader (a source/target transposition would fail this)', () => {
    const payload = buildUseWithTargetPayload(0xAAAA, 0xBBBB);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xAAAA); // sourceObjectGuid
    expect(reader.readUInt32()).toBe(0xBBBB); // targetObjectGuid
    expect(reader.remaining).toBe(0);
  });
});
