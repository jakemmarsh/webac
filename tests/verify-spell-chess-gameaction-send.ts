/**
 * GAP.87 — CastTargetedSpell, AddSpellFavorite, RemoveSpellFavorite, ChessJoin,
 * ChessMove, and StackableSplitTo3D send-side payloads audited against ACE C#
 * read order and converted to behavioral coverage.
 *
 * Previously each was constructed with a separate inline `new BinaryWriter(N)`
 * block at its call site in main.ts (sendCastAction's targeted branch, and the
 * addSpellFavorite/removeSpellFavorite/chessJoin/chessMove/stackableSplitTo3D
 * acDebug callbacks), with no test exercising the actual byte layout — the
 * same "one-shot audit, never re-verified, drift risk from copy-paste
 * duplication" gap flagged for the rest of this series.
 *
 * Fix: extracted into buildCastTargetedSpellPayload / buildAddSpellFavoritePayload
 * / buildRemoveSpellFavoritePayload / buildChessJoinPayload / buildChessMovePayload
 * / buildStackableSplitTo3DPayload in packages/network/src/MessageSerializer.ts
 * (mirrors the existing buildTargetedMeleeAttackPayload convention). main.ts's
 * call sites now call the shared, exported, testable functions instead of
 * re-deriving the byte layout inline.
 *
 * Wire format anchors:
 *   GameActionMagicCastTargetedSpell.cs — targetGuid u32 + spellId u32
 *   GameActionAddSpellFavorite.cs — spellId u32 + spellBarPositionId u32 + spellBarId u32
 *   GameActionRemoveSpellFavorite.cs — spellId u32 + spellBarId u32
 *   GameActionChessJoin.cs — boardGuid u32 + color i32 (unused by server)
 *   GameActionChessMove.cs + ChessPieceCoord.cs — from.X i32 + from.Y i32 + to.X i32 + to.Y i32
 *   GameActionStackableSplitTo3D.cs — stackId u32 + amount i32
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  buildCastTargetedSpellPayload, parseCastTargetedSpellPayload,
  buildAddSpellFavoritePayload, parseAddSpellFavoritePayload,
  buildRemoveSpellFavoritePayload, parseRemoveSpellFavoritePayload,
  buildChessJoinPayload, parseChessJoinPayload,
  buildChessMovePayload, parseChessMovePayload,
  buildStackableSplitTo3DPayload, parseStackableSplitTo3DPayload,
  BinaryReader,
} from '@ac/network';

const REPO = resolve(__dirname, '..');
const CAST_TARGETED_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionMagicCastTargetedSpell.cs'),
  'utf8',
);
const ADD_FAVORITE_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionAddSpellFavorite.cs'),
  'utf8',
);
const REMOVE_FAVORITE_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionRemoveSpellFavorite.cs'),
  'utf8',
);
const CHESS_JOIN_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionChessJoin.cs'),
  'utf8',
);
const CHESS_MOVE_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionChessMove.cs'),
  'utf8',
);
const CHESS_PIECE_COORD_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Entity/Chess/ChessPieceCoord.cs'),
  'utf8',
);
const STACKABLE_SPLIT_TO_3D_CS = readFileSync(
  resolve(REPO, 'reference/ACE/Source/ACE.Server/Network/GameAction/Actions/GameActionStackableSplitTo3D.cs'),
  'utf8',
);

describe('ACE source anchors the wire format we send (GAP.87)', () => {
  it('GameActionMagicCastTargetedSpell.cs reads targetGuid then spellId (both u32)', () => {
    expect(CAST_TARGETED_CS).toMatch(
      /targetGuid = message\.Payload\.ReadUInt32\(\);\s*\n\s*var spellId = message\.Payload\.ReadUInt32\(\);/,
    );
  });

  it('GameActionAddSpellFavorite.cs reads spellId, spellBarPositionId, spellBarId (all u32) in that order', () => {
    expect(ADD_FAVORITE_CS).toMatch(
      /spellId = message\.Payload\.ReadUInt32\(\);\s*\n\s*uint spellBarPositionId = message\.Payload\.ReadUInt32\(\);\s*\n\s*uint spellBarId = message\.Payload\.ReadUInt32\(\);/,
    );
  });

  it('GameActionRemoveSpellFavorite.cs reads spellId then spellBarId (both u32)', () => {
    expect(REMOVE_FAVORITE_CS).toMatch(
      /spellId = message\.Payload\.ReadUInt32\(\);\s*\n\s*uint spellBarId = message\.Payload\.ReadUInt32\(\);/,
    );
  });

  it('GameActionChessJoin.cs reads boardGuid (u32) then color (i32)', () => {
    expect(CHESS_JOIN_CS).toMatch(
      /boardGuid = message\.Payload\.ReadUInt32\(\);.*\n\s*var color = message\.Payload\.ReadInt32\(\);/,
    );
  });

  it('GameActionChessMove.cs reads from then to, both via ReadChessPieceCoord', () => {
    expect(CHESS_MOVE_CS).toMatch(
      /from = message\.Payload\.ReadChessPieceCoord\(\);\s*\n\s*var to = message\.Payload\.ReadChessPieceCoord\(\);/,
    );
  });

  it('ChessPieceCoord.cs reads X then Y (both i32) in its BinaryReader ctor', () => {
    expect(CHESS_PIECE_COORD_CS).toMatch(
      /X = reader\.ReadInt32\(\);\s*\n\s*Y = reader\.ReadInt32\(\);/,
    );
  });

  it('GameActionStackableSplitTo3D.cs reads stackId (u32) then amount (i32)', () => {
    expect(STACKABLE_SPLIT_TO_3D_CS).toMatch(
      /stackId\s+= message\.Payload\.ReadUInt32\(\);\s*\n\s*int amount\s+= message\.Payload\.ReadInt32\(\);/,
    );
  });
});

describe('buildCastTargetedSpellPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 8 bytes', () => {
    expect(buildCastTargetedSpellPayload(1, 2).length).toBe(8);
  });

  it('round-trips through parseCastTargetedSpellPayload with distinct sentinel values', () => {
    const payload = buildCastTargetedSpellPayload(0x1234, 0x5678);
    expect(parseCastTargetedSpellPayload(payload)).toEqual({ targetGuid: 0x1234, spellId: 0x5678 });
  });

  it('matches GameActionMagicCastTargetedSpell.cs field order exactly via a raw BinaryReader (a targetGuid/spellId transposition would fail this)', () => {
    const payload = buildCastTargetedSpellPayload(0xAAAA, 0xBBBB);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xAAAA); // targetGuid
    expect(reader.readUInt32()).toBe(0xBBBB); // spellId
    expect(reader.remaining).toBe(0);
  });
});

describe('buildAddSpellFavoritePayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 12 bytes', () => {
    expect(buildAddSpellFavoritePayload(1, 2, 3).length).toBe(12);
  });

  it('round-trips through parseAddSpellFavoritePayload with distinct sentinel values', () => {
    const payload = buildAddSpellFavoritePayload(0x111, 5, 2);
    expect(parseAddSpellFavoritePayload(payload)).toEqual({ spellId: 0x111, spellBarPositionId: 5, spellBarId: 2 });
  });

  it('matches GameActionAddSpellFavorite.cs field order exactly via a raw BinaryReader (a field transposition would fail this)', () => {
    const payload = buildAddSpellFavoritePayload(0xCCCC, 7, 1);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xCCCC); // spellId
    expect(reader.readUInt32()).toBe(7);      // spellBarPositionId
    expect(reader.readUInt32()).toBe(1);      // spellBarId
    expect(reader.remaining).toBe(0);
  });
});

describe('buildRemoveSpellFavoritePayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 8 bytes', () => {
    expect(buildRemoveSpellFavoritePayload(1, 2).length).toBe(8);
  });

  it('round-trips through parseRemoveSpellFavoritePayload with distinct sentinel values', () => {
    const payload = buildRemoveSpellFavoritePayload(0x222, 6);
    expect(parseRemoveSpellFavoritePayload(payload)).toEqual({ spellId: 0x222, spellBarId: 6 });
  });

  it('matches GameActionRemoveSpellFavorite.cs field order exactly via a raw BinaryReader (a spellId/spellBarId transposition would fail this)', () => {
    const payload = buildRemoveSpellFavoritePayload(0xDDDD, 3);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xDDDD); // spellId
    expect(reader.readUInt32()).toBe(3);      // spellBarId
    expect(reader.remaining).toBe(0);
  });
});

describe('buildChessJoinPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 8 bytes', () => {
    expect(buildChessJoinPayload(1).length).toBe(8);
  });

  it('round-trips through parseChessJoinPayload, always sending color -1 (unused by server)', () => {
    const payload = buildChessJoinPayload(0x9999);
    expect(parseChessJoinPayload(payload)).toEqual({ boardGuid: 0x9999, color: -1 });
  });

  it('matches GameActionChessJoin.cs field order exactly via a raw BinaryReader (boardGuid then color)', () => {
    const payload = buildChessJoinPayload(0xEEEE);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xEEEE); // boardGuid
    expect(reader.readInt32()).toBe(-1);      // color
    expect(reader.remaining).toBe(0);
  });
});

describe('buildChessMovePayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 16 bytes', () => {
    expect(buildChessMovePayload(1, 2, 3, 4).length).toBe(16);
  });

  it('round-trips through parseChessMovePayload with distinct sentinel values', () => {
    const payload = buildChessMovePayload(1, 7, 4, 0);
    expect(parseChessMovePayload(payload)).toEqual({ fromX: 1, fromY: 7, toX: 4, toY: 0 });
  });

  it('matches GameActionChessMove.cs + ChessPieceCoord.cs field order exactly via a raw BinaryReader (a from/to or X/Y transposition would fail this)', () => {
    const payload = buildChessMovePayload(2, 5, 6, 1);
    const reader = new BinaryReader(payload);
    expect(reader.readInt32()).toBe(2); // fromX
    expect(reader.readInt32()).toBe(5); // fromY
    expect(reader.readInt32()).toBe(6); // toX
    expect(reader.readInt32()).toBe(1); // toY
    expect(reader.remaining).toBe(0);
  });
});

describe('buildStackableSplitTo3DPayload produces byte-exact wire bytes (GAP.87 — behavioral)', () => {
  it('is exactly 8 bytes', () => {
    expect(buildStackableSplitTo3DPayload(1, 2).length).toBe(8);
  });

  it('round-trips through parseStackableSplitTo3DPayload with distinct sentinel values', () => {
    const payload = buildStackableSplitTo3DPayload(0x333, 10);
    expect(parseStackableSplitTo3DPayload(payload)).toEqual({ stackId: 0x333, amount: 10 });
  });

  it('matches GameActionStackableSplitTo3D.cs field order exactly via a raw BinaryReader (a stackId/amount transposition would fail this)', () => {
    const payload = buildStackableSplitTo3DPayload(0xFFFF, 99);
    const reader = new BinaryReader(payload);
    expect(reader.readUInt32()).toBe(0xFFFF); // stackId
    expect(reader.readInt32()).toBe(99);      // amount
    expect(reader.remaining).toBe(0);
  });
});
