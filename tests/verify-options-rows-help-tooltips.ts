/**
 * VISUAL.options-rows-help-tooltips — every Options row's UIOption shows its
 * retail help text on hover.
 *
 * Retail: gmCharacterSettingsUI::InitOptions @ 004a02f0 follows every
 * AddToggleOption with PlayerOptionPage::SetToggleLabel @ 004f2750, which
 * sets the label and then SetTooltip's (vtable +0x2b4) StringInfo(hash(
 * "ID_PlayerOption_*_Help"), table enum 0x10000003). Config prefs are
 * AttachPreference'd with a help id (decomp :2488-3008) that UIOption_*::
 * SetUIPreference hands to UIOption::SetTooltip @ 004ef2c0; the Sound rows
 * are UIOption_CheckboxSlider pairs (SetUIPreference @ 004847d0), checkbox
 * and slider each with their own pref's help. The list-template widgets in
 * 0x2100002b (checkbox 0x10000219, slider 0x1000021c, menu 0x10000224) carry
 * p75 on + p71 root 0x10000397; the row labels carry none.
 *
 * Drives the real GameUI + LayoutRenderer over the DATs (skipped without).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import { CHARACTER_SETTINGS_PAGE } from '../packages/renderer/src/ui/CharacterSettingsModel.js';
import {
  CONFIG_HELP_TOKENS, CONFIG_TOGGLE_HELP_TOKENS, CHAT_FILTER_TOKENS, CHAT_OPACITY_OPTION_DESCS,
} from '../packages/renderer/src/ui/OptionsStrings.js';

const REPO = resolve(__dirname, '..');
const LANG_PATH = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(REPO, 'dat/client_portal.dat');
const hasDats = fs.existsSync(LANG_PATH) && fs.existsSync(PORTAL_PATH);

describe.skipIf(!hasDats)('VISUAL.options-rows-help-tooltips — Options rows carry their 0x23000003 help tooltip (real LayoutRenderer + DATs)', () => {
  let H: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dat: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gameplayOptionList: Map<number, any>;
  const helpText = (token: string): string | null =>
    dat.getStringFromTable(0x23000003, dat.acStringHash(token)) as string | null;

  beforeAll(async () => {
    H = await mountGameUI({ size: { innerWidth: 1600, innerHeight: 900 } });
    dat = await import('@ac/dat-parser');
    const portalBuf = fs.readFileSync(PORTAL_PATH);
    const portalDb = new dat.DatDatabase(portalBuf.buffer.slice(portalBuf.byteOffset, portalBuf.byteOffset + portalBuf.byteLength));
    dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portalDb.getFileData(0x39000001)!)));
    gameplayOptionList = dat.DbProperty.read(new dat.DatReader(portalDb.getFileData(0x78000000)!)).properties;
    const langBuf = fs.readFileSync(LANG_PATH);
    const langDb = new dat.DatDatabase(langBuf.buffer.slice(langBuf.byteOffset, langBuf.byteOffset + langBuf.byteLength));
    for (const t of [0x23000001, 0x23000003, 0x2300000d]) dat.registerStringTable(dat.parseStringTable(new dat.DatReader(langDb.getFileData(t)!)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const loader = { getTextureDataURL: () => null, getTextureDataURLWithAlpha: () => null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    H.ui.layoutRenderer = new LayoutRenderer(langDb as any, loader as any, null);
  }, 120_000);
  afterAll(() => H?.teardown());

  const open = (tab: string): HTMLElement => {
    H.ui.optionsTab = tab;
    if (!H.ui.optionsPanelVisible) H.ui.toggleOptionsPanel();
    else H.ui.renderOptionsPanel();
    return H.ui.optionsPanel as HTMLElement;
  };

  const expectTooltip = (el: HTMLElement | null, token: string, what: string): void => {
    expect(el, what).not.toBeNull();
    const text = helpText(token);
    expect(text, `${token} in 0x23000003`).toBeTruthy();
    expect(el!.dataset.acTooltipText, what).toBe(text);
    expect(el!.dataset.acTooltipTable, what).toBe('23000003');
    expect(Number(el!.dataset.acTooltip), what).toBe(dat.acStringHash(token));
    // p71 of the 0x2100002b list widgets.
    expect(el!.dataset.acTooltipRoot, what).toBe('10000397');
  };

  it('every help token the rows use exists in 0x23000003', () => {
    const tokens = [
      ...CHARACTER_SETTINGS_PAGE.flatMap((s) => s.rows.map((r) => r.helpToken)),
      ...Object.values(CONFIG_HELP_TOKENS), ...Object.values(CONFIG_TOGGLE_HELP_TOKENS),
    ];
    for (const t of tokens) expect(helpText(t), t).toBeTruthy();
  });

  it('Character tab: each checkbox row shows its ID_PlayerOption_*_Help text (SetToggleLabel)', () => {
    const panel = open('character');
    let n = 0;
    for (const section of CHARACTER_SETTINGS_PAGE) {
      for (const row of section.rows) {
        if (!row.ourKey) continue;
        const el = panel.querySelector(`.option-toggle-row[data-option-key="${row.ourKey}"]`) as HTMLElement | null;
        expectTooltip(el, row.helpToken, row.ourKey);
        n++;
      }
    }
    expect(n).toBeGreaterThan(40);
    expect(helpText('ID_PlayerOption_SideBySideVitals_Help')).toMatch(/vital/i);
  });

  it('Config tab: toggles, sliders and menus each carry their AttachPreference help on the widget, not the label', () => {
    const panel = open('config');
    const row = (key: string): HTMLElement => panel.querySelector(`[data-option-key="${key}"]`) as HTMLElement;
    for (const key of ['playSoundsOnlyWhenActive', 'alignCameraToSlope', 'fullScreen', 'syncWithRefreshRate',
      'adaptiveDegrade', 'buildingDetailTextures', 'multiPassAlpha', 'invertMouseLookYAxis', 'useMouseTurning'] as const) {
      expectTooltip(row(key), CONFIG_HELP_TOKENS[key], key);
    }
    for (const key of ['cameraStiffness', 'cameraAdjustmentSpeed', 'fieldOfView', 'screenBrightness',
      'adaptiveDegradeBias', 'degradeDistance', 'mouseLookSensitivity'] as const) {
      const r = row(key);
      expect(r.dataset.optionRow, key).toBe('slider');
      expect(r.dataset.acTooltipText, `${key} row`).toBeUndefined();
      expectTooltip(r.querySelector('[data-slider-label]') as HTMLElement, CONFIG_HELP_TOKENS[key], key);
    }
    for (const key of ['soundFeatures', 'landscapeTextureDetail', 'environmentTextureDetail', 'textureFiltering',
      'landscapeDrawDistance', 'chatFontFace', 'chatFontSize'] as const) {
      expectTooltip(row(key).querySelector('.options-menu-field') as HTMLElement, CONFIG_HELP_TOKENS[key], key);
    }
    // Resolution is a display-only menu with no option key; its field still has the pref's help.
    const menus = [...panel.querySelectorAll('.options-menu-field')] as HTMLElement[];
    expect(menus.some((m) => m.dataset.acTooltipText === helpText(CONFIG_HELP_TOKENS.resolution))).toBe(true);
  });

  it('Config tab Sound rows: the checkbox half shows the Disable*Sound help, the slider the *Volume help', () => {
    const panel = open('config');
    for (const key of ['effectsVolume', 'ambientVolume', 'interfaceVolume'] as const) {
      const r = panel.querySelector(`[data-option-key="${key}"]`) as HTMLElement;
      expect(r.dataset.optionRow).toBe('check-slider');
      expectTooltip(r.querySelector('[data-slider-label]') as HTMLElement, CONFIG_HELP_TOKENS[key], `${key} slider`);
      const toggleTagged = ([...r.children] as HTMLElement[]).filter((c) => c.dataset.acTooltipText === helpText(CONFIG_TOGGLE_HELP_TOKENS[key]));
      // The bullet and its label (the 130x14 checkbox), both hoverable.
      expect(toggleTagged.length, key).toBe(2);
      for (const c of toggleTagged) expect(c.style.pointerEvents).not.toBe('none');
      expect(helpText(CONFIG_TOGGLE_HELP_TOKENS[key])).not.toBe(helpText(CONFIG_HELP_TOKENS[key]));
    }
  });

  // VISUAL.options-rows-help-tooltips.a — the Chat tab (gmChatOptionsUI::InitOptions @ 0049fc60).
  const chatText = (id: number): string | null => dat.getStringFromTable(0x2300000d, id) as string | null;

  it('GameplayOptionList 0x78000000: the opacity sliders\' 0xd4 name / 0xd5 tooltip are the ids the Chat tab uses', () => {
    const entries = gameplayOptionList.get(0xd2).valueArray as Array<{ valueStruct: Map<number, any> | Record<number, any> }>;
    const field = (e: { valueStruct: Map<number, any> | Record<number, any> }, k: number) =>
      e.valueStruct instanceof Map ? e.valueStruct.get(k) : (e.valueStruct as Record<number, any>)[k];
    for (const d of Object.values(CHAT_OPACITY_OPTION_DESCS)) {
      const e = entries.find((x) => field(x, 0xd6)?.valueEnum === d.option);
      expect(e, d.option.toString(16)).toBeDefined();
      expect(field(e!, 0xd4).valueString.stringId).toBe(d.nameId);
      expect(field(e!, 0xd5).valueString.stringId).toBe(d.tooltipId);
      expect(field(e!, 0xd5).valueString.tableId).toBe(0x2300000d);
      expect(chatText(d.tooltipId)).toMatch(/opacity of the chat window/);
    }
  });

  it('Chat tab: each opacity slider shows its gameplay-option 0xd5 tooltip on the slider widget', () => {
    const panel = open('chat');
    for (const [key, d] of Object.entries(CHAT_OPACITY_OPTION_DESCS)) {
      const r = panel.querySelector(`[data-option-key="${key}"]`) as HTMLElement;
      expect(r.dataset.optionRow, key).toBe('slider');
      expect(r.dataset.acTooltipText, `${key} row`).toBeUndefined();
      const track = r.querySelector('[data-slider-label]') as HTMLElement;
      expect(track.dataset.sliderLabel).toBe(chatText(d.nameId));
      expect(track.dataset.acTooltipText, key).toBe(chatText(d.tooltipId));
      expect(track.dataset.acTooltipTable).toBe('2300000d');
      expect(track.dataset.acTooltipRoot).toBe('10000397');
    }
    expect(chatText(CHAT_OPACITY_OPTION_DESCS.chatInactiveOpacity.tooltipId)).toMatch(/inactive/);
  });

  it('Chat tab: every channel checkbox, main window and Chat Window 1-4, shows its ID_ChatOption_TextFilter_*_Desc', () => {
    const panel = open('chat');
    const rows = [...panel.querySelectorAll('.option-toggle-row')] as HTMLElement[];
    // Main window 12 channels + 4 windows × (Gameplay + 12).
    expect(rows.length).toBe(12 + 4 * 13);
    for (const row of rows) {
      const key = row.dataset.optionKey!;
      const suffix = /^chat(?:MainWindow|Window[1-4])(.+)$/.exec(key)![1] as keyof typeof CHAT_FILTER_TOKENS;
      const token = `ID_ChatOption_TextFilter_${CHAT_FILTER_TOKENS[suffix][0]}_Desc`;
      const text = chatText(dat.acStringHash(token));
      expect(text, token).toBeTruthy();
      expect(row.dataset.acTooltipText, key).toBe(text);
      expect(row.dataset.acTooltipTable, key).toBe('2300000d');
      expect(Number(row.dataset.acTooltip), key).toBe(dat.acStringHash(token));
      // p71 of the bitfield item template 0x10000521's 0x10000219 text.
      expect(row.dataset.acTooltipRoot, key).toBe('10000397');
    }
    const combat = panel.querySelector('[data-option-key="chatMainWindowCombat"]') as HTMLElement;
    expect(combat.dataset.acTooltipText).toMatch(/^Filters combat related messages/);
    const errors = panel.querySelector('[data-option-key="chatWindow2Errors"]') as HTMLElement;
    expect(errors.dataset.acTooltipText).toMatch(/top of the screen/);
  });

  it('Chat tab: headers and channel labels are the DAT strings (AddHeader / AddChild tokens)', () => {
    for (const [suffix, [stem, fallback]] of Object.entries(CHAT_FILTER_TOKENS)) {
      expect(chatText(dat.acStringHash(`ID_ChatOption_TextFilter_${stem}`)), suffix).toBe(fallback);
    }
    expect(helpText('ID_ChatOption_MainChatWindow_Section')).toBe('Main Chat Window');
    expect(helpText('ID_ChatOption_FloatyChatWindow3_Section')).toBe('Chat Window 3');
  });
});
