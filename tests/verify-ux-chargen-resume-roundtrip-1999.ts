/**
 * UX.chargen-resume (AC1999 live check, 2026-10-29): 1 of 3 AC1999 resumes
 * refused a draft the same page had just captured. The property sweep of
 * verify-ux-chargen-resume-roundtrip.ts (seeded RandomizeCharacter rolls plus
 * a player's edits, captured and restored, tests/_harness/chargenRoundtrip.ts)
 * on the 1999 portal through its overlay, in its own file: each era's DATs and
 * GameUI cost a worker's heap.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import { FileDatBytes } from '../packages/dat-parser/src/node/FileDatBytes.js';
import { ac1999PortalOverlay } from '../packages/dat-parser/src/era1999/Ac1999Overlay.js';
import { ROLLS, stub, sweep } from './_harness/chargenRoundtrip.js';
import { seededRandomSource } from '../packages/renderer/src/ui/ChargenRandomize.js';
import { CreateStep } from '../packages/renderer/src/ui/CharacterCreate.js';
import { restoreWizardVerdict, snapshotWizard } from '../packages/renderer/src/ui/ChargenDraft.js';
import { CharacterCreateWizard } from '../packages/renderer/src/ui/CharacterCreate.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PORTAL_1999 = resolve(__dirname, '..', 'dat-sets', 'ac1999-retail', 'portal.dat');

describe.skipIf(!existsSync(PORTAL_1999))('every state the client reaches restores exactly (AC1999)', () => {
  let H: GameUIFixture;
  beforeAll(async () => { H = await mountGameUI(); });
  afterAll(() => H?.teardown());

  it(`the 1999 portal through its overlay: ${ROLLS} rolls + edits`, () => {
    // Its own instance: the overlay would change what other files read from openDat's shared one.
    const world = new DatDatabase(new FileDatBytes(PORTAL_1999));
    world.setOverlay(ac1999PortalOverlay());
    const ui = new H.mod.GameUI(H.container, {}, world) as any;
    stub(ui);
    ui.accountHasThroneOfDestiny = false;
    expect(sweep(ui)).toEqual([]);
  });

  /**
   * The live AC1999 mismatch (2026-10-29, 1 run in 10): the roll drew a clothing colour from the
   * page's whole clothingColorsList while the chosen items' ClothingTables were still streaming, so
   * the wizard held a colour past the item's own count; the restore clamped it and the resumed
   * choices differed. A stand-in model builder plays the streaming: counts unknown (null) until the
   * tables "land", then each item has ITEM_COLORS colours.
   */
  const ITEM_COLORS = 2;
  function streamingBuilder() {
    const state = { resident: false };
    const count = (_sex: unknown, list: readonly unknown[] | undefined, style: number): number | null => {
      if (style < 0 || !list?.[style]) return 0;
      return state.resident ? ITEM_COLORS : null;
    };
    const choices = (n: number | null) => ({ templateIds: Array.from({ length: n ?? 0 }, (_, i) => 0x1000 + i), palSetIds: Array.from({ length: n ?? 0 }, () => 0) });
    const builder = {
      clothingColorCount: count,
      getChargenClothingColors: () => ({ headgear: choices(state.resident ? ITEM_COLORS : 0), shirt: choices(state.resident ? ITEM_COLORS : 0), pants: choices(state.resident ? ITEM_COLORS : 0), footwear: choices(state.resident ? ITEM_COLORS : 0) }),
    };
    return { state, builder };
  }
  const colours = (w: any) => [w.appearance.headgearColor, w.appearance.shirtColor, w.appearance.pantsColor, w.appearance.footwearColor];
  const styles = (w: any) => [w.appearance.headgearStyle, w.appearance.shirtStyle, w.appearance.pantsStyle, w.appearance.footwearStyle];
  const held = (w: any) => colours(w).every((c: number, i: number) => styles(w)[i] === -1 || (c >= 0 && c < ITEM_COLORS));

  it('counts arriving after the roll: the page holds the colours when the tables land; capture and restore then agree', () => {
    const world = new DatDatabase(new FileDatBytes(PORTAL_1999));
    world.setOverlay(ac1999PortalOverlay());
    const ui = new H.mod.GameUI(H.container, {}, world) as any;
    stub(ui);
    ui.accountHasThroneOfDestiny = false;
    const { state, builder } = streamingBuilder();
    ui.uiHost = { characterModelBuilder: builder };
    let pastBefore = 0;
    for (let seed = 1; seed <= 40; seed++) {
      state.resident = false;
      ui.chargenRandomSource = seededRandomSource(seed);
      ui.showCharacterCreate(); // the roll, tables not resident
      if (!held(ui.wizard)) pastBefore++;
      // The tables land: the page repaints (the streamed-arrival repaint), and Set<Slot>Style's hold applies.
      state.resident = true;
      ui.wizard.setProgressState(CreateStep.Town);
      ui.renderCharacterCreate();
      expect(held(ui.wizard), `seed ${seed}: ${colours(ui.wizard)}`).toBe(true);
      // A drop now: what is kept is what restores, exactly.
      const cap = ui.captureChargenDraft().wizard;
      expect(restoreWizardVerdict(new CharacterCreateWizard(), cap, ui.chargenRollDeps())).toBeNull();
      ui.showCharacterSelect([], 5);
      ui.showCharacterCreate(cap);
      expect(ui.lastChargenRestore).toBe('restored');
      expect(ui.captureChargenDraft().wizard).toEqual(cap);
    }
    // The 1999 list offers more colours than an item has: rolls past it did happen before the tables.
    expect(pastBefore).toBeGreaterThan(0);
  });

  it('counts known when the roll is made: it draws within the item\'s own colours (StoreColorInformation)', () => {
    const world = new DatDatabase(new FileDatBytes(PORTAL_1999));
    world.setOverlay(ac1999PortalOverlay());
    const ui = new H.mod.GameUI(H.container, {}, world) as any;
    stub(ui);
    ui.accountHasThroneOfDestiny = false;
    const { state, builder } = streamingBuilder();
    ui.uiHost = { characterModelBuilder: builder };
    state.resident = true;
    for (let seed = 1; seed <= 40; seed++) {
      ui.chargenRandomSource = seededRandomSource(seed);
      // The roll itself, before any render could hold anything.
      ui.wizard = new CharacterCreateWizard();
      ui.wizard.randomizeCharacter(ui.chargenRollDeps(), ui.chargenRandomSource);
      expect(held(ui.wizard), `seed ${seed}: ${colours(ui.wizard)}`).toBe(true);
    }
  });

  it('safety net: a draft kept before the tables landed restores with the colours held (and says nothing else changed)', () => {
    const world = new DatDatabase(new FileDatBytes(PORTAL_1999));
    world.setOverlay(ac1999PortalOverlay());
    const ui = new H.mod.GameUI(H.container, {}, world) as any;
    stub(ui);
    ui.accountHasThroneOfDestiny = false;
    const { state, builder } = streamingBuilder();
    ui.uiHost = { characterModelBuilder: builder };
    let seed = 0; let cap: any = null;
    do {
      seed++;
      state.resident = false;
      ui.chargenRandomSource = seededRandomSource(seed);
      ui.showCharacterCreate();
      cap = ui.captureChargenDraft().wizard;
    } while (held({ appearance: cap.appearance }) && seed < 200);
    expect(held({ appearance: cap.appearance })).toBe(false);
    state.resident = true;
    const w = new CharacterCreateWizard();
    expect(restoreWizardVerdict(w, cap, ui.chargenRollDeps())).toBeNull();
    expect(held(w)).toBe(true);
    const { appearance: a1, ...rest1 } = snapshotWizard(w, cap.nameEntered);
    const { appearance: a0, appearanceLastHeritage: _l, ...rest0 } = cap;
    expect(rest1).toEqual(rest0);
    expect({ ...a1, headgearColor: 0, shirtColor: 0, pantsColor: 0, footwearColor: 0 }).toEqual({ ...a0, headgearColor: 0, shirtColor: 0, pantsColor: 0, footwearColor: 0 });
  });
});
