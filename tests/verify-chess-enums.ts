/**
 * Chess enum runtime audits: ChessColor, ChessMoveType, ChessMoveResult.
 *
 * Each enum file in @ac/shared must match the corresponding ACE source 1:1.
 * Walks reference/ACE/Source/ACE.Entity/Enum/Chess*.cs at test time so any
 * future ACE rebase that renames/renumbers a value breaks the audit
 * immediately.
 *
 * FAITHFUL.117 caught a real wire-value bug in ChessMoveType
 * (Grid/FromTo/SelectedPiece were 4/5/6 in ACE but our dispatch checked
 * 1/2/3). These audits prevent the same drift returning.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { ChessColor } from '../packages/shared/src/enums/ChessColor.js';
import { ChessMoveType } from '../packages/shared/src/enums/ChessMoveType.js';
import { ChessMoveResult, chessMoveResultText } from '../packages/shared/src/enums/ChessMoveResult.js';

const REPO = resolve(__dirname, '..');
const COLOR_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ChessColor.cs');
const MTYPE_PATH  = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ChessMoveType.cs');
const RESULT_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/ChessMoveResult.cs');

interface AceEntry { name: string; value: number; }

/**
 * Parse a numeric C# enum. Supports explicit (Name = value), implicit
 * (auto-incremented sequential), and negative literals.
 */
function parseAce(path: string, enumName: string): AceEntry[] {
  const src = readFileSync(path, 'utf8');
  const lines = src.split('\n');
  const out: AceEntry[] = [];
  let inside = false;
  let nextAuto = 0;
  const open = new RegExp(`enum\\s+${enumName}\\b`);
  for (const raw of lines) {
    const t = raw.trim();
    if (open.test(t)) { inside = true; continue; }
    if (!inside) continue;
    if (t === '}' || t.startsWith('};')) break;
    if (!t || t.startsWith('//') || t.startsWith('/*') || t.startsWith('*')) continue;
    // Skip commented-out members
    if (t.startsWith('//')) continue;
    const m = t.match(/^(\w+)\s*(?:=\s*(-?0x[0-9a-fA-F]+|-?\d+))?\s*,?/);
    if (m) {
      const name = m[1];
      // skip reserved keywords / block declarations
      if (['public', 'using', 'namespace', 'enum'].includes(name)) continue;
      let value: number;
      if (m[2] !== undefined) {
        value = Number(m[2]);
        nextAuto = value + 1;
      } else {
        value = nextAuto++;
      }
      out.push({ name, value });
    }
  }
  return out;
}

describe.skipIf(!aceReferenceExists(COLOR_PATH))('ACE ChessColor coverage (runtime audit)', () => {
  const entries = aceReferenceExists(COLOR_PATH) ? parseAce(COLOR_PATH, 'ChessColor') : [];
  it('found ACE entries (sanity)', () => {
    expect(entries.length).toBe(3); // None, White, Black
  });
  it.each(entries)('ChessColor.$name = $value', ({ name, value }) => {
    expect((ChessColor as unknown as Record<string, number>)[name]).toBe(value);
  });
});

describe.skipIf(!aceReferenceExists(MTYPE_PATH))('ACE ChessMoveType coverage (runtime audit)', () => {
  const entries = aceReferenceExists(MTYPE_PATH) ? parseAce(MTYPE_PATH, 'ChessMoveType') : [];
  it('found ACE entries (sanity)', () => {
    expect(entries.length).toBe(7); // Invalid, Pass, Resign, Stalemate, Grid, FromTo, SelectedPiece
  });
  it.each(entries)('ChessMoveType.$name = $value', ({ name, value }) => {
    expect((ChessMoveType as unknown as Record<string, number>)[name]).toBe(value);
  });
  it('FAITHFUL.117 wire-value pin: Grid/FromTo/SelectedPiece = 4/5/6', () => {
    expect(ChessMoveType.Grid).toBe(4);
    expect(ChessMoveType.FromTo).toBe(5);
    expect(ChessMoveType.SelectedPiece).toBe(6);
  });
});

describe.skipIf(!aceReferenceExists(RESULT_PATH))('ACE ChessMoveResult coverage (runtime audit)', () => {
  const entries = aceReferenceExists(RESULT_PATH) ? parseAce(RESULT_PATH, 'ChessMoveResult') : [];
  it('found ACE entries (sanity)', () => {
    // 6 OK codes + 15 Bad codes (incl. BadMoveInvalidBoardState)
    expect(entries.length).toBe(21);
  });
  it.each(entries)('ChessMoveResult.$name = $value', ({ name, value }) => {
    expect((ChessMoveResult as unknown as Record<string, number>)[name]).toBe(value);
  });
});

describe('chessMoveResultText canonical wordings', () => {
  it('returns null for successful / status codes', () => {
    expect(chessMoveResultText(ChessMoveResult.NoMoveResult)).toBeNull();
    expect(chessMoveResultText(ChessMoveResult.OKMoveToEmptySquare)).toBeNull();
    expect(chessMoveResultText(ChessMoveResult.OKMoveCheckmate)).toBeNull();
  });
  it('returns ACE-quoted strings for the failure codes', () => {
    expect(chessMoveResultText(ChessMoveResult.BadMoveInvalidCommand)).toBe('That move is invalid');
    expect(chessMoveResultText(ChessMoveResult.BadMoveDirection)).toBe('The selected piece cannot move that direction');
    expect(chessMoveResultText(ChessMoveResult.BadMoveSelfCheck)).toBe('That move would put you in check');
    expect(chessMoveResultText(ChessMoveResult.BadMoveWouldClobber)).toBe('You cannot attack your own pieces');
  });
  it('unknown codes return null', () => {
    expect(chessMoveResultText(0xDEAD)).toBeNull();
    expect(chessMoveResultText(-9999)).toBeNull();
  });
});
