/**
 * UX.chargen-resume (AC1999 live check, 2026-10-29): 1 of 3 resumes refused
 * a draft the same page had just captured ("the draft no longer fits this
 * world's chargen data"). A wizard state the client itself reaches must always
 * survive snapshotWizard → restoreWizard. This property test drives the real
 * GameUI chargen: many seeded RandomizeCharacter rolls (the ctor's), then a
 * player's edits through the wizard's own paths (heritage and gender switches,
 * the Random button per page, a town, a template, a name, every page), on each
 * era's real CharGen: end of retail and Dark Majesty (Classic Dereth) here, the
 * 1999 portal in verify-ux-chargen-resume-roundtrip-1999.ts, when the DATs are here. Every state must restore
 * exactly, and say why if not.
 */
import { existsSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { ROLLS, stub, sweep } from './_harness/chargenRoundtrip.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { DAT_PATHS, openDat } from './_harness/dat.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const DM_PORTAL = 'dat/sets/classic-dereth/client_portal.dat';
const hasEoL = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasEoL)('every state the client reaches restores exactly (real CharGens)', () => {
  let H: GameUIFixture;
  let dat: any;
  let CharacterGenerator: any;
  beforeAll(async () => {
    H = await mountGameUI();
    dat = await import('@ac/dat-parser');
    ({ CharacterGenerator } = await import('../packages/dat-parser/src/file-types/CharacterGenerator.js'));
    const local = openDat(DAT_PATHS.local);
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000002)));
  });
  afterAll(() => H?.teardown());

  const load = (portal: DatDatabase) => ({ charGen: new CharacterGenerator(portal.getReader(0x0e000002)), skills: new dat.SkillTable(portal.getReader(0x0e000004)) });

  it(`end of retail: ${ROLLS} rolls + edits`, () => {
    const ui = H.ui; stub(ui);
    const d = load(openDat(DAT_PATHS.portal));
    ui.charGen = d.charGen; ui.skillTable = d.skills; ui.eraHeritages = null; ui.accountHasThroneOfDestiny = true;
    expect(sweep(ui)).toEqual([]);
  });

  it.skipIf(!existsSync(DM_PORTAL))(`Dark Majesty: ${ROLLS} rolls + edits`, () => {
    const ui = H.ui; stub(ui);
    const d = load(openDat(DM_PORTAL));
    ui.charGen = d.charGen; ui.skillTable = d.skills; ui.eraHeritages = new Set([1, 2, 3]); ui.accountHasThroneOfDestiny = false;
    try { expect(sweep(ui)).toEqual([]); } finally { ui.eraHeritages = null; }
  });

});
