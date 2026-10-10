/**
 * VISUAL.preworld-double-spaces — the EoL string tables put two spaces after
 * a full stop; retail's UIElement_Text draws the run as one space (retail-ab
 * chargen-appearance: 7 px after "screen." vs a 6 px word gap; ours drew 12).
 * DAT-desc text collapses space runs; newlines survive.
 */
import { describe, it, expect } from 'vitest';
import { collapseDatSpaceRuns } from '../packages/renderer/src/ui/GameUI.js';

describe('collapseDatSpaceRuns', () => {
  it('a run of spaces becomes one; single spaces and newlines are kept', () => {
    expect(collapseDatSpaceRuns('on this screen.  Everything')).toBe('on this screen. Everything');
    expect(collapseDatSpaceRuns('a   b')).toBe('a b');
    expect(collapseDatSpaceRuns('here.\n\nTo choose')).toBe('here.\n\nTo choose');
    expect(collapseDatSpaceRuns('plain text')).toBe('plain text');
  });
});
