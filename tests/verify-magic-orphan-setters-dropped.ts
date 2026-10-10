/**
 * FAITHFUL.472 — drop setSpellComponents + setEquippedFoci orphan
 *  setters.
 *
 *  Both were defined but never called from main.ts. The Components
 *  tab already derives components from `playerState.inventory.getAll()`
 *  (renderSpellsTab + renderComponentsTab iterate inventory items
 *  with ItemType.SpellComponent). The Foci tab renders all 5 magic
 *  schools as "not equipped" with an empty equippedFoci array,
 *  which is the same visible state as now since no caller was
 *  populating it. Removed per FAITHFUL.437 drop-dead-code principle.
 *
 *  The `spellComponents` + `equippedFoci` private fields remain (as
 *  empty defaults) because renderSpellsTab + renderFociTab still
 *  read them — we just removed the setters.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('FAITHFUL.472 — orphan magic setters removed (behavioural, real GameUI)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H.teardown());

  it('setSpellComponents method is gone', () => {
    expect((H.mod.GameUI.prototype as any).setSpellComponents).toBeUndefined();
    expect(H.ui.setSpellComponents).toBeUndefined();
  });

  it('setEquippedFoci method is gone', () => {
    expect((H.mod.GameUI.prototype as any).setEquippedFoci).toBeUndefined();
    expect(H.ui.setEquippedFoci).toBeUndefined();
  });

  it('private spellComponents field still exists (empty array default)', () => {
    expect(H.ui.spellComponents).toEqual([]);
  });

  it('equippedFoci field + Foci page fully deleted (VISUAL.139)', () => {
    // Foci were retired from AC in 2010 — the EoL magic panel has only the
    // Spellbook/Components DAT tab pair, so the field lost its last reader.
    expect('equippedFoci' in H.ui).toBe(false);
    expect((H.mod.GameUI.prototype as any).renderFociTab).toBeUndefined();
  });
});
