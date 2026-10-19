/**
 * BUG.chargen-finish-silent (Reddit + telemetry, 2026-10-16: "clicking on
 * 'Finish' does nothing"). FINISH must either send a CharacterCreate or show
 * a dialog, never neither, and what it sends must be a create ACE can build.
 *
 * Root cause: CharGenState::SetHeritageGroup / SetGender run
 * ConstrainAllByGender (@ 005c5b80), which pulls every appearance index back
 * inside the new heritage / gender's Sex_CG lists. Ours did not, so a face
 * or outfit from the opening Random roll (or the player's picks) went out
 * past the new lists (every Olthoi: two-entry lists). ACE's
 * PlayerFactory.Create indexed sex.HairStyleList / EyeColorList / … with
 * it, threw, its handler logged the exception and answered nothing, and the
 * client sat in CG_VERIFICATION_RESPONSE_PENDING: every later FINISH did
 * nothing at all.
 *
 * - the DAT sweep drives the real GameUI chargen (happy-dom, the real
 *   CharacterGenerator 0x0E000002): every heritage × gender, entered from
 *   every other heritage × gender's largest face / outfit, with each town,
 *   and checks the CharacterCreate against the index reads ACE's
 *   PlayerFactory.Create makes (PlayerFactory.cs:35-138, :358; SexCG.cs);
 * - the no-DAT cases pin each FINISH outcome: names (spaces, apostrophes,
 *   hyphens, banned), leftover credits, a request still pending, a host
 *   with nothing to send on, an exception building it, a server that never
 *   answers (CHARGEN_REPLY_TIMEOUT_MS), and a stale message dialog;
 * - the telemetry: chargen_sent / chargen_blocked / chargen_refused
 *   "timeout" through the real reporter and the bridge's allowlist.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { mountGameUI, openChargen, type GameUIFixture } from './_harness/gameui.js';
import { characterCreateAppearance, CreateStep, type AppearanceState } from '../packages/renderer/src/ui/CharacterCreate.js';
import { constrainAppearance, appearanceRollLists } from '../packages/renderer/src/ui/ChargenRandomize.js';
import { PreworldReporter, type PreworldEvent } from '../packages/renderer/src/telemetry/PreworldReporter.js';
import { sanitizeClientPreworld } from '../services/ws-tcp-bridge/src/clientPreworld.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

const APPEARANCE_FIELDS = ['eyesStrip', 'noseStyle', 'mouthStyle', 'hairStyle', 'eyeColor', 'hairColor', 'headgearStyle', 'shirtStyle', 'pantsStyle', 'footwearStyle'] as const;
const LIST_OF: Record<(typeof APPEARANCE_FIELDS)[number], string> = {
  eyesStrip: 'eyeStripList', noseStyle: 'noseStripList', mouthStyle: 'mouthStripList', hairStyle: 'hairStyleList',
  eyeColor: 'eyeColorList', hairColor: 'hairColorList', headgearStyle: 'headgearList', shirtStyle: 'shirtList',
  pantsStyle: 'pantsList', footwearStyle: 'footwearList',
};

/* eslint-disable @typescript-eslint/no-explicit-any */

/**
 * The index reads ACE's PlayerFactory.Create makes on a CharacterCreate
 * (each out of range throws, and CharacterHandler answers nothing):
 * HeritageGroups[h], Genders[g], HairStyleList[hair], EyeStripList[eyes]
 * (.ObjDesc / .ObjDescBald).TextureChanges[0], Nose / Mouth strips'
 * TextureChanges[0], HairColorList, EyeColorList; for a non-Olthoi the
 * clothing lists (not for Gear Knights; headgear only below uint.MaxValue)
 * and Templates[templateOption]; StarterAreas[startArea].Locations[0].
 */
function aceCreateFaults(cg: any, p: { heritage: number; gender: number; templateOption: number; startArea: number; appearance: ReturnType<typeof characterCreateAppearance> }): string[] {
  const faults: string[] = [];
  const at = (list: readonly unknown[] | undefined, i: number, what: string): any => {
    if (!list || !Number.isInteger(i) || i < 0 || i >= list.length) { faults.push(`${what}[${i}] of ${list?.length ?? 'none'}`); return undefined; }
    return list[i];
  };
  const hg = cg.heritageGroups.get(p.heritage);
  if (!hg) return [`HeritageGroups[${p.heritage}]`];
  const sex = hg.genders.get(p.gender);
  if (!sex) return [`Genders[${p.gender}]`];
  const a = p.appearance;
  const hair = at(sex.hairStyleList, a.hairStyle, 'HairStyleList');
  const eyes = at(sex.eyeStripList, a.eyes, 'EyeStripList');
  if (eyes && hair && (hair.bald ? eyes.objDescBald : eyes.objDesc).textureChanges.length === 0) faults.push('EyeStrip TextureChanges[0]');
  const nose = at(sex.noseStripList, a.nose, 'NoseStripList');
  if (nose && nose.objDesc.textureChanges.length === 0) faults.push('NoseStrip TextureChanges[0]');
  const mouth = at(sex.mouthStripList, a.mouth, 'MouthStripList');
  if (mouth && mouth.objDesc.textureChanges.length === 0) faults.push('MouthStrip TextureChanges[0]');
  at(sex.hairColorList, a.hairColor, 'HairColorList');
  at(sex.eyeColorList, a.eyeColor, 'EyeColorList');
  const olthoi = p.heritage === 12 || p.heritage === 13;
  if (!olthoi) {
    if (p.heritage !== 6) {
      if ((a.headgearStyle >>> 0) !== 0xffffffff) at(sex.headgearList, a.headgearStyle, 'HeadgearList');
      at(sex.shirtList, a.shirtStyle, 'ShirtList');
      at(sex.pantsList, a.pantsStyle, 'PantsList');
      at(sex.footwearList, a.footwearStyle, 'FootwearList');
    }
    at(hg.templates, p.templateOption, 'Templates');
  }
  const area = at(cg.starterAreas, p.startArea, 'StarterAreas');
  if (area && !(area.locations?.length > 0)) faults.push('StarterArea Locations[0]');
  return faults;
}

describe.skipIf(!hasDats)('FINISH across every heritage × gender (happy-dom + the EoL CharGen)', () => {
  let fx: GameUIFixture;
  let charGen: any; let skillTable: any;
  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000002)));
    skillTable = new dat.SkillTable(portal.getReader(0x0e000004));
    const { CharacterGenerator } = await import('../packages/dat-parser/src/file-types/CharacterGenerator.js');
    charGen = new CharacterGenerator(portal.getReader(0x0e000002));
  });
  afterAll(() => fx?.teardown());

  function open(sent: any[]): any {
    const { ui } = fx;
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.skillTable = skillTable;
    ui.charGen = charGen;
    ui.paintChargenShadeDisk = () => {};
    ui.renderChargenPreview = () => {};
    ui.renderChargenSummaryView = () => {};
    ui.hideMessageDialog();
    ui.hideConfirmationDialog();
    ui.callbacks.onCharacterCreated = (w: any) => {
      const info = w.getCharacterInfo();
      sent.push({ ...info, appearance: characterCreateAppearance(info.appearance) });
      return true;
    };
    openChargen(ui, { custom: false });
    return ui;
  }

  const sexes = (): Array<[number, number]> => {
    const out: Array<[number, number]> = [];
    for (const [h, hg] of charGen.heritageGroups as Map<number, any>) for (const g of hg.genders.keys()) out.push([h, g]);
    return out;
  };

  /** The source sex's last entry of every list: the largest face / outfit a player there can pick. */
  function maxAppearance(ui: any, h: number, g: number): void {
    const sex = charGen.heritageGroups.get(h).genders.get(g);
    for (const f of APPEARANCE_FIELDS) ui.wizard.appearance[f] = sex[LIST_OF[f]].length - 1;
  }

  const click = (el: Element | null): void => { el!.dispatchEvent(new fx.win.MouseEvent('click', { bubbles: true })); };

  /** Type the name, open the Summary page, press FINISH; what went out and which dialog shows. */
  function finish(ui: any, name: string): { dialog: boolean } {
    ui.wizard.currentStep = CreateStep.Summary;
    ui.renderCharacterCreate();
    const input = fx.container.querySelector('#char-name-input') as HTMLInputElement;
    input.value = name;
    input.dispatchEvent(new fx.win.Event('input', { bubbles: true }));
    click(fx.container.querySelector('#btn-confirm'));
    // Leftover attribute credits: the CreditWarning Yes / No; Yes (left) finishes.
    const yes = fx.win.document.querySelector('.ac-dialog-button');
    if (yes && ui.wizard.attributesRemaining > 0) click(yes);
    return { dialog: !!fx.win.document.getElementById('ac-message-dialog') };
  }

  it('the heritage and gender controls hold the face and outfit to the new lists (ConstrainAllByGender), so every create indexes inside ACE\'s lists', () => {
    const all = sexes();
    expect(all.length).toBeGreaterThanOrEqual(26);
    const ui = open([]);
    const deps = ui.chargenRollDeps();
    const failures: string[] = [];
    for (const [h0, g0] of all) {
      for (const [h, g] of all) {
        if (h0 === h && g0 === g) continue;
        ui.wizard.setHeritageGroup(h0, deps, ui.chargenRandomSource);
        ui.wizard.setGender(g0, deps);
        maxAppearance(ui, h0, g0);
        // The calls the heritage row / gender button handlers make.
        ui.wizard.setHeritageGroup(h, deps, ui.chargenRandomSource);
        ui.wizard.setGender(g, deps);
        ui.wizard.fitTemplateToCharacter(ui.chargenTemplates());
        const info = ui.wizard.getCharacterInfo();
        const faults = aceCreateFaults(charGen, {
          heritage: info.heritage, gender: info.gender, templateOption: info.templateIndex,
          startArea: info.startArea, appearance: characterCreateAppearance(info.appearance),
        });
        if (faults.length) failures.push(`${h0}/${g0} → ${h}/${g}: ${faults.join(', ')}`);
      }
    }
    expect(failures).toEqual([]);
  });

  it('the original repro: Random roll → Heritage page row "Olthoi" (12) → Summary → FINISH sends a create ACE can build', () => {
    const sent: any[] = [];
    const ui = open(sent);
    maxAppearance(ui, 1, 1); // an Aluvian male's face, as a Random roll can leave it
    ui.wizard.currentStep = CreateStep.Heritage;
    ui.renderCharacterCreate();
    click(fx.container.querySelector('.heritage-btn[data-heritage="12"]'));
    expect(ui.wizard.heritage).toBe(12);
    const r = finish(ui, 'Olthoi Probe');
    expect(r.dialog).toBe(false);
    expect(sent).toHaveLength(1);
    const p = sent[0];
    expect(aceCreateFaults(charGen, { heritage: p.heritage, gender: p.gender, templateOption: p.templateIndex, startArea: p.startArea, appearance: p.appearance })).toEqual([]);
    expect(charGen.starterAreas[p.startArea].name).toBe('OlthoiLair');
  });

  it('every heritage × gender, entered through the real heritage row and gender button from an Aluvian male\'s largest face, FINISHes with an ACE-valid create', () => {
    const failures: string[] = [];
    for (const [h, g] of sexes()) {
      const sent: any[] = [];
      const ui = open(sent);
      maxAppearance(ui, 1, 1);
      ui.wizard.currentStep = CreateStep.Heritage;
      ui.renderCharacterCreate();
      const row = fx.container.querySelector(`.heritage-btn[data-heritage="${h}"]`);
      if (row) click(row);
      else ui.wizard.setHeritageGroup(h, ui.chargenRollDeps(), ui.chargenRandomSource); // a heritage the era's page does not list
      ui.wizard.currentStep = CreateStep.Appearance;
      ui.renderCharacterCreate();
      const genderBtn = fx.container.querySelector(`.gender-btn[data-gender="${g}"]`);
      expect(genderBtn, `gender button ${g} on ${h}`).toBeTruthy();
      click(genderBtn);
      const r = finish(ui, 'Brenna Qaeol');
      if (sent.length !== 1) { failures.push(`${h}/${g}: sent ${sent.length}, dialog ${r.dialog}`); continue; }
      const p = sent[0];
      const faults = aceCreateFaults(charGen, { heritage: p.heritage, gender: p.gender, templateOption: p.templateIndex, startArea: p.startArea, appearance: p.appearance });
      if (faults.length) failures.push(`${h}/${g}: ${faults.join(', ')}`);
      // The attribute points spent are the heritage's (or the credit warning was answered Yes).
      const total = Object.values(p.attributes as Record<string, number>).reduce((s, v) => s + v, 0);
      expect(total).toBeLessThanOrEqual(charGen.heritageGroups.get(h).attributeCredits);
    }
    expect(failures).toEqual([]);
  });

  it('each starting town picked on the Town page goes out in range', () => {
    for (let area = 0; area < 4; area++) {
      const sent: any[] = [];
      const ui = open(sent);
      ui.wizard.currentStep = CreateStep.Town;
      ui.renderCharacterCreate();
      const pin = fx.container.querySelector(`.map-pin[data-area="${area}"]`);
      if (pin) click(pin); else ui.wizard.startArea = area;
      finish(ui, 'Brenna Qaeol');
      expect(sent).toHaveLength(1);
      expect(sent[0].startArea).toBe(area);
      expect(aceCreateFaults(charGen, { heritage: sent[0].heritage, gender: sent[0].gender, templateOption: sent[0].templateIndex, startArea: sent[0].startArea, appearance: sent[0].appearance })).toEqual([]);
    }
  });
});

describe('constrainAppearance (CharGenState::ConstrainAllByGender @ 005c5b80)', () => {
  const lists = appearanceRollLists({
    hairStyleList: [1, 2], hairColorList: [1, 2, 3], eyeStripList: [1, 2], eyeColorList: [1, 2, 3, 4, 5, 6],
    noseStripList: [1, 2], mouthStripList: [1, 2], headgearList: [1], shirtList: [1], pantsList: [1], footwearList: [1],
    clothingColorsList: [1],
  });
  const appearance = (): AppearanceState => ({
    hairStyle: 30, hairColor: 3, eyesStrip: 18, eyeColor: 7, skinColor: 0, noseStyle: 19, mouthStyle: 41,
    headgearStyle: -1, headgearColor: 5, shirtStyle: 5, shirtColor: 8, pantsStyle: 0, pantsColor: -1, footwearStyle: 1, footwearColor: 2,
    skinHue: 0.4, hairHue: 0.2, headgearHue: 0, shirtHue: 0, pantsHue: 0, footwearHue: 0,
  });

  it('pulls every index at or past its list back to the last entry and leaves the rest', () => {
    const a = appearance();
    constrainAppearance(a, lists);
    expect([a.hairStyle, a.hairColor, a.eyesStrip, a.eyeColor, a.noseStyle, a.mouthStyle]).toEqual([1, 2, 1, 5, 1, 1]);
    expect([a.headgearStyle, a.shirtStyle, a.pantsStyle, a.footwearStyle]).toEqual([-1, 0, 0, 0]);
    expect([a.skinHue, a.hairHue]).toEqual([0.4, 0.2]);
  });

  it('Set<Slot>Style: with a style chosen the colour is held to 0 .. num − 1; no headgear leaves its colour', () => {
    const a = appearance();
    constrainAppearance(a, lists, { headgear: 4, shirt: 3, pants: 2, footwear: 9 });
    expect([a.headgearColor, a.shirtColor, a.pantsColor, a.footwearColor]).toEqual([5, 2, 0, 2]);
  });

  it('no heritage / gender (null lists): everything back to −1, as Reset leaves it', () => {
    const a = appearance();
    constrainAppearance(a, null);
    expect([a.hairStyle, a.eyeColor, a.shirtStyle, a.shirtColor]).toEqual([-1, -1, -1, -1]);
  });
});

describe('FINISH sends or says why (no DATs)', () => {
  let fx: GameUIFixture;
  beforeAll(async () => { fx = await mountGameUI(); });
  afterAll(() => fx?.teardown());
  afterEach(() => { vi.useRealTimers(); });

  function open(onCreate: (w: any) => boolean | void = () => true): { ui: any; sent: () => number; events: string[] } {
    const { ui } = fx;
    ui.hideMessageDialog();
    ui.hideConfirmationDialog();
    let sent = 0;
    const events: string[] = [];
    ui.callbacks.onCharacterCreated = (w: any) => { const r = onCreate(w); if (r !== false) sent++; return r; };
    ui.callbacks.onChargenFinish = (o: string, reason?: string) => { events.push(reason ? `${o}:${reason}` : o); };
    openChargen(ui);
    ui.wizard.currentStep = CreateStep.Summary;
    ui.renderCharacterCreate();
    return { ui, sent: () => sent, events };
  }
  const press = (): void => {
    fx.container.querySelector('#btn-confirm')!.dispatchEvent(new fx.win.MouseEvent('click', { bubbles: true }));
  };
  const type = (name: string): void => {
    const input = fx.container.querySelector('#char-name-input') as HTMLInputElement;
    input.value = name;
    input.dispatchEvent(new fx.win.Event('input', { bubbles: true }));
  };
  const spendAll = (ui: any): void => { ui.wizard.attributes.strength += ui.wizard.attributesRemaining; };
  const messageText = (): string | null => fx.win.document.getElementById('ac-message-dialog')?.textContent ?? null;

  it('names with spaces, apostrophes and hyphens go out; an untyped name and a banned name each show their dialog', () => {
    for (const name of ["Mal'Tarr", 'Jo-Anne Smith', 'Brenna Qaeol']) {
      const { ui, sent, events } = open();
      spendAll(ui);
      type(name);
      press();
      expect([name, sent()]).toEqual([name, 1]);
      expect(events).toEqual(['sent']);
    }
    let r = open();
    spendAll(r.ui);
    press();
    expect(r.sent()).toBe(0);
    expect(messageText()).not.toBeNull();
    expect(r.events).toEqual(['blocked:no_name']);
    r = open();
    spendAll(r.ui);
    r.ui.setNameValidationTables(null, (n: string) => /damn/i.test(n));
    type('Damnation');
    press();
    expect(r.sent()).toBe(0);
    expect(messageText()).not.toBeNull();
    expect(r.events).toEqual(['blocked:name_banned']);
    r.ui.setNameValidationTables(null, null);
  });

  it('leftover attribute credits: the Yes / No warning, and Yes sends', () => {
    const { ui, sent, events } = open();
    ui.wizard.attributeCredits = 330; // the EoL heritages' points (no CharGen loaded here)
    type('Brenna Qaeol');
    expect(ui.wizard.attributesRemaining).toBeGreaterThan(0);
    press();
    expect(sent()).toBe(0);
    const yes = fx.win.document.querySelector('.ac-dialog-button') as HTMLElement;
    expect(yes).toBeTruthy();
    yes.dispatchEvent(new fx.win.MouseEvent('click', { bubbles: true }));
    expect(sent()).toBe(1);
    expect(events).toEqual(['blocked:credit_warning', 'sent']);
  });

  it('a server that never answers: FINISH is usable again after CHARGEN_REPLY_TIMEOUT_MS, with retail\'s catch-all refusal on screen', () => {
    vi.useFakeTimers();
    const { ui, sent, events } = open();
    spendAll(ui);
    type('Brenna Qaeol');
    press();
    press(); // pending: nothing more (DoFinish's verification-state gate)
    expect(sent()).toBe(1);
    expect(events).toEqual(['sent', 'blocked:pending']);
    vi.advanceTimersByTime(fx.mod.CHARGEN_REPLY_TIMEOUT_MS);
    expect(ui.charGenVerificationPending).toBe(false);
    expect(events.at(-1)).toBe('no_reply');
    // ID_Character_Err_NameDBDown: its table-0x23000002 text, or the same words when the table is
    // not loaded (characterCreateErrorFallbackText), never the token itself.
    expect(messageText()).toContain('The server cannot create your new character at this time. Please try again later.');
    expect(messageText()).not.toMatch(/ID_[A-Za-z_]+/);
    ui.hideMessageDialog();
    press();
    expect(sent()).toBe(2);
  });

  it('a reply in time stops the timer: no refusal dialog later', () => {
    vi.useFakeTimers();
    const { ui, events } = open();
    spendAll(ui);
    type('Brenna Qaeol');
    press();
    ui.noteCharGenVerificationResponse();
    vi.advanceTimersByTime(fx.mod.CHARGEN_REPLY_TIMEOUT_MS * 2);
    expect(events).toEqual(['sent']);
    expect(messageText()).toBeNull();
  });

  it('an exception building the request ends in the refusal dialog and FINISH works again (the error is rethrown for the page\'s reporter)', () => {
    vi.useFakeTimers();
    let fail = true;
    const { ui, sent, events } = open(() => { if (fail) throw new Error('boom'); return true; });
    spendAll(ui);
    type('Brenna Qaeol');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    press();
    err.mockRestore();
    expect(() => vi.runOnlyPendingTimers()).toThrow('boom');
    expect(ui.charGenVerificationPending).toBe(false);
    expect(messageText()).not.toBeNull();
    expect(events).toEqual(['blocked:exception']);
    ui.hideMessageDialog();
    fail = false;
    press();
    expect(sent()).toBe(1);
  });

  it('a host with nothing to send on (onCharacterCreated → false) shows the refusal, not silence', () => {
    const { ui, sent, events } = open(() => false);
    spendAll(ui);
    type('Brenna Qaeol');
    press();
    expect(sent()).toBe(0);
    expect(ui.charGenVerificationPending).toBe(false);
    expect(messageText()).not.toBeNull();
    expect(events).toEqual(['blocked:not_sent']);
  });

  it('a message dialog whose element went away does not swallow FINISH\'s dialog', () => {
    const { ui } = open();
    ui.showMessageDialog('old');
    fx.win.document.getElementById('ac-message-dialog')!.remove();
    press(); // no name typed
    expect(messageText()).not.toBeNull();
    expect(messageText()).not.toContain('old');
  });

  it('a world PopupString does not outlive the world: character select and chargen close it', () => {
    const { ui } = fx;
    ui.showPopupStringDialog('Welcome to Asheron\'s Call!');
    expect(ui.popupStringDialogCount).toBe(1);
    ui.showCharacterSelect([]);
    expect(ui.popupStringDialogCount).toBe(0);
    ui.showPopupStringDialog('again');
    openChargen(ui);
    expect(ui.popupStringDialogCount).toBe(0);
  });
});

/**
 * BUG.chargen-double-create (playwebac.com, build 672ef4b6, 2026-10-19):
 * chargen_sent → chargen_ok → chargen_sent AGAIN 3 s later (still on the
 * chargen screen) → enter_ok → chargen_refused "timeout" in the world. After
 * an OK, gmCharGenMainUI::RecvNotice_CharGenVerificationResponse @ 004e9030
 * set m_bAwaitingCharSetForLogin and Update @ 004e8460 logged the character
 * on, so retail's chargen UI was gone; ours stays up until the world, so it
 * goes inert under Entering World, and every chargen timer ends with the screen.
 */
describe('after an OK reply, and leaving the chargen screen (no DATs)', () => {
  let fx: GameUIFixture;
  beforeAll(async () => { fx = await mountGameUI(); });
  afterAll(() => fx?.teardown());
  afterEach(() => { vi.useRealTimers(); });

  function ready(): { ui: any; sent: () => number; events: string[] } {
    const { ui } = fx;
    ui.hideMessageDialog();
    ui.hideConfirmationDialog();
    let sent = 0;
    const events: string[] = [];
    ui.callbacks.onCharacterCreated = () => { sent++; return true; };
    ui.callbacks.onChargenFinish = (o: string, reason?: string) => { events.push(reason ? `${o}:${reason}` : o); };
    ui.callbacks.onCancelCreate = undefined;
    openChargen(ui);
    ui.wizard.currentStep = CreateStep.Summary;
    ui.renderCharacterCreate();
    const input = fx.container.querySelector('#char-name-input') as HTMLInputElement;
    input.value = 'Brenna Qaeol';
    input.dispatchEvent(new fx.win.Event('input', { bubbles: true }));
    ui.wizard.attributes.strength += ui.wizard.attributesRemaining;
    return { ui, sent: () => sent, events };
  }
  const press = (id = '#btn-confirm'): void => {
    fx.container.querySelector(id)!.dispatchEvent(new fx.win.MouseEvent('click', { bubbles: true }));
  };
  const enteringWorld = (): boolean => !!fx.container.querySelector('#charsel-enteringworld');
  const messageText = (): string | null => fx.win.document.getElementById('ac-message-dialog')?.textContent ?? null;

  it('the production repro: FINISH → OK → FINISH again sends no second CharacterCreate, and nothing fires in the world', () => {
    vi.useFakeTimers();
    const { ui, sent, events } = ready();
    press();
    expect(sent()).toBe(1);
    ui.noteCharGenVerificationResponse(true);
    expect(ui.charGenVerificationPending).toBe(false);
    expect(ui.charGenAwaitingLogin).toBe(true);
    // Retail's wait text for an enter under way, with its input blocker.
    expect(enteringWorld()).toBe(true);
    press(); // a click that reaches FINISH anyway (an agent's dispatched click)
    press();
    expect(sent()).toBe(1);
    expect(events).toEqual(['sent', 'blocked:entering_world', 'blocked:entering_world']);
    // EXIT (DoExit) does nothing either: no way back to character select mid-login.
    expect(ui.doChargenExit()).toBe(false);
    expect(ui.isChargenExitDialogOpen).toBe(false);
    // The world arrives: the wait dialog goes, and no timer ever reports a refusal.
    ui.showGame();
    expect(enteringWorld()).toBe(false);
    expect(ui.charGenAwaitingLogin).toBe(false);
    vi.advanceTimersByTime(fx.mod.CHARGEN_REPLY_TIMEOUT_MS * 3);
    expect(events).toEqual(['sent', 'blocked:entering_world', 'blocked:entering_world']);
    expect(messageText()).toBeNull();
  });

  it('a refusal reply leaves FINISH live (RecvNotice\'s error cases), as before', () => {
    const { ui, sent, events } = ready();
    press();
    ui.noteCharGenVerificationResponse(false);
    expect(ui.charGenAwaitingLogin).toBe(false);
    expect(enteringWorld()).toBe(false);
    press();
    expect(sent()).toBe(2);
    expect(events).toEqual(['sent', 'sent']);
  });

  it('an OK that arrives after the screen was left changes nothing there', () => {
    const { ui } = ready();
    press();
    ui.showCharacterSelect([]);
    ui.noteCharGenVerificationResponse(true);
    expect(ui.charGenAwaitingLogin).toBe(false);
    expect(enteringWorld()).toBe(false);
  });

  for (const [how, leave] of [
    ['world entry', (ui: any) => ui.showGame()],
    ['character select', (ui: any) => ui.showCharacterSelect([])],
    ['a disconnect', (ui: any) => ui.showDisconnectedScreen('The connection to the server has been lost!', () => {})],
  ] as const) {
    it(`leaving by ${how} with a CharacterCreate unanswered: the reply timer is cleared, no no_reply, no dialog`, () => {
      vi.useFakeTimers();
      const { ui, events } = ready();
      press();
      expect(ui.charGenVerificationPending).toBe(true);
      leave(ui);
      expect(ui.charGenVerificationPending).toBe(false);
      vi.advanceTimersByTime(fx.mod.CHARGEN_REPLY_TIMEOUT_MS * 2);
      expect(events).toEqual(['sent']);
      expect(messageText() ?? '').not.toContain('cannot create your new character');
    });
  }

  it('re-entering chargen after a created character\'s session starts fresh: FINISH sends again', () => {
    const { ui } = ready();
    press();
    ui.noteCharGenVerificationResponse(true);
    ui.showCharacterSelect([]);
    const again = ready();
    expect(again.ui.charGenAwaitingLogin).toBe(false);
    press();
    expect(again.sent()).toBe(1);
    expect(again.events).toEqual(['sent']);
  });

  it('CREATE waiting on the world art opens chargen only if character select is still up when it lands', async () => {
    const { ui } = fx;
    /** The world art pending, cleared on arrival as the constructor's worldArtReady hook does. */
    const pendingArt = (): { done: Promise<void>; land: () => void } => {
      let land!: () => void;
      const done = new Promise<void>((r) => { land = r; });
      done.then(() => { if (ui.worldArtPending === done) ui.worldArtPending = null; });
      ui.worldArtPending = done;
      return { done, land };
    };
    ui.showCharacterSelect([]);
    let art = pendingArt();
    ui.showCharacterCreate();
    expect(ui.uiManager.currentScreen).toBe('character-select');
    ui.showDisconnectedScreen('The connection to the server has been lost!', () => {});
    art.land();
    await art.done;
    await Promise.resolve();
    expect(ui.uiManager.currentScreen).toBe('disconnected');
    // Still on character select when the art lands: chargen opens, as before.
    ui.showCharacterSelect([]);
    art = pendingArt();
    ui.showCharacterCreate();
    expect(ui.uiManager.currentScreen).toBe('character-select');
    art.land();
    await art.done;
    await Promise.resolve();
    expect(ui.uiManager.currentScreen).toBe('character-create');
  });
});

describe('FINISH telemetry (PreworldReporter → the bridge allowlist)', () => {
  function reporter(): { r: PreworldReporter; bodies: PreworldEvent[] } {
    const bodies: PreworldEvent[] = [];
    const r = new PreworldReporter({
      endpoint: 'http://x/client-preworld', build: 'abc1234', era: () => 'eor', server: () => 'coldeve',
      screen: () => 'chargen', now: () => 5000, trace: 'feedc0de12345678', send: (_u, b) => { bodies.push(JSON.parse(b)); },
    });
    return { r, bodies };
  }

  it('chargen_sent, chargen_blocked (each reason once per page) and chargen_refused "timeout" pass the bridge whole', () => {
    const { r, bodies } = reporter();
    r.chargenSent();
    r.chargenBlocked('pending');
    r.chargenBlocked('pending');
    r.chargenBlocked('name_banned');
    r.chargenBlocked('entering_world');
    r.chargenNoReply();
    expect(bodies.map((b) => `${b.outcome}:${b.token}`)).toEqual([
      'chargen_sent:null', 'chargen_blocked:pending', 'chargen_blocked:name_banned', 'chargen_blocked:entering_world', 'chargen_refused:timeout',
    ]);
    for (const b of bodies) expect(sanitizeClientPreworld(b)).toEqual(b);
  });
});
