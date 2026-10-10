/**
 * GAP.81 — character-creation Skills-step row status coloring must be DAT/
 * decompiled-client-derived, not a hand-picked per-status hue.
 *
 * Prior state: renderChargenSkillRow colored the row marker/border with
 * AC_COLORS.skillSpecialized (invented brown) / skillTrained (green) /
 * skillUntrained (invented grey), tinted the row background green for any
 * trained-or-better skill, and gold-highlighted the name text — none of it
 * cited.
 *
 * This cycle found two independent sources showing retail conveys skill
 * status in this exact screen WITHOUT any per-row color at all:
 *
 * 1. Decompiled client: gmCGSkillsPage::SetSkillText (acclient-decompiled.c
 *    ~130502) and ::UpdateSkillEntry (~130854) never call
 *    UIElement_Text::SetFontColorHelper/SetFontColorNum for any
 *    SKILL_ADVANCEMENT_CLASS branch. Instead ::UpdateSkillEntry sorts each
 *    skill into one of 4 separate listbox sections via ::InsertEntrySorted
 *    anchored on m_pSpecEntry/m_pTrainedEntry/m_pUseableUntrainedEntry/
 *    m_pUnuseableUntrainedEntry (ID_CharGen_Specialized/_Trained/
 *    _UseableUntrained/_UnuseableUntrained header strings) — status is
 *    conveyed by which section a skill sorts into, not by row hue.
 * 2. DAT ground truth: LayoutDesc 0x21000048 (client_local_English.dat, the
 *    chargen Skills-step layout) carries zero BasePropertyType.Color
 *    properties on any element (default or named state).
 *
 * Fix reuses the app's own existing convention instead of inventing a new
 * value: the character-summary sidebar (GameUI.ts ~3940) already renders
 * every Trained-or-Specialized skill name in one uniform AC_COLORS.skillTrained
 * green with no further distinction — resolveChargenSkillRowStyle applies the
 * same rule to the Skills-step row itself. Retail's actual 4-section grouping
 * is a bigger structural change than a color fix and is left for a future
 * cycle (see GameUI.ts comment above resolveChargenSkillRowStyle).
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GameUI, AC_COLORS } from '../packages/renderer/src/ui/GameUI';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import {
  parseLayoutDesc,
  parseMasterProperty,
  setMasterPropertyTypes,
  BasePropertyType,
  type ElementDesc,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { openDat } from './_harness/dat.js';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

// VISUAL.chargen-skills-list-rows superseded the interim uniform-green rule
// (resolveChargenSkillRowStyle): every row's texts now draw as the DAT row
// template's own text elements, which inherit 0x2100004c:0x100002fe and
// take its state-1 grey — the state DoSkillRecords puts each row in. The
// DAT side is asserted in tests/verify-chargen-skills-list-rows.ts.
describe('GAP.81 — chargen Skills-step row status color is uniform, not per-status', () => {
  it('rows draw in the one DAT state DoSkillRecords sets (SetState(1)), whatever their class', () => {
    expect(GameUI.CHARGEN_SKILL_ROW_STATE).toBe(1);
    expect((GameUI as unknown as Record<string, unknown>).resolveChargenSkillRowStyle).toBeUndefined();
  });

  it('the discredited invented AC_COLORS entries no longer exist', () => {
    expect((AC_COLORS as Record<string, unknown>).skillSpecialized).toBeUndefined();
    expect((AC_COLORS as Record<string, unknown>).skillUntrained).toBeUndefined();
  });
});

describe.skipIf(!hasDats)('GAP.81: LayoutDesc 0x21000048 (chargen Skills step) carries no Color property', () => {
  let elements: Map<number, ElementDesc>;

  beforeAll(() => {
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);

    const masterTypes = parseMasterProperty(portalDb.getReader(0x39000001));
    setMasterPropertyTypes(masterTypes);

    const layout = parseLayoutDesc(langDb.getReader(0x21000048));
    elements = layout.elements;
  });

  function hasAnyColorProperty(el: ElementDesc): boolean {
    for (const p of el.properties.values()) {
      if (p.propertyType === BasePropertyType.Color) return true;
    }
    for (const state of el.states.values()) {
      for (const p of state.properties.values()) {
        if (p.propertyType === BasePropertyType.Color) return true;
      }
    }
    return false;
  }

  it('no top-level element of the Skills-step layout defines a Color property', () => {
    expect(elements.size).toBeGreaterThan(0);
    for (const el of elements.values()) {
      expect(hasAnyColorProperty(el)).toBe(false);
    }
  });
});
