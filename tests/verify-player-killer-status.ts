/**
 * PlayerKillerStatus enum runtime audit + label helper test.
 *
 * Wire format: bitfield carried on PropertyInt.PlayerKillerStatus (134).
 * Source: reference/ACE/Source/ACE.Entity/Enum/PlayerKillerStatus.cs.
 *
 * Pre-FAITHFUL.131 GameUI.setPKStatus had bare-hex 0x04 / 0x40 checks
 * with no symbolic enum, and the special "Protected", "Free",
 * "RubberGlue" alias bits were not represented at all. Now the bitfield
 * lives in @ac/shared with its values pinned against ACE source.
 */
import { describe, it, expect } from 'vitest';
import { aceReferenceExists } from './_harness/reference.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  PlayerKillerStatus,
  playerKillerStatusLabel,
} from '../packages/shared/src/enums/PlayerKillerStatus.js';

const REPO = resolve(__dirname, '..');
const ACE_PATH = resolve(REPO, 'reference/ACE/Source/ACE.Entity/Enum/PlayerKillerStatus.cs');

interface AceEntry { name: string; value: number; }

function parseAce(): AceEntry[] {
  const src = readFileSync(ACE_PATH, 'utf8');
  const lines = src.split('\n');
  const out: AceEntry[] = [];
  let inside = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (/enum\s+PlayerKillerStatus\b/.test(t)) { inside = true; continue; }
    if (!inside) continue;
    if (t === '}' || t.startsWith('};')) break;
    // Skip aliases like `Creature = Unprotected` — they're not their own values.
    const m = t.match(/^(\w+)\s*=\s*(0x[0-9a-fA-F]+|\d+)/);
    if (m) out.push({ name: m[1], value: Number(m[2]) });
  }
  return out;
}

describe.skipIf(!aceReferenceExists(ACE_PATH))('ACE PlayerKillerStatus coverage (FAITHFUL.131)', () => {
  const entries = parseAce();
  it('found ACE entries (sanity)', () => {
    // Undef + 7 named values (Protected/NPK/PK/Unprotected/RubberGlue/Free/PKLite)
    expect(entries.length).toBe(8);
  });
  it.each(entries)('PlayerKillerStatus.$name = $value', ({ name, value }) => {
    expect(
      (PlayerKillerStatus as unknown as Record<string, number>)[name],
    ).toBe(value);
  });
});

describe('playerKillerStatusLabel', () => {
  it('PK bit → "Player Killer"', () => {
    expect(playerKillerStatusLabel(PlayerKillerStatus.PK)).toBe('Player Killer');
  });
  it('PKLite bit → "Player Killer Lite"', () => {
    expect(playerKillerStatusLabel(PlayerKillerStatus.PKLite)).toBe('Player Killer Lite');
  });
  it('NPK / Protected / Unprotected / Free → "Non-Player Killer"', () => {
    expect(playerKillerStatusLabel(PlayerKillerStatus.NPK)).toBe('Non-Player Killer');
    expect(playerKillerStatusLabel(PlayerKillerStatus.Protected)).toBe('Non-Player Killer');
    expect(playerKillerStatusLabel(PlayerKillerStatus.Unprotected)).toBe('Non-Player Killer');
    expect(playerKillerStatusLabel(PlayerKillerStatus.Free)).toBe('Non-Player Killer');
  });
  it('PK + PKLite combined → "Player Killer" (PK wins per order in classic AC)', () => {
    expect(playerKillerStatusLabel(PlayerKillerStatus.PK | PlayerKillerStatus.PKLite))
      .toBe('Player Killer');
  });
  it('0 (Undef) → "Non-Player Killer"', () => {
    expect(playerKillerStatusLabel(0)).toBe('Non-Player Killer');
  });
});
