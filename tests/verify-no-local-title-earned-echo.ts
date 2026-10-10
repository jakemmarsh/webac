/**
 * FAITHFUL.520 — Drop local "Title earned: X" echo on UpdateTitle.
 *
 *  ACE `Player_Character.cs:355-358` sends BOTH:
 *    1. GameEventUpdateTitle — data-only event (titleId + setAsDisplay)
 *       used by the client to update the character panel.
 *    2. GameEventCommunicationTransientString("You have been granted a
 *       new title.") — the canonical retail chat line.
 *
 *  Pre-fix `onUpdateTitle` emitted a local
 *  `addSystemMessage("Title earned: ${name}")` IN ADDITION to the
 *  TransientString → addSystemMessage path at line 5407. So players
 *  earning a new title saw two lines:
 *    - "You have been granted a new title." (server, generic)
 *    - "Title earned: Cosmic Conscious" (local, named)
 *
 *  Retail showed only the server line; the title name appeared in the
 *  character panel. Drop the local echo for faithfulness — same
 *  anti-pattern as FAITHFUL.500-507.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');

describe('FAITHFUL.520 — onUpdateTitle drops local "Title earned" echo', () => {
  it('no addSystemMessage("Title earned: ...") in onUpdateTitle', () => {
    const block = MAIN.match(/onUpdateTitle:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).not.toMatch(/addSystemMessage\(`Title earned:/);
  });

  it('character-panel data update still happens (titles list + active title)', () => {
    const block = MAIN.match(/onUpdateTitle:[\s\S]+?^      \},/m)?.[0] ?? '';
    expect(block).toMatch(/setTitlesData\(existing/);
  });

  it('cites FAITHFUL.520 + ACE Player_Character.cs', () => {
    expect(MAIN).toMatch(/FAITHFUL\.520[\s\S]+?Player_Character\.cs/);
  });
});
