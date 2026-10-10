/**
 * FAITHFUL.598 — character-select surfaces deleteTime
 * (faithfulness sweep 2026-06-03 finding #11; parsed-unused shape).
 *
 * ACE GameMessageCharacterList.cs:28 writes a third per-character uint32:
 * `DeleteTime != 0 ? max(1, GetUnixTime() - DeleteTime) : 0` — non-zero
 * means the character is queued for deletion inside its restore window
 * (char_delete_time = 3600s; OfflinePlayer.cs:44 IsPendingDeletion).
 * parseCharacterList read it; the slot mapping dropped it, so a
 * pending-deletion character rendered identically to a normal one.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { CharacterSelectScreen, type CharacterSlot } from '../packages/renderer/src/ui/CharacterSelect.js';

const __dir = dirname(fileURLToPath(import.meta.url));
const RENDERER = join(__dir, '..', 'packages', 'renderer', 'src');
const mainSrc = readFileSync(join(RENDERER, 'main.ts'), 'utf8');

describe('FAITHFUL.598: deleteTime flows wire → slot → render', () => {
  it('CharacterSlot carries deleteTime and the screen preserves it', () => {
    const screen = new CharacterSelectScreen();
    const slot: CharacterSlot = {
      id: '1', name: 'Doomed', level: 1, heritage: 1, gender: 1,
      location: '', lastPlayed: 0, deleteTime: 42,
    };
    screen.addCharacter(slot);
    expect(screen.slots[0].deleteTime).toBe(42);
  });

  it('main.ts slot mapping passes c.deleteTime (was {id, name} only)', () => {
    expect(mainSrc).toMatch(/id: c\.id\.toString\(\),\s*\n\s*name: c\.name,\s*\n\s*deleteTime: c\.deleteTime,/);
  });
  // The render side (red name, no suffix — retail RebuildCharacterList @
  // 004ec3a0) is driven behaviourally in verify-charsel-pending-delete-row-red.ts;
  // the former source-text pin here asserted the invented dim + suffix.
});
