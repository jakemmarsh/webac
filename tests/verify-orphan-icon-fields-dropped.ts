/**
 * FAITHFUL.475 — drop 2 orphan private icon-cache fields.
 *
 *  Continuing the FAITHFUL.468-474 orphan cleanup. `templateIcons`
 *  + `hairStyleIcons` were declared as private `Map<number, string>`
 *  fields but never written to OR read from. Pure dead state. Kept
 *  `heritageIcons` which IS wired (set in loadDATAssets, read in
 *  getHeritageIcon).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

// DEBT.test-harness-hygiene: behavioural — inspects a real GameUI instance
// (class fields are own properties after construction) instead of GameUI.ts text.
describe('FAITHFUL.475 — orphan icon-cache fields removed', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); }, 60_000);
  afterAll(() => H?.teardown());

  it('templateIcons field is gone', () => {
    expect('templateIcons' in H.ui).toBe(false);
  });

  it('hairStyleIcons field is gone', () => {
    expect('hairStyleIcons' in H.ui).toBe(false);
  });

  it('heritageIcons is retained and wired (getHeritageIcon reads it)', () => {
    expect(H.ui.heritageIcons).toBeInstanceOf(Map);
    expect(H.ui.getHeritageIcon(1)).toBeNull();
    H.ui.heritageIcons.set(1, 'data:image/png;base64,AA==');
    expect(H.ui.getHeritageIcon(1)).toBe('data:image/png;base64,AA==');
  });
});
