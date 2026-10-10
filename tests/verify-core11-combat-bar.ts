/**
 * CORE.11 — melee/missile combat bar rebuilt to retail ground truth
 * (LayoutDesc 0x21000007 classic_combat + decompiled gmCombatUI).
 *
 * Decompiled-client ground truth (reference/client-eol, docs/retail-client-symbols.md):
 *   - gmCombatUI::PostInit @ 004cc1a0 binds THREE UIOption_Checkbox rows:
 *     0x10000053 AutoRepeatAttack, 0x10000054 AutoTarget, 0x10000055
 *     ViewCombatTarget ("Keep in View" — was missing entirely pre-CORE.11).
 *     Each checkbox (element class 0x10000035, base 0x1000032b) carries a gem
 *     child 0x10000328 with state art 1=off 0x06004d15 / 6=on 0x06004d17.
 *   - gmCombatUI::PostInit/RecvNotice_SetCombatMode gate m_RecklessnessField
 *     (0x100005ef, the 10–90%% power-band overlay 0x0600715e at (70,0) 567x14)
 *     on Recklessness (skill 0x32): SKILL_ADVANCEMENT_CLASS < 2 hides it
 *     (client enum: 0 undef, 1 untrained, 2 trained, 3 specialized). With
 *     no record the compared slot is never written and the EoR client shows
 *     the band (VISUAL.combat-power-track-full-red).
 *   - The fill 0x2 belongs to the charge meter 0x10000050 (SetPowerbarLevel,
 *     0.0 at rest), not the desired-power slider value.
 *   - Attack-height radio buttons inherit template 0x1000005a; states per
 *     EnumMapper 0x2200002F: 1 normal (0x06004d1c), 3 normal_pressed
 *     (0x06004d1d), 6 highlight — the selection, flanking-arrow art
 *     (0x06004d1e), 8 highlight_pressed (0x06004d1f).
 *   - Body slices 0x1000004c/4d/4e carry 0x06004cc2 — a UNIFORM black
 *     alpha-175 scrim (every pixel 0,0,0,175): retail darkens whatever sits
 *     behind the band. The old opaque screenBg fill under it (a CORE.5
 *     wrong-premise hack) turned the whole band black vs rawg_02's
 *     world-through-scrim look.
 *
 * Also the behavioral home for the FAITHFUL.448 round-trip coverage that
 * previously lived as source-text pins (verify-combat-bar-toggles-roundtrip):
 * combat-bar checkbox clicks must fire onCharacterOptionToggle with the ACE
 * CharacterOption codes 0x00 (AutoRepeatAttacks) / 0x0D (AutoTarget) /
 * 0x07 (KeepCombatTargetsInView).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import {
  parseLayoutDesc,
  parseMasterProperty,
  setMasterPropertyTypes,
  resolveLayoutDesc,
  parseStringTable,
  registerStringTable,
  acStringHash,
  type ElementDesc,
  type LayoutDescData,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { Texture } from '../packages/dat-parser/src/file-types/Texture.js';
import { COMBAT_BAR_HELP_TOKENS } from '../packages/renderer/src/ui/OptionsStrings.js';
import { openDat } from './_harness/dat.js';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

function findElement(map: Map<number, ElementDesc>, id: number): ElementDesc | undefined {
  for (const el of map.values()) {
    if (el.elementId === id) return el;
    const found = findElement(el.children, id);
    if (found) return found;
  }
  return undefined;
}

function stateTexture(el: ElementDesc, stateId: number): number | undefined {
  const st = el.states.get(stateId);
  // media can carry a UI sound first (button state 3 authors press sound
  // 0x2000004b before texture 0x06004d1d) — take the 0x06 texture ref
  const img = st?.media.find(m => m.file !== undefined && (m.file >>> 24) === 0x06);
  return img?.file;
}

describe.skipIf(!hasDats)('CORE.11: DAT ground truth — classic_combat 0x21000007', () => {
  let portalDb: DatDatabase;
  let resolved: LayoutDescData;

  beforeAll(() => {
    portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    const getLayout = (id: number) => {
      const data = langDb.getFileData(id);
      return data ? parseLayoutDesc(langDb.getReader(id)) : null;
    };
    resolved = resolveLayoutDesc(getLayout(0x21000007)!, getLayout);
  });

  it('all three gmCombatUI option checkboxes exist with the gem child 0x10000328 (off 0x06004d15 / on 0x06004d17)', () => {
    for (const id of [0x10000053, 0x10000054, 0x10000055]) {
      const chk = findElement(resolved.elements, id)!;
      expect(chk, `checkbox 0x${id.toString(16)}`).toBeTruthy();
      // element class 0x10000035 = UIOption_Checkbox (gmCombatUI::PostInit
      // DynamicCast target)
      expect(chk.type).toBe(0x10000035);
      const gem = chk.children.get(0x10000328)!;
      expect(gem, `gem of 0x${id.toString(16)}`).toBeTruthy();
      expect(stateTexture(gem, 1)).toBe(0x06004d15);
      expect(stateTexture(gem, 6)).toBe(0x06004d17);
    }
  });

  it('recklessness band 0x100005ef is authored at (70,0) 567x14 with texture 0x0600715e — the 10–90% power window', () => {
    const band = findElement(resolved.elements, 0x100005ef)!;
    expect(band).toBeTruthy();
    expect(band.x).toBe(70);
    expect(band.width).toBe(567);
    expect(band.media.find(m => m.file)?.file).toBe(0x0600715e);
    // 70/707 ≈ 10%, (70+567)/707 ≈ 90% of the 707-wide slider
    expect(70 / 707).toBeCloseTo(0.099, 2);
    expect((70 + 567) / 707).toBeCloseTo(0.901, 2);
  });

  it('attack-height buttons inherit template state art 1/3/6/8 → 0x06004d1c/1d/1e/1f', () => {
    for (const id of [0x10000057, 0x10000058, 0x10000059]) {
      const btn = findElement(resolved.elements, id)!;
      expect(stateTexture(btn, 1), 'normal').toBe(0x06004d1c);
      expect(stateTexture(btn, 3), 'normal_pressed').toBe(0x06004d1d);
      expect(stateTexture(btn, 6), 'highlight (selected)').toBe(0x06004d1e);
      expect(stateTexture(btn, 8), 'highlight_pressed').toBe(0x06004d1f);
    }
  });

  it('body texture 0x06004cc2 is a uniform black alpha-175 scrim — no opaque backing belongs under it', () => {
    const tex = Texture.read(portalDb.getReader(0x06004cc2));
    const rgba = tex.toRGBA();
    for (let i = 0; i < rgba.data.length; i += 4) {
      expect(rgba.data[i]).toBe(0);
      expect(rgba.data[i + 1]).toBe(0);
      expect(rgba.data[i + 2]).toBe(0);
      expect(rgba.data[i + 3]).toBe(175);
    }
  });

  it('"Target In View" label string 9706964 is authored on 0x10000055 (p23)', () => {
    const chk = findElement(resolved.elements, 0x10000055)!;
    const p23 = chk.properties.get(23);
    expect(p23).toBeTruthy();
  });
});

// ── Behavioral: renderCombatBar (happy-dom + DATs) ───────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe.skipIf(!hasDats)('CORE.11: renderCombatBar (behavioral, requires happy-dom + DATs)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let CombatModeEnum: any;
  const optionToggles: Array<{ code: number; value: boolean }> = [];

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);
    setMasterPropertyTypes(parseMasterProperty(portalDb.getReader(0x39000001)));
    // Same tables main.ts registers — the button High/Medium/Low labels are
    // DAT p23 strings auto-rendered by LayoutRenderer.
    for (const stringTableId of [0x23000001, 0x23000002, 0x23000003, 0x23000005, 0x2300000d]) {
      registerStringTable(parseStringTable(langDb.getReader(stringTableId)));
    }

    const { TextureManager } = await import('../packages/renderer/src/models/TextureManager.js');
    const { UITextureLoader } = await import('../packages/renderer/src/ui/UITextureLoader.js');
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const { GameUI } = await import('../packages/renderer/src/ui/GameUI.js');
    const { CombatMode } = await import('../packages/shared/src/index.js');
    CombatModeEnum = CombatMode;

    // TextureManager backs the LayoutRenderer only: happy-dom has no 2D
    // canvas context, so GameUI must not get a textureManager of its own.
    const texMgr = new TextureManager(portalDb);
    const layoutRenderer = new LayoutRenderer(langDb, new UITextureLoader(texMgr));
    layoutRenderer.getTextureDataURLWithAlpha = () => null;

    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new GameUI(container, {
      onCharacterOptionToggle: (code: number, value: boolean) => optionToggles.push({ code, value }),
    }, portalDb, undefined, undefined, undefined, null, layoutRenderer);
    ui.showGame();
    ui.hudState.combatMode = CombatMode.Melee;
    ui.renderCombatBar();
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function checkbox(key: string): HTMLElement {
    const el = ui.combatBar.querySelector(`[data-option-key="${key}"]`) as HTMLElement;
    expect(el, key).toBeTruthy();
    return el;
  }

  it('VISUAL.combat-bar-keep-in-view-label — labels are the options-table ID_CombatPanelOption_* strings gmCombatUI::PostInit sets, not the p23 text', () => {
    const labelText = (key: string): string | undefined =>
      (checkbox(key).querySelector('[data-ac-run-text]') as HTMLElement | null)?.dataset.acRunText;
    expect(labelText('repeatAttacks')).toBe('Repeat Attacks');
    expect(labelText('autoTarget')).toBe('Auto Target');
    // 0x10000055's authored p23 is 0x23000001 "Target In View"; the real EoR
    // client (verification/retail-client/ab/retail-combat-melee.png) reads
    // 0x23000003[hash("ID_CombatPanelOption_ViewCombatTarget")].
    expect(labelText('keepCombatTargetsInView')).toBe('Keep in View');
    expect(ui.combatBar.textContent).not.toContain('Target In View');
  });

  it('VISUAL.combat-bar-checkbox-tooltips — each checkbox carries its 0x23000003 ID_PlayerOption_*_Help text on the HUD tooltip machine (gmCombatUI::PostInit SetTooltip)', () => {
    const cases: Array<[string, string]> = [
      ['repeatAttacks', 'When in melee or missile combat modes, this option will automatically begin another attack when your previous attack finishes.'],
      ['autoTarget', 'When this option is enabled, in combat you will automatically target the next closest enemy once your current enemy dies.'],
      ['keepCombatTargetsInView', 'When enabled the camera will rotate to face the currently selected target when you are in combat.'],
    ];
    for (const [key, text] of cases) {
      const el = checkbox(key);
      expect(el.dataset.acTooltipText, key).toBe(text);
      // String id + table are the SetTooltip override, the root is the base
      // checkbox desc's p71 (0x21000044:0x1000032b, p75 on).
      expect(el.dataset.acTooltipTable, key).toBe('23000003');
      expect(Number(el.dataset.acTooltip), key).toBe(acStringHash(COMBAT_BAR_HELP_TOKENS[key as keyof typeof COMBAT_BAR_HELP_TOKENS]));
      expect(el.dataset.acTooltipRoot, key).toMatch(/^1000039[5-8]$|^10000487$/);
    }
    expect(acStringHash('ID_PlayerOption_AutoRepeatAttack_Help')).toBe(93502288);
    expect(acStringHash('ID_PlayerOption_AutoTarget_Help')).toBe(162025280);
    expect(acStringHash('ID_PlayerOption_ViewCombatTarget_Help')).toBe(117471984);
  });

  it('renders all three option checkboxes, including "Keep in View" (ViewCombatTarget)', () => {
    checkbox('repeatAttacks');
    checkbox('autoTarget');
    const tiv = checkbox('keepCombatTargetsInView');
    // gem child present (DAT base-inheritance)
    expect(tiv.querySelector('[data-element-id="0x10000328"]')).toBeTruthy();
    // exactly one label (LayoutRenderer's auto p23 text replaced, not stacked)
    expect(tiv.querySelectorAll(':scope > .layout-text').length).toBe(1);
  });

  it('FAITHFUL.448 — checkbox clicks round-trip the ACE CharacterOption codes and flip the gem state', () => {
    const cases: Array<[string, number]> = [
      ['repeatAttacks', 0x00],
      ['autoTarget', 0x0D],
      ['keepCombatTargetsInView', 0x07],
    ];
    for (const [key, code] of cases) {
      const el = checkbox(key);
      const before = ui.optionsSettings[key];
      optionToggles.length = 0;
      el.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
      expect(ui.optionsSettings[key], key).toBe(!before);
      expect(el.dataset.optionOn).toBe(!before ? '1' : '0');
      expect(optionToggles).toEqual([{ code, value: !before }]);
      // FAITHFUL.432 — the toggle persists through saveOptionsSettings
      const stored = JSON.parse(domWindow.localStorage.getItem('ac_options_settings_v1') ?? '{}');
      expect(stored[key], `${key} persisted`).toBe(!before);
    }
  });

  function band(): HTMLElement {
    const el = ui.combatBar.querySelector('[data-element-id="0x100005ef"]') as HTMLElement;
    expect(el).toBeTruthy();
    return el;
  }

  it('VISUAL.combat-power-track-full-red — with no Recklessness record the band shows (the EoR frame for a no-skills character)', () => {
    expect(ui.charInfo.skills.find((sk: { id: number }) => sk.id === 50)).toBeUndefined();
    expect(band().style.display).not.toBe('none');
  });

  it('recklessness band hidden while the Recklessness record is below Trained (SAC 1)', () => {
    ui.charInfo.skills.push({ id: 50, name: 'Recklessness', status: 'Untrained', base: 0, effective: 0, raises: 0, sac: 1 });
    ui.renderCombatBar();
    expect(band().style.display).toBe('none');
    ui.charInfo.skills.pop();
    ui.renderCombatBar();
  });

  it('recklessness band shown once Recklessness is Trained (SAC 2) or Specialized (SAC 3)', () => {
    for (const sac of [2, 3]) {
      ui.charInfo.skills.push({ id: 50, name: 'Recklessness', status: 'Trained', base: 0, effective: 0, raises: 0, sac });
      ui.renderCombatBar();
      expect(band().style.display, `sac ${sac}`).not.toBe('none');
      ui.charInfo.skills.pop();
    }
    ui.renderCombatBar();
  });

  it('VISUAL.combat-power-track-full-red — the fill is the charge meter: empty at rest whatever the desired power', () => {
    const fill = ui.combatBar.querySelector('[data-element-id="0x2"]') as HTMLElement;
    expect(fill).toBeTruthy();
    expect(ui.getCombatPowerLevel()).toBeGreaterThan(0);
    expect(fill.style.width).toBe('0px');
    ui.adjustCombatPowerLevel(0.25);
    const fillAfter = ui.combatBar.querySelector('[data-element-id="0x2"]') as HTMLElement;
    expect(fillAfter.style.width).toBe('0px');
    ui.adjustCombatPowerLevel(-0.25);
  });

  it('an attack-height key or a power nudge in combat repaints the combat bar only: the chat log and the rest of the HUD survive (the whole-HUD renderHUD wiped the chat on every Low/Medium/High Attack press)', () => {
    ui.addSystemMessage('You say, "hello there"');
    const log = ui.chatMessages as HTMLElement;
    const before = log.children.length;
    expect(before).toBeGreaterThan(0);
    ui.setCombatAttackHeight('high');
    ui.adjustCombatPowerLevel(0.1);
    ui.adjustCombatPowerLevel(-0.1);
    expect(ui.chatMessages).toBe(log);
    expect(log.isConnected).toBe(true);
    expect(log.children.length).toBe(before);
    expect(log.textContent + [...log.querySelectorAll('[data-ac-run-text]')].map((e) => (e as HTMLElement).dataset.acRunText).join('')).toContain('hello there');
    // the bar still shows the new height (its state carrier repainted)
    expect(ui.getCombatAttackHeight()).toBe('high');
    expect(ui.combatBar.isConnected).toBe(true);
    ui.setCombatAttackHeight('medium');
  });

  it('setCombatPowerBarLevel drives the fill across the reflowed 507-px track and clamps; 0 empties it', () => {
    const fill = () => ui.combatBar.querySelector('[data-element-id="0x2"]') as HTMLElement;
    ui.setCombatPowerBarLevel(0.5);
    expect(fill().style.width).toBe(`${Math.round(0.5 * 507)}px`);
    ui.renderCombatBar();
    expect(fill().style.width).toBe(`${Math.round(0.5 * 507)}px`);
    ui.setCombatPowerBarLevel(2);
    expect(fill().style.width).toBe('507px');
    ui.setCombatPowerBarLevel(0);
    expect(fill().style.width).toBe('0px');
  });

  it('VISUAL.combat-power-label-position — Power is right-justified at the track end in melee state 0x10000003; Accuracy in missile 0x10000004', () => {
    const label = () => ui.combatBar.querySelector('[data-element-id="0x10000052"]') as HTMLElement;
    const textOf = (el: HTMLElement) => el.querySelector(':scope > .layout-text') as HTMLElement;
    // DAT edges left 2 / right 1: the 100-px box follows the right edge of the
    // 600-px reflowed page (611 → 411), ending 4 px short of the 507-px
    // track's end at 8 + 507.
    expect(label().style.left).toBe('411px');
    expect(label().style.width).toBe('100px');
    expect(textOf(label()).style.justifyContent).toBe('flex-end');
    expect(textOf(label()).dataset.acState).toBe((0x10000003).toString(16));
    // Speed's own desc carries p20=2 (near edge) and stays left-justified.
    const speed = ui.combatBar.querySelector('[data-element-id="0x10000051"]') as HTMLElement;
    expect(textOf(speed).style.justifyContent).toBe('flex-start');

    ui.hudState.combatMode = CombatModeEnum.Missile;
    ui.renderCombatBar();
    expect(textOf(label()).dataset.acState).toBe((0x10000004).toString(16));
    expect(textOf(label()).style.justifyContent).toBe('flex-end');
    ui.hudState.combatMode = CombatModeEnum.Melee;
    ui.renderCombatBar();
    expect(textOf(label()).style.justifyContent).toBe('flex-end');
  });

  it('slider thumb sits above the fill subtree (explicit z-index) at the power-level position', () => {
    const thumb = ui.combatBar.querySelector('[data-element-id="0x1"]') as HTMLElement;
    expect(thumb.style.zIndex).toBe('2');
    // BUG.spellbar-classic-clip — the track is reflowed into the EoL combat
    // window's 600-px body (707 → 507 px); the 12-px thumb travels its width
    // minus its own.
    const track = ui.combatBar.querySelector('[data-element-id="0x1000004f"]') as HTMLElement;
    const trackW = parseInt(track.style.width, 10);
    expect(trackW).toBe(507);
    expect(thumb.style.left).toBe(`${Math.round(ui.getCombatPowerLevel() * (trackW - 12))}px`);
  });

  it('body slices carry NO opaque background fill (the DAT scrim composites over the world)', () => {
    for (const id of ['0x1000004c', '0x1000004d', '0x1000004e']) {
      const el = ui.combatBar.querySelector(`[data-element-id="${id}"]`) as HTMLElement;
      expect(el, id).toBeTruthy();
      expect(el.style.backgroundColor).toBe('');
    }
  });

  it('attack-height click selects the height and persists it (FAITHFUL.449)', () => {
    const low = ui.combatBar.querySelector('[data-element-id="0x10000059"]') as HTMLElement;
    low.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(ui.getCombatAttackHeight()).toBe('low');
    expect(ui.optionsSettings.combatAttackHeight).toBe('low');
  });

  it('BUG.combat-attack-charge-build — button press starts the attack request, its click ends it (gmCombatUI 0x1c / 1)', () => {
    const events: string[] = [];
    ui.callbacks.onCombatAttackPress = (h: string) => events.push(`press:${h}`);
    ui.callbacks.onCombatAttackRelease = (h: string) => events.push(`release:${h}`);
    ui.renderCombatBar();
    const high = ui.combatBar.querySelector('[data-element-id="0x10000057"]') as HTMLElement;
    high.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, button: 0 }));
    high.dispatchEvent(new domWindow.MouseEvent('mousedown', { bubbles: true, button: 2 }));
    high.dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(events).toEqual(['press:high', 'release:high']);
    delete ui.callbacks.onCombatAttackPress;
    delete ui.callbacks.onCombatAttackRelease;
  });

  it('buttons carry a single DAT-string label (no stacked hand-built text)', () => {
    for (const id of ['0x10000057', '0x10000058', '0x10000059']) {
      const el = ui.combatBar.querySelector(`[data-element-id="${id}"]`) as HTMLElement;
      expect(el.querySelectorAll('.layout-text').length, id).toBe(1);
    }
  });
});

describe('VISUAL.combat-power-label-position: textLayoutPropsOf (state justification overlay)', () => {
  it('a state desc\'s p20/p21/p35-38 override the element desc; other props stay the element\'s', async () => {
    const { textLayoutPropsOf } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const prop = (id: number, valueEnum: number): any => ({ id, propertyType: 9, valueEnum });
    const element = new Map([[20, prop(20, 1)], [21, prop(21, 1)], [26, prop(26, 7)]]);
    const state = new Map([[20, prop(20, 3)], [23, prop(23, 9)]]);
    const merged = textLayoutPropsOf(element, state)!;
    expect(merged.get(20)).toEqual(prop(20, 3));
    expect(merged.get(21)).toEqual(prop(21, 1));
    expect(merged.get(26)).toEqual(prop(26, 7));
    expect(merged.has(23)).toBe(false);
    // the element desc itself is not mutated
    expect(element.get(20)).toEqual(prop(20, 1));
    // no state props → the element's own map
    expect(textLayoutPropsOf(element, undefined)).toBe(element);
    expect(textLayoutPropsOf(undefined, state)!.get(20)).toEqual(prop(20, 3));
  });
});
