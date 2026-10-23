/**
 * BUG.ac1999-eor-ui-values — where the 1999 client differs from end of retail
 * only in a VALUE (a string, a slot set, an option list), the shared panels read
 * it from the era's client profile (era/EraFeatures.ts eraClientRules), one
 * lookup per panel. Pins every 1999 value against the 1999 client.exe address it
 * came from, the unchanged end-of-retail / Dark Majesty values, and drives the
 * real GameUI (happy-dom) to show each panel follows the profile:
 *
 *  1. the paperdoll's slots (InventoryPanel @ 0x522fc0: eight, no Slots view),
 *  2. the character panel's footer wording (InfoBox family, 0x608b7c-0x60908c),
 *  3. one Raise button (no "+10"),
 *  4. training a skill without a confirmation,
 *  5. the combat bar's checkboxes (CombatPanel @ 0x589bc0: no Keep in View),
 *  6. the spellbook delete prompt (0x604e60),
 *  7. the Chat menu's "Ignore" wording and the "Chat" / "Tell" button,
 *  8. Character options rows that do nothing on 1999, and its own labels,
 *  9. the character examine page ("No Allegiance", Loyalty / Leadership, "No Fellowship"),
 * 10. the item hover text (" (worn)", the "Double click to …" hint, the vendor's "Worth %up").
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { CombatMode, EquipMask, APPRAISAL_1999_INT } from '@ac/shared';
import { eraClientRules, resolveClientText, EOR_TRAIN_SKILL_CONFIRM, hiddenBy, unsupportedFeatures, FEATURE_CHARACTER_OPTIONS } from '../packages/renderer/src/era/EraFeatures.js';
import { eraProfile } from '../packages/renderer/src/era/EraProfiles.js';
import { spellbookDeleteConfirmText, SPELLBOOK_DELETE_CONFIRM_FORMAT } from '../packages/renderer/src/ui/spellbookFilter.js';
import { buildCharacterPage } from '../packages/renderer/src/ui/examine/CreatureAppraisalText.js';
import { itemHoverText, itemHoverHint1999, itemTooltipText } from '../packages/renderer/src/ui/HudTooltips.js';
import { CHARACTER_SETTINGS_ROWS } from '../packages/renderer/src/ui/CharacterSettingsModel.js';
import { TalkFocus, MENU_ITEMS } from '../packages/renderer/src/ui/ChatTalkFocus.js';
import type { IdentifyResponseData } from '../packages/renderer/src/network/ServerMessageHandler.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

const R1999 = eraClientRules(eraProfile('ac1999-retail'));
const EOR = eraClientRules(eraProfile('eor'));
const CLASSIC_IDS = ['classic-dereth', 'classicace-customdm', 'classicace-infiltration'];
const noStrings = (): null => null;

describe('the client profile: 1999 values from the 1999 client.exe, end of retail unchanged', () => {
  it('end of retail and every classic era share one profile (they run the end-of-retail acclient.exe)', () => {
    for (const id of CLASSIC_IDS.filter((i) => i !== 'classicace-customdm')) expect(eraClientRules(eraProfile(id)), id).toBe(EOR);
    expect(eraClientRules(null)).toBe(EOR);
    // acclient_CustomDM.exe differs only in one map note's name (BUG.ac1999-map-eor-art; verify-ac1999-map-panel.ts).
    const cdm = eraClientRules(eraProfile('classicace-customdm'));
    expect({ ...cdm, mapPanel: null }).toEqual({ ...EOR, mapPanel: null });
    expect(cdm.mapPanel.notes.map((n) => n.name).filter((n, i) => n !== EOR.mapPanel.notes[i].name)).toEqual(['Other']);
  });

  it('1. paperdoll slots: the 1999 InventoryPanel\'s eight (0x1bf8000); end of retail every slot', () => {
    expect(R1999.equipSlotMask).toBe(0x1bf8000);
    expect(R1999.equipSlotMask).toBe(EquipMask.NeckWear | EquipMask.WristWearLeft | EquipMask.WristWearRight
      | EquipMask.FingerWearLeft | EquipMask.FingerWearRight | EquipMask.MeleeWeapon | EquipMask.Held
      | EquipMask.MissileAmmo | EquipMask.Shield);
    expect(EOR.equipSlotMask >>> 0).toBe(0xffffffff);
  });

  it('2. footer wording: the 1999 strings; end of retail the local-DAT ids with their fallbacks', () => {
    const t = (x: Parameters<typeof resolveClientText>[0]) => resolveClientText(x, noStrings);
    const f = R1999.statFooterText;
    expect([t(f.attributePrompt), t(f.skillPrompt), t(f.xpToRaise), t(f.xpToRaiseVital), t(f.xpToRaiseSkill)]).toEqual([
      'Select an attribute to improve.', 'Select a skill to improve.', 'XP to raise:', 'XP to raise max value:', 'XP cost to raise skill:']);
    expect([t(f.unassignedXp), t(f.creditsToTrain), t(f.creditsAvailable), t(f.infinity), t(f.totalXp)]).toEqual([
      'Unassigned XP:', 'Skill credits needed to train:', 'Skill credits available:', 'INFINITY', 'Total experience (XP):']);
    const e = EOR.statFooterText;
    expect(e.attributePrompt).toEqual({ stringId: 202231733, fallback: 'Select an Attribute to Improve' });
    expect(e.unassignedXp).toEqual({ stringId: 249332076, fallback: 'Unassigned Experience:' });
    expect(e.xpToRaise).toEqual(e.xpToRaiseVital);
    expect(e.xpToRaise).toEqual(e.xpToRaiseSkill);
    expect(t(e.infinity)).toBe('Infinity!');
    // The loaded string table wins over the fallback.
    expect(resolveClientText(e.totalXp, (id) => (id === 168019916 ? 'DAT text' : null))).toBe('DAT text');
  });

  it('3 / 4. one Raise button and no train prompt on 1999; end of retail keeps both', () => {
    expect([R1999.statRaiseTen, R1999.trainSkillConfirm]).toEqual([false, null]);
    expect([EOR.statRaiseTen, EOR.trainSkillConfirm]).toEqual([true, EOR_TRAIN_SKILL_CONFIRM]);
  });

  it('5. combat bar rows: 1999 Repeat Attacks + Auto Target; end of retail adds Keep in View', () => {
    expect(R1999.combatBarOptions).toEqual(['repeatAttacks', 'autoTarget']);
    expect(EOR.combatBarOptions).toEqual(['repeatAttacks', 'autoTarget', 'keepCombatTargetsInView']);
  });

  it('6. spellbook delete prompt', () => {
    expect(spellbookDeleteConfirmText('Flame Bolt I', R1999.spellDeleteConfirm)).toBe('Are you sure you want to delete Flame Bolt I?');
    expect(EOR.spellDeleteConfirm).toBe(SPELLBOOK_DELETE_CONFIRM_FORMAT);
    expect(spellbookDeleteConfirmText('Flame Bolt I', EOR.spellDeleteConfirm)).toBe(spellbookDeleteConfirmText('Flame Bolt I'));
  });

  it('7. chat menu: "Ignore Selected" / "Ignore ", the button "Chat" / "Tell"; end of retail the DAT strings', () => {
    expect(R1999.chatTargetText).toEqual({
      squelchSelected: 'Ignore Selected', squelchPrefix: 'Ignore ',
      buttonLabels: { 1: 'Chat', 2: 'Tell', 3: 'Tell', 4: 'Tell', 5: 'Tell', 6: 'Tell' },
    });
    expect(EOR.chatTargetText).toBeNull();
  });

  it('8. option rows: every inert / relabelled row is a real Character-page row; end of retail hides and relabels none', () => {
    const names = new Set(CHARACTER_SETTINGS_ROWS.map((r) => r.playerOption));
    for (const n of [...R1999.characterOptionsInert, ...Object.keys(R1999.characterOptionLabels)]) expect(names.has(n), n).toBe(true);
    expect([...R1999.characterOptionsInert].sort()).toEqual(['DisplayAge', 'DisplayDateOfBirth', 'DisplayNumberDeaths',
      'FilterLanguage', 'MainPackPreferred', 'UseChargeAttack']);
    // The auto-accept row is the autoAcceptFellowship feature's (with its pane checkbox and key), not listed twice.
    expect(hiddenBy(FEATURE_CHARACTER_OPTIONS, unsupportedFeatures(eraProfile('ac1999-retail'))).has('FellowshipAutoAcceptRequests')).toBe(true);
    expect(hiddenBy(FEATURE_CHARACTER_OPTIONS, unsupportedFeatures(eraProfile('eor'))).size).toBe(0);
    // Rows that work stay: the server reads them (share XP / loot, helm, missiles, logons) or our client acts on them.
    for (const keep of ['FellowshipShareXP', 'FellowshipShareLoot', 'ShowHelm', 'LeadMissileTargets', 'UseFastMissiles',
      'DisplayAllegianceLogonNotifications', 'CoordinatesOnRadar', 'SideBySideVitals', 'SpellDuration', 'DisplayTimeStamps']) {
      expect(R1999.characterOptionsInert.includes(keep), keep).toBe(false);
    }
    expect(R1999.characterOptionLabels.ViewCombatTarget).toBe('Automatically keep combat targets in view');
    expect(R1999.characterOptionLabels.ShowTooltips).toBe('Display Tooltips');
    expect(EOR.characterOptionsInert).toEqual([]);
    expect(EOR.characterOptionLabels).toEqual({});
  });

  it('9 / 10. examine and hover text', () => {
    expect(R1999.characterExamineText).toEqual({ noAllegiance: 'No Allegiance', noFellowship: 'No Fellowship', allegianceMonarch: 'Allegiance Monarch:', unenchantableLegend: false });
    expect(EOR.characterExamineText).toEqual({ noAllegiance: null, noFellowship: null, allegianceMonarch: 'Alleg. Monarch:', unenchantableLegend: true });
    expect(EOR.itemHoverText).toBeNull();
    expect(R1999.itemHoverText?.vendorWorth.buy).toBe('Worth %up - Double click to buy');
  });
});

// ── 9. The character examine page ───────────────────────────────────────────

function character(ints: Record<number, number>, strings: Record<number, string> = {}): IdentifyResponseData {
  return {
    guid: 0x50000001, success: true,
    propertiesInt: new Map(Object.entries(ints).map(([k, v]) => [Number(k), v])),
    propertiesString: new Map(Object.entries(strings).map(([k, v]) => [Number(k), v])),
    creatureProfile: { profileFlags: 0x8, health: 10, healthMax: 10 },
  } as unknown as IdentifyResponseData;
}
const labels = (d: IdentifyResponseData, eraText = EOR.characterExamineText) =>
  buildCharacterPage(d, { success: true, eraText }).miscInfo.map((l) => (l.value ? `${l.label} ${l.value}` : l.label));

describe('the character examine page follows the profile and the 1999 data', () => {
  const LOYAL = { [APPRAISAL_1999_INT.loyalty]: 10, [APPRAISAL_1999_INT.leadership]: 12 };

  it('1999, unaffiliated: "No Allegiance", Loyalty / Leadership from the 1999 profile, "No Fellowship", no legend', () => {
    const lines = labels(character({ 30: 0, ...LOYAL }), R1999.characterExamineText);
    expect(lines).toEqual(['No Allegiance', 'Loyalty: 10', 'Leadership: 12', 'No Fellowship']);
  });

  it('1999, sworn: "Monarch:" / "Allegiance Monarch:"; a fellowship by name', () => {
    expect(labels(character({ 30: 2, 35: 3 }, { 10: 'Band' }), R1999.characterExamineText))
      .toEqual(['Allegiance Monarch: 3 Followers', 'Fellowship: Band']);
    expect(labels(character({ 30: 2 }, { 21: 'Lord Acjs' }), R1999.characterExamineText)).toEqual(['Monarch: Lord Acjs', 'No Fellowship']);
  });

  it('end of retail: no unaffiliated lines (its data has no Loyalty either), "Alleg. Monarch:", the legend', () => {
    expect(labels(character({ 30: 0 }))).toEqual(['* = Unenchantable']);
    expect(labels(character({ 30: 1, 35: 1 }))).toEqual(['Alleg. Monarch: 1 Follower', '* = Unenchantable']);
    // The profile decides the lines, the data the numbers: EoR wording ignores stray 1999 keys.
    expect(labels(character({ 30: 0, ...LOYAL }))).toEqual(['* = Unenchantable']);
  });
});

// ── 10. The item hover text ─────────────────────────────────────────────────

describe('item hover text (HudTooltips.itemHoverText)', () => {
  const T = R1999.itemHoverText!;
  it('end of retail: the (counted) name alone, as UIElement_UIItem::UpdateTooltip', () => {
    expect(itemHoverText({ name: 'Arrow', pluralName: 'Arrows', stackSize: 20 }, 'worn', null)).toBe(itemTooltipText('Arrow', 'Arrows', 20));
    expect(itemHoverText({ name: 'Dagger', validLocations: 0x100000, combatUse: 1, usable: 0x10 }, 'pack', null)).toBe('Dagger');
  });

  it('1999 name line: " (worn)" for clothing / jewellery, " (wielded)" for the rest, " (container)", "Selling "', () => {
    expect(itemHoverText({ name: 'Ring', validLocations: EquipMask.FingerWearLeft }, 'worn', T)).toBe('Ring (worn)\nDouble click to unwield/take off');
    expect(itemHoverText({ name: 'Dagger', validLocations: EquipMask.MeleeWeapon }, 'worn', T).split('\n')[0]).toBe('Dagger (wielded)');
    expect(itemHoverText({ name: 'Pack', itemType: 0x200, usable: 0x10 }, 'pack', T)).toBe('Pack (container)\nDouble click to open and close');
    expect(itemHoverText({ name: 'Gem', selling: true }, 'pack', T)).toBe('Selling Gem');
    expect(itemHoverText({ name: 'Arrow', pluralName: 'Arrows', stackSize: 20 }, 'external', T)).toBe('20 Arrows\nDouble click to pick up');
  });

  it('1999 hints by the use result and type (@ 0x589460)', () => {
    expect(itemHoverHint1999({ name: 'Sword', validLocations: EquipMask.MeleeWeapon, combatUse: 1 }, 'pack', T)).toBe('Double click to wield');
    expect(itemHoverHint1999({ name: 'Wand', validLocations: EquipMask.Held, itemType: 0x8000 }, 'pack', T)).toBe('Double click to wield');
    expect(itemHoverHint1999({ name: 'Helm', validLocations: EquipMask.HeadWear }, 'pack', T)).toBe("Double click to wear (if there's room)");
    expect(itemHoverHint1999({ name: 'Apple', itemType: 0x20, usable: 0x10 }, 'pack', T)).toBe('Double click to consume');
    expect(itemHoverHint1999({ name: 'Book', itemType: 0x2000, usable: 0x10 }, 'pack', T)).toBe('Double click to read or write');
    expect(itemHoverHint1999({ name: 'Key', itemType: 0x4000, usable: 0x10 }, 'pack', T)).toBe('Double click to unlock your last selected item');
    expect(itemHoverHint1999({ name: 'Stone', itemType: 0x80000, usable: 0x10, hasMana: true }, 'pack', T)).toBe('Double click to transfer Mana to an item.');
    expect(itemHoverHint1999({ name: 'Stone', itemType: 0x80000, usable: 0x10, hasMana: false }, 'pack', T)).toBe('Double click to drain Mana from, and destroy, an item.');
    expect(itemHoverHint1999({ name: 'Stone', itemType: 0x80000, usable: 0x10 }, 'pack', T)).toBeNull();
    expect(itemHoverHint1999({ name: 'Kit', itemType: 0x80, usable: 0x10 }, 'pack', T)).toBe('Double click to use');
    expect(itemHoverHint1999({ name: 'Junk', usable: 1 }, 'pack', T)).toBeNull();
  });

  it('the vendor\'s line replaces the hint ("%up": the price, then "p")', () => {
    expect(itemHoverText({ name: 'Mace' }, 'external', T, { line: 'buy', price: 250 })).toBe('Mace\nWorth 250p - Double click to buy');
    expect(itemHoverText({ name: 'Mace' }, 'pack', T, { line: 'sellList', price: 40 })).toBe('Mace\nWorth 40p - Double click to remove from selling list');
  });
});

// ── The real GameUI ─────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubLayoutRenderer(H: GameUIFixture): any {
  const doc = H.win.document;
  const makeHandle = (parent: HTMLElement) => {
    const root = doc.createElement('div');
    parent.appendChild(root);
    const elements = new Map<number, HTMLElement>();
    const get = elements.get.bind(elements);
    elements.get = (id: number) => {
      let el = get(id);
      if (!el) {
        el = doc.createElement('div') as HTMLElement;
        el.dataset.elementId = `0x${id.toString(16)}`;
        root.appendChild(el);
        elements.set(id, el);
      }
      return el;
    };
    const noop = () => {};
    return {
      root, layout: { elements: [] }, elements, descs: new Map(),
      setText: noop, setFill: noop, setVisible: noop, setState: noop, setPalette: noop, setInteractive: noop,
      setScrollable: () => ({ contentEl: doc.createElement('div'), setPosition: noop, scrollToBottom: noop, appendContent: noop }),
      setDraggable: noop, setDropTarget: noop, setTexture: noop, onClick: noop, resizeSubtree: noop,
      destroy: () => root.remove(), moveTo: noop, close: () => root.remove(), bringToFront: noop,
    };
  };
  return {
    render: (_id: number, parent: HTMLElement) => makeHandle(parent),
    renderPanel: (_id: number, parent: HTMLElement) => makeHandle(parent),
    getTextureDataURLWithAlpha: () => null, getResolvedLayout: () => null, setFontResolver: () => {},
  };
}

const PLAYER = 0x50000001;
const item = (id: number, name: string, extra: Record<string, unknown> = {}) => ({
  id, weenieClassId: id & 0xffff, name, value: 1, burden: 10, stackSize: 1, maxStackSize: 1, stackable: false, containerId: PLAYER, ...extra,
});

for (const [era, rules] of [['ac1999-retail', R1999], ['eor', EOR]] as const) {
  const is1999 = era === 'ac1999-retail';
  describe(`GameUI follows the ${era} profile (behavioral)`, () => {
    let H: GameUIFixture;
    beforeAll(async () => {
      H = await mountGameUI();
      H.ui.layoutRenderer = stubLayoutRenderer(H);
      H.ui.setUnsupportedFeatures(unsupportedFeatures(eraProfile(era)));
      H.ui.setClientRules(rules);
    }, 60_000);
    afterAll(() => H?.teardown());

    it('setClientRules hands the rule-driven setters their values', () => {
      expect(H.ui.clientProfile).toBe(rules);
      expect(H.ui.statLineTextKind).toBe(rules.statLineText);
      expect(H.ui.hasSpellResearch).toBe(rules.spellResearch);
    });

    describe('1. the paperdoll', () => {
      const slotsShown = (): string[] => {
        const pd = H.ui.inventoryPanelHandle.elements.get(0x100001cd) as HTMLElement;
        return [...pd.querySelectorAll('div')].map((d) => (d as HTMLElement).dataset.equipSlot).filter((x): x is string => !!x);
      };
      const gem = (): Element | null => (H.ui.inventoryPanelHandle.elements.get(0x100001cd) as HTMLElement).querySelector('[data-element-id="0x100005be"]');
      beforeEach(() => {
        H.ui.setSidePackGuids([PLAYER]);
        H.ui.setInventoryData([item(0x8000aaaa, 'Dagger')], [], 10, 15000);
        if (!H.ui.inventoryVisible) H.ui.toggleInventory(); else H.ui.renderInventoryPanel();
      });

      it(is1999 ? 'the eight 1999 slots, no shirt / pants / cloak / trinket, no Slots gem' : 'every flank slot and the Slots gem', () => {
        const shown = slotsShown();
        for (const s of ['Neck', 'Right Bracelet', 'Left Bracelet', 'Right Ring', 'Left Ring', 'Shield', 'Weapon', 'Ammunition']) expect(shown, s).toContain(s);
        for (const s of ['Shirt', 'Pants', 'Cloak', 'Trinket']) expect(shown.includes(s), s).toBe(!is1999);
        expect(gem() !== null).toBe(!is1999);
      });

      it(is1999 ? 'a stored Slots view still shows the portrait (no body-region slots)' : 'the Slots view shows the nine body-region slots', () => {
        H.ui.inventorySlotsView = true;
        H.ui.renderInventoryPanel();
        expect(slotsShown().includes('Head')).toBe(!is1999);
        H.ui.inventorySlotsView = false;
      });

      it(is1999 ? 'a pack item reads the 1999 name line and hint' : 'a pack item reads its name alone', () => {
        H.ui.setInventoryData([item(0x8000aaaa, 'Dagger', { validLocations: EquipMask.MeleeWeapon, combatUse: 1 })], [], 10, 15000);
        H.ui.renderInventoryPanel();
        const cell = (H.ui.inventoryPanelHandle.elements.get(0x100001cf) as HTMLElement).querySelector('[data-inv-slot="0"]') as HTMLElement;
        expect(cell.dataset.acTooltipText).toBe(is1999 ? 'Dagger\nDouble click to wield' : 'Dagger');
      });
    });

    describe('2 / 3 / 4. the character panel footer', () => {
      beforeEach(() => {
        H.ui.setRaiseCallbacks({ onTrainSkill: (id: number, cost: number) => trained.push([id, cost]) },
          { attribute: [0, 100, 300], vital: [0, 100, 300], trainedSkill: [0, 100, 300], specializedSkill: [0, 100, 300] });
        trained.length = 0;
      });
      const trained: Array<[number, number]> = [];

      it(is1999 ? 'a vital reads "XP to raise max value:", "Unassigned XP:", one Raise button' : 'a vital reads the DAT wording and has the +10', () => {
        H.ui.charInfo.vitals.health = { current: 10, max: 10, base: 10, baseMax: 10, raises: 0, xp: 0 };
        H.ui.selectedStatRow = { kind: 'vital', id: 1 };
        const m = H.ui.statFooterModel('attributes');
        expect(m.line1Label).toBe(is1999 ? 'XP to raise max value:' : 'Experience To Raise:');
        expect(m.line2Label).toBe(is1999 ? 'Unassigned XP:' : 'Unassigned Experience:');
        expect(m.raise10Visible).toBe(!is1999);
      });

      it(is1999 ? 'an untrained skill trains at once, no dialog' : 'an untrained skill asks first', () => {
        H.ui.skillTable = { skills: new Map([[6, { trainedCost: 4 }]]) };
        H.ui.charInfo.skillCredits = 10;
        H.ui.charInfo.skills = [{ id: 6, name: 'Melee Defense', status: 'Untrained', base: 0, effective: 0, raises: 0 }];
        H.ui.selectedSkillId = 6;
        const m = H.ui.statFooterModel('skills');
        expect(m.line1Label).toBe(is1999 ? 'Skill credits needed to train:' : 'Skill Credits To Train');
        expect(m.line2Label).toBe(is1999 ? 'Skill credits available:' : 'Skill Credits Available:');
        let asked = '';
        H.ui.showConfirmationDialog = (text: string, cb: (yes: boolean) => void) => { asked = text; cb(true); };
        m.onRaise();
        expect(asked).toBe(is1999 ? '' : 'Are you sure you want to spend 4 credits to train Melee Defense?');
        expect(trained).toEqual([[6, 4]]);
      });
    });

    it(is1999 ? '5. the combat bar has no Keep in View row' : '5. the combat bar keeps the Keep in View row', () => {
      H.ui.hud.combatMode = CombatMode.Melee;
      H.ui.renderCombatBar();
      const rows = [...H.container.querySelectorAll('[data-option-key]')].map((r) => (r as HTMLElement).dataset.optionKey);
      expect(rows).toContain('repeatAttacks');
      expect(rows).toContain('autoTarget');
      expect(rows.includes('keepCombatTargetsInView')).toBe(!is1999);
    });

    it(is1999 ? '7. the chat menu says "Ignore", the button "Tell"' : '7. the chat menu keeps the DAT words', () => {
      const squelch = MENU_ITEMS.find((i) => i.focus === null)!;
      H.ui.talkFocus.setSelected(0, '', false);
      expect(H.ui.talkFocusItemText(squelch)).toBe(is1999 ? 'Ignore Selected' : 'Squelch (ignore) Selected');
      H.ui.talkFocus.setSelected(0x50000002, 'Bob', false);
      expect(H.ui.talkFocusItemText(squelch)).toBe(is1999 ? 'Ignore Bob' : 'Squelch (ignore) Bob');
      H.ui.talkFocus.setEnabled(TalkFocus.Fellows, true);
      H.ui.talkFocus.handleSelection(TalkFocus.Fellows);
      expect(H.ui.talkFocusButtonText()).toBe(is1999 ? 'Tell' : 'Fell');
      H.ui.talkFocus.handleSelection(TalkFocus.Say);
      expect(H.ui.talkFocusButtonText()).toBe('Chat');
    });

    it(is1999 ? '8. the Character page drops the inert rows and wears the 1999 labels' : '8. the Character page keeps every row and the DAT labels', () => {
      H.ui.optionsTab = 'character';
      if (!H.ui.optionsPanelVisible) H.ui.toggleOptionsPanel(); else H.ui.renderOptionsPanel();
      const rows = [...H.ui.optionsPanel.querySelectorAll('.option-toggle-row')] as HTMLElement[];
      const keys = new Set(rows.map((r) => r.dataset.optionKey));
      for (const k of ['useMainPackAsDefaultForPickingUpItems', 'filterLanguage', 'allowSeeDateOfBirth', 'allowSeeAge',
        'allowSeeNumberOfDeaths', 'autoAcceptFellowshipRequests', 'useChargeAttack']) expect(keys.has(k), k).toBe(!is1999);
      // BUG.webac11-radar-1999: the 1999 client had no radar coordinates and no spell-duration readout.
      for (const k of ['showCoordinatesByTheRadar', 'displaySpellDurations']) expect(keys.has(k), k).toBe(!is1999);
      for (const k of ['shareFellowshipXP', 'shareFellowshipLoot', 'showHelm', 'keepCombatTargetsInView', 'runAsDefault']) {
        expect(keys.has(k), k).toBe(true);
      }
      const label = rows.find((r) => r.dataset.optionKey === 'keepCombatTargetsInView')!.textContent;
      expect(label).toContain(is1999 ? 'Automatically keep combat targets in view' : 'Keep Combat Targets in View');
      H.ui.toggleOptionsPanel();
    });
  });
}
