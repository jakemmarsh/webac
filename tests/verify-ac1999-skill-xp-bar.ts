/**
 * BUG.ac1999-skill-xp-bar (webac#32) — in a 1999 world the Skills tab's info box
 * row "XP cost to raise skill: N" is a meter: the real 1999 client fills it from
 * the left with the share of the next rank the skill already banked from use.
 * Ours drew no fill, so a cheap raise (banked usage XP) read as a pricing bug
 * (webac#31).
 *
 * 1999 client.exe: SkillInfoBox ctor @ 0x00545250 builds the meter at (5, 0x13)
 * 0xe6 x 0xf over track image 0x060011a6 with fill 0x06000f8a (the header's
 * XP-for-next-level meter in StatRegion is the same widget with fill 0x060011a5);
 * SetProficiencyPoints @ 0x00545ed0 sets it to (pp − XpTable[rank]) /
 * (XpTable[rank + 1] − XpTable[rank]) when pp > XpTable[rank], else 0. The
 * attribute / vital box (AttribInfoBox::Display @ 0x00544e10) has no meter.
 *
 * The local DAT keeps that row: layout 0x21000045's meter footer 0x10000247
 * (page state 0x10000013) holds the meter 0x10000247 (track 0x060011a6, fill
 * child 0x2 = 0x06000f8a). End of retail never shows it:
 * gmSkillUI::DisplaySelectionFooter_Trained @ 0049b860 sets the same fraction
 * through GetFooterMeter @ 004f0260, but the client only ever sets page states
 * 0x10000011 / 0x10000012, and the button footer 0x10000241 has no meter child.
 * So end of retail and Dark Majesty keep the button footer, unchanged.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { eraClientRules } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile, EOR_ERA_ID } from '../packages/renderer/src/era/EraProfiles.js';
import { GameUI } from '../packages/renderer/src/ui/GameUI.js';
import {
  parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes, type ElementDesc,
} from '../packages/dat-parser/src/index.js';
import { DAT_PATHS, DAT_SETS_DIR, openDat } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const R1999 = eraClientRules(eraProfile('ac1999-retail'));
const EOR = eraClientRules(eraProfile(EOR_ERA_ID));
/** A trained-skill table: rank r costs table[r] cumulative XP. */
const T = [0, 100, 300, 600, 1000];

describe('skillPartFraction: SetProficiencyPoints @ 0x00545ed0', () => {
  it('fills the banked share of the next rank', () => {
    expect(GameUI.skillPartFraction(T, 1, 200)).toBeCloseTo(0.5); // (200 − 100) / (300 − 100)
    expect(GameUI.skillPartFraction(T, 2, 400)).toBeCloseTo(1 / 3);
    expect(GameUI.skillPartFraction(T, 0, 99)).toBeCloseTo(0.99);
  });

  it('is empty at a rank boundary, without a pp, without a table, at the last rank, and below the rank', () => {
    expect(GameUI.skillPartFraction(T, 1, 100)).toBe(0);
    expect(GameUI.skillPartFraction(T, 1, undefined)).toBe(0);
    expect(GameUI.skillPartFraction(undefined, 1, 200)).toBe(0);
    expect(GameUI.skillPartFraction(T, 4, 1500)).toBe(0);
    expect(GameUI.skillPartFraction(T, 2, 250)).toBe(0); // pp ≤ XpTable[rank]: the 1999 else-branch
  });

  it('never overflows: pp at or past the next rank reads full, not more', () => {
    expect(GameUI.skillPartFraction(T, 1, 300)).toBe(1);
    expect(GameUI.skillPartFraction(T, 1, 5000)).toBe(1);
  });

  it('the price and the fill agree: cost = step × (1 − fill)', () => {
    for (const [lvl, pp] of [[1, 150], [2, 450], [3, 999]] as const) {
      const step = T[lvl + 1] - T[lvl];
      expect(GameUI.skillRaiseCosts(T, lvl, pp).cost1).toBeCloseTo(step * (1 - GameUI.skillPartFraction(T, lvl, pp)));
    }
  });
});

describe('the era rule', () => {
  it('1999 draws the meter; end of retail and every classic era do not', () => {
    expect(R1999.skillFooterMeter).toBe(true);
    for (const id of [EOR_ERA_ID, 'classic-dereth', 'classicace-customdm', 'classicace-infiltration']) {
      expect(eraClientRules(eraProfile(id)).skillFooterMeter, id).toBe(false);
    }
    expect(eraClientRules(null).skillFooterMeter).toBe(false);
  });
});

/** The stat pane's footers as layout 0x21000045 lays them out (the children renderStatPaneFooter reads). */
function footerDom(doc: Document): HTMLElement {
  const el = (id: number, kids: HTMLElement[] = []): HTMLElement => {
    const d = doc.createElement('div');
    d.dataset.elementId = `0x${id.toString(16)}`;
    for (const k of kids) d.appendChild(k);
    return d;
  };
  const lines = (): HTMLElement[] => [0x1000024e, 0x10000242, 0x10000243, 0x10000244, 0x10000245, 0x10000246, 0x100005eb].map((id) => el(id));
  const body = doc.createElement('div');
  body.appendChild(el(0x10000247, [el(0x10000247, [el(0x2)]), ...lines()]));
  body.appendChild(el(0x10000240, lines()));
  body.appendChild(el(0x10000241, lines()));
  doc.body.appendChild(body);
  return body;
}

for (const [era, rules] of [['ac1999-retail', R1999], ['eor', EOR]] as const) {
  const is1999 = era === 'ac1999-retail';
  describe(`GameUI ${era}: the skill footer`, () => {
    let H: GameUIFixture;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ui: any;
    let body: HTMLElement;
    const q = (sel: string): HTMLElement => body.querySelector(sel) as HTMLElement;
    const meterFooter = (): HTMLElement => q(':scope > [data-element-id="0x10000247"]');
    const buttonFooter = (): HTMLElement => q(':scope > [data-element-id="0x10000241"]');
    const fill = (): HTMLElement => q('[data-element-id="0x10000247"] [data-element-id="0x10000247"] [data-element-id="0x2"]');
    const render = (): void => ui.renderStatPaneFooter(body, 'skills');

    beforeAll(async () => {
      H = await mountGameUI();
      ui = H.ui;
      ui.setClientRules(rules);
      ui.setRaiseCallbacks({}, { attribute: T, vital: T, trainedSkill: T, specializedSkill: T });
      ui.skillTable = { skills: new Map([[6, { trainedCost: 4 }], [15, { trainedCost: 6 }]]) };
      ui.charInfo.unassignedXp = 10_000;
      ui.charInfo.skills = [
        // Assess Person-style: rank 1, 100 of the 200-XP step banked from use.
        { id: 6, name: 'Melee Defense', status: 'Trained', base: 20, effective: 20, raises: 1, pp: 200 },
        { id: 15, name: 'Magic Defense', status: 'Untrained', base: 0, effective: 0, raises: 0 },
        { id: 16, name: 'Mana Conversion', status: 'Trained', base: 30, effective: 30, raises: 4, pp: 1000 },
      ];
      body = footerDom(H.win.document);
    }, 60_000);
    afterAll(() => H?.teardown());

    it(is1999 ? 'a trained skill shows the meter footer, half filled, with the row text and the Raise button' : 'a trained skill keeps the button footer; the meter footer stays hidden', () => {
      ui.selectedSkillId = 6;
      const m = ui.statFooterModel('skills');
      expect(m.meterFraction).toBe(is1999 ? 0.5 : undefined);
      render();
      expect(meterFooter().style.display).toBe(is1999 ? 'block' : 'none');
      expect(buttonFooter().style.display).toBe(is1999 ? 'none' : 'block');
      const shown = is1999 ? meterFooter() : buttonFooter();
      expect(shown.querySelector('[data-element-id="0x10000243"]')!.textContent).toContain('100');
      expect(shown.querySelector('[data-element-id="0x10000246"]')!.getAttribute('data-raise-button')).toBe('0x10000246');
      if (is1999) expect(fill().style.width).toBe('50.00%');
    });

    it('switching selection updates the fill; a boundary rank reads empty; after a raise it follows the new pp', () => {
      ui.selectedSkillId = 6;
      ui.charInfo.skills[0] = { ...ui.charInfo.skills[0], raises: 2, pp: 300 }; // the raise landed: a rank boundary
      render();
      if (is1999) expect(fill().style.width).toBe('0.00%');
      else expect(meterFooter().style.display).toBe('none');
      ui.charInfo.skills[0] = { ...ui.charInfo.skills[0], raises: 2, pp: 450 };
      render();
      if (is1999) expect(fill().style.width).toBe('50.00%');
    });

    it('a skill at its last rank shows an empty bar (1999) and INFINITY', () => {
      ui.selectedSkillId = 16;
      const m = ui.statFooterModel('skills');
      expect(m.meterFraction).toBe(is1999 ? 0 : undefined);
      render();
      if (is1999) {
        expect(meterFooter().style.display).toBe('block');
        expect(fill().style.width).toBe('0.00%');
        expect(m.line1Value).toBe('INFINITY');
      }
    });

    it('an untrained skill has no meter: the button footer with the train line', () => {
      ui.selectedSkillId = 15;
      expect(ui.statFooterModel('skills').meterFraction).toBeUndefined();
      render();
      expect(meterFooter().style.display).toBe('none');
      expect(buttonFooter().style.display).toBe('block');
    });

    it('attributes and vitals have no meter (AttribInfoBox::Display @ 0x00544e10 draws none)', () => {
      ui.charInfo.vitals.health = { current: 10, max: 10, base: 10, baseMax: 10, raises: 0, xp: 50 };
      ui.selectedStatRow = { kind: 'vital', id: 1 };
      expect(ui.statFooterModel('attributes').meterFraction).toBeUndefined();
      ui.renderStatPaneFooter(body, 'attributes');
      expect(meterFooter().style.display).toBe('none');
    });

    it('no selection: the prompt footer, both others hidden', () => {
      ui.selectedSkillId = null;
      render();
      expect(meterFooter().style.display).toBe('none');
      expect(buttonFooter().style.display).toBe('none');
      expect(q(':scope > [data-element-id="0x10000240"]').style.display).toBe('block');
    });
  });
}

const hasEolDats = existsSync(DAT_PATHS.local) && existsSync(DAT_PATHS.portal);
describe.skipIf(!hasEolDats)('DAT ground truth: layout 0x21000045 keeps the 1999 meter row', () => {
  let find: (id: number, scope?: Map<number, ElementDesc>) => ElementDesc | undefined;
  let root: Map<number, ElementDesc>;
  beforeAll(() => {
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    setMasterPropertyTypes(parseMasterProperty(portal.getReader(0x39000001)));
    root = parseLayoutDesc(local.getReader(0x21000045)).elements;
    find = (id, scope = root) => {
      for (const e of scope.values()) {
        if (e.elementId === id) return e;
        const hit = find(id, e.children);
        if (hit) return hit;
      }
      return undefined;
    };
  });

  it('meter footer 0x10000247 holds meter 0x10000247 (track 0x060011a6, fill child 0x2 = 0x06000f8a) under line one', () => {
    const footer = find(0x10000247)!;
    expect([footer.x, footer.y, footer.width, footer.height]).toEqual([0, 282, 300, 55]);
    const meter = [...footer.children.values()].find((c) => c.elementId === 0x10000247)!;
    expect([meter.x, meter.y, meter.width, meter.height]).toEqual([5, 20, 240, 17]);
    expect(meter.media.map((m) => m.file)).toContain(0x060011a6);
    const fillDesc = [...meter.children.values()].find((c) => c.elementId === 0x2)!;
    expect(fillDesc.media.map((m) => m.file)).toContain(0x06000f8a);
  });

  it('the button footer 0x10000241 has no meter child (why end of retail draws none)', () => {
    const button = find(0x10000241)!;
    expect(find(0x10000247, button.children)).toBeUndefined();
  });
});

const PORTAL_1999 = resolve(DAT_SETS_DIR, 'ac1999-retail', 'portal.dat');
describe.skipIf(!existsSync(PORTAL_1999))('the 1999 portal.dat carries the meter art', () => {
  it('0x060011a6 (track) and 0x06000f8a (fill) are in it', () => {
    const portal = openDat(PORTAL_1999);
    expect(portal.getFileData(0x060011a6)).toBeTruthy();
    expect(portal.getFileData(0x06000f8a)).toBeTruthy();
  });
});
