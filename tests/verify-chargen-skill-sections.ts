/**
 * GAP.81 (cycle 2026-07-20f) — chargen Skills-step list now groups by
 * retail's real 4-section status split instead of SkillCategory (Combat/
 * Other/Magic), which had no decompiled/DAT citation.
 *
 * Ground truth: gmCGSkillsPage::UpdateSkillEntry (decompiled client,
 * acclient-decompiled.c ~130854) sorts each skill into one of 4 listbox
 * sections by SKILL_ADVANCEMENT_CLASS:
 *   - SPECIALIZED_SKILL_ADVANCEMENT_CLASS -> m_pSpecEntry section
 *   - TRAINED_SKILL_ADVANCEMENT_CLASS     -> m_pTrainedEntry section
 *   - UNTRAINED_SKILL_ADVANCEMENT_CLASS, split on `iMinlevel`:
 *       iMinlevel < 2 -> m_pUseableUntrainedEntry ("Useable Untrained")
 *       iMinlevel >= 2 -> m_pUnuseableUntrainedEntry ("Unuseable Untrained")
 * `iMinlevel` is SkillBase.MinLevel (ACE.DatLoader/Entity/SkillBase.cs:
 * "1 = usable when untrained, 2 = trained-or-greater required for
 * usability"). ::InsertEntrySorted (~130726) sorts each section
 * alphabetically by name (wcscmp on strName).
 *
 * Section header/tooltip strings are the real DAT StringTable 0x23000002
 * entries, resolved at runtime via acStringHash("ID_CharGen_...") — the
 * same hash mechanism gmCGSkillsPage itself uses
 * (StringInfo::SetStringIDandTableEnum, ~131680-131709). Verified against
 * the shipped DAT:
 *   82177204  "Specialized Skills"
 *   120618772 "Trained Skills"
 *   97480228  "Useable Untrained Skills"
 *   110885092 "Unuseable Untrained Skills"
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { GameUI } from '../packages/renderer/src/ui/GameUI';
import { SkillAdvancementClass } from '../packages/shared/src/character/Heritage.js';
import {
  acStringHash, getString, registerStringTable,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import type { StringTableData } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { SkillTable } from '../packages/dat-parser/src/file-types/SkillTable.js';
import { parseStringTable } from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { openDat } from './_harness/dat.js';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

describe('acStringHash("ID_CharGen_...") matches the real DAT entry ids', () => {
  it('resolves the 4 section-header tokens to the decoded StringTable ids', () => {
    expect(acStringHash('ID_CharGen_Specialized')).toBe(82177204);
    expect(acStringHash('ID_CharGen_Trained')).toBe(120618772);
    expect(acStringHash('ID_CharGen_UseableUntrained')).toBe(97480228);
    expect(acStringHash('ID_CharGen_UnuseableUntrained')).toBe(110885092);
  });
});

describe('GameUI.chargenSkillSectionKey — SKILL_ADVANCEMENT_CLASS + MinLevel routing', () => {
  it('Specialized always sorts to the specialized section, regardless of minLevel', () => {
    expect(GameUI.chargenSkillSectionKey(SkillAdvancementClass.Specialized, 1)).toBe('specialized');
    expect(GameUI.chargenSkillSectionKey(SkillAdvancementClass.Specialized, 2)).toBe('specialized');
  });

  it('Trained always sorts to the trained section, regardless of minLevel', () => {
    expect(GameUI.chargenSkillSectionKey(SkillAdvancementClass.Trained, 1)).toBe('trained');
    expect(GameUI.chargenSkillSectionKey(SkillAdvancementClass.Trained, 2)).toBe('trained');
  });

  it('Untrained with minLevel 1 (usable when untrained) sorts to useableUntrained', () => {
    expect(GameUI.chargenSkillSectionKey(SkillAdvancementClass.Untrained, 1)).toBe('useableUntrained');
  });

  it('Untrained with minLevel 2 (trained-or-greater required) sorts to unuseableUntrained', () => {
    expect(GameUI.chargenSkillSectionKey(SkillAdvancementClass.Untrained, 2)).toBe('unuseableUntrained');
  });

  it('an absent status (no wizard.skills entry yet) defaults like Untrained', () => {
    expect(GameUI.chargenSkillSectionKey(undefined, 1)).toBe('useableUntrained');
    expect(GameUI.chargenSkillSectionKey(undefined, 2)).toBe('unuseableUntrained');
  });
});

describe('GameUI.chargenSkillSectionLabel — falls back to the real DAT wording when no StringTable is loaded', () => {
  it('returns the exact retail section strings as hardcoded fallbacks', () => {
    expect(GameUI.chargenSkillSectionLabel('specialized')).toBe('Specialized Skills');
    expect(GameUI.chargenSkillSectionLabel('trained')).toBe('Trained Skills');
    expect(GameUI.chargenSkillSectionLabel('useableUntrained')).toBe('Useable Untrained Skills');
    expect(GameUI.chargenSkillSectionLabel('unuseableUntrained')).toBe('Unuseable Untrained Skills');
  });
});

describe('GameUI.chargenSkillSectionLabel — resolves through the real hash→StringTable pipeline', () => {
  function tok(name: string, strings: string[]) {
    return { id: acStringHash(name), varNames: [], vars: [], strings, comments: [], unknown: 0 };
  }
  // Registered inside beforeAll (not at module scope) so it takes effect
  // only once this describe's own tests run — module-scope registration
  // would apply during collection, before the "falls back" describe above
  // gets to observe the unregistered state.
  beforeAll(() => {
    const TABLE: StringTableData = {
      id: 0x23000002, language: 1, unknown: 0,
      entries: [
        tok('ID_CharGen_Specialized', ['Specialized Skills (from DAT)']),
        tok('ID_CharGen_Trained', ['Trained Skills (from DAT)']),
        tok('ID_CharGen_UseableUntrained', ['Useable Untrained Skills (from DAT)']),
        tok('ID_CharGen_UnuseableUntrained', ['Unuseable Untrained Skills (from DAT)']),
      ],
    };
    registerStringTable(TABLE);
  });

  it('prefers the registered StringTable text over the hardcoded fallback', () => {
    expect(GameUI.chargenSkillSectionLabel('specialized')).toBe('Specialized Skills (from DAT)');
    expect(GameUI.chargenSkillSectionLabel('trained')).toBe('Trained Skills (from DAT)');
    expect(GameUI.chargenSkillSectionLabel('useableUntrained')).toBe('Useable Untrained Skills (from DAT)');
    expect(GameUI.chargenSkillSectionLabel('unuseableUntrained')).toBe('Unuseable Untrained Skills (from DAT)');
  });

  it('sanity: getString resolves the same hash the label helper uses internally', () => {
    expect(getString(acStringHash('ID_CharGen_Trained'))).toBe('Trained Skills (from DAT)');
  });
});

describe.skipIf(!hasDats)('GAP.81: real DAT ground truth for the 4-section split', () => {
  let skillTable: SkillTable;

  beforeAll(() => {
    const portalDb = openDat(PORTAL_DAT);
    skillTable = new SkillTable(portalDb.getReader(0x0e000004));

    const langDb = openDat(LANG_DAT);
    const tableIds = langDb.listFileIds(0x23);
    const targets = new Set([
      acStringHash('ID_CharGen_Specialized'),
      acStringHash('ID_CharGen_Trained'),
      acStringHash('ID_CharGen_UseableUntrained'),
      acStringHash('ID_CharGen_UnuseableUntrained'),
    ]);
    const found: StringTableData[] = [];
    for (const tid of tableIds) {
      const data = langDb.getFileData(tid);
      if (!data) continue;
      try {
        const table = parseStringTable(langDb.getReader(tid));
        if (table.entries.some(e => targets.has(e.id))) found.push(table);
      } catch {
        // not every 0x23 file parses as a StringTable we care about; skip
      }
    }
    for (const table of found) registerStringTable(table);
  });

  it('SkillTable.minLevel only ever takes the 2 documented values (1 or 2)', () => {
    const levels = new Set([...skillTable.skills.values()].map(s => s.minLevel));
    for (const lvl of levels) {
      expect(lvl === 1 || lvl === 2).toBe(true);
    }
    // both branches must be reachable, or the useable/unuseable split is dead code
    expect(levels.has(1)).toBe(true);
    expect(levels.has(2)).toBe(true);
  });

  it('chargenSkillSectionLabel resolves to the exact retail strings from the shipped DAT', () => {
    expect(GameUI.chargenSkillSectionLabel('specialized')).toBe('Specialized Skills');
    expect(GameUI.chargenSkillSectionLabel('trained')).toBe('Trained Skills');
    expect(GameUI.chargenSkillSectionLabel('useableUntrained')).toBe('Useable Untrained Skills');
    expect(GameUI.chargenSkillSectionLabel('unuseableUntrained')).toBe('Unuseable Untrained Skills');
  });
});
