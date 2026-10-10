/**
 * char-skills panel fidelity (VISUAL.48/.49/.50/.51). VISUAL.8 (tabs) and
 * VISUAL.9 (dark stone bg) are inherited from the shared char-panel work
 * (VISUAL.7 / VISUAL.45) since renderCharPanel applies the tab caps + frame to
 * all tabs. The skills tab now reuses the shared header/footer helpers and
 * draws colored section-banner bands.
 *
 * The VISUAL.48/GAP.81 banner-styling assertions drive
 * GameUI.resolveSkillBannerStyle / GameUI.skillValueColor directly, and the
 * render-site assertions drive the real renderSkillsTab in happy-dom
 * (DEBT.test-harness-hygiene: were GameUI.ts source pins).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { GameUI, AC_COLORS } from '../packages/renderer/src/ui/GameUI';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

// Real renderSkillsTab over a hand-built charInfo (no DATs → the banner uses
// the resolveSkillBannerStyle CSS fallback).
let H: GameUIFixture;
beforeAll(async () => { H = await mountGameUI(); }, 60_000);
afterAll(() => H?.teardown());
const SKILLS = [
  { id: 34, name: 'War Magic', status: 'Specialized', effective: 300, base: 250 },
  { id: 6, name: 'Melee Defense', status: 'Trained', effective: 120, base: 120 },
  { id: 29, name: 'Armor Tinkering', status: 'Untrained', effective: 65, base: 65 },
  { id: 44, name: 'Void Magic', status: 'Unusable', effective: 0, base: 0 },
];
function renderSkills(): HTMLElement {
  H.ui.charInfo.skills = SKILLS.map((s) => ({ ...s }));
  const list = H.win.document.createElement('div');
  H.ui.renderSkillsTab(list);
  return list;
}
const norm = (c: string): string => { const el = H.win.document.createElement('span'); el.style.color = c; return el.style.color; };

// VISUAL.49/.50/.51 — the shared header/footer helpers were replaced in
// CORE.6: both tabs now bind name/level/XP + the prompt/credits/unassigned
// footer INTO the panes' inherited DAT chrome (gmStatManagementUI::PostInit
// element ids) via renderStatPaneNative. Header + footer binding, the
// skill-specific prompt, and row hosting are behaviorally covered (real DOM
// execution) in tests/verify-char-panel-native-panes.ts.

describe('VISUAL.48 — colored skill section banners', () => {
  it('section groups render a tinted banner band (direct child of the list) instead of plain text', () => {
    const list = renderSkills();
    const banners = ([...list.children] as HTMLElement[]).filter((c) => c.style.height === '20px' && c.style.marginRight === '20px');
    expect(banners.map((b) => b.textContent)).toEqual(
      ['Specialized Skills', 'Trained Skills', 'Untrained Skills', 'Unusable Skills']);
    expect(banners[0].style.background).toBe(
      (() => { const d = H.win.document.createElement('div'); d.style.background = 'rgb(43,28,72)'; return d.style.background; })());
  });

  it('retail-sampled band colors: Specialized purple, Trained teal, Untrained/Unusable dark neutral', () => {
    expect(GameUI.resolveSkillBannerStyle('Specialized')).toEqual({ background: 'rgb(43,28,72)' });
    expect(GameUI.resolveSkillBannerStyle('Trained')).toEqual({ background: 'rgb(25,52,49)' });
    expect(GameUI.resolveSkillBannerStyle('Untrained')).toEqual({ background: 'rgb(40,34,26)' });
    expect(GameUI.resolveSkillBannerStyle('Unusable')).toEqual({ background: 'rgb(30,28,28)' });
  });

  it('unknown status falls back to a neutral band, not a crash', () => {
    expect(GameUI.resolveSkillBannerStyle('Other')).toEqual({ background: 'rgb(36,30,24)' });
  });

  it('GAP.81: the banner style carries NO border key — native-res re-check of ' +
     'character-panel-skills.jpg found no per-status border stripe, only the band fill', () => {
    const style = GameUI.resolveSkillBannerStyle('Specialized');
    expect(Object.keys(style)).toEqual(['background']);
  });
});

describe('GAP.81 — skill value color is one uniform green, not per-status text tinting', () => {
  it('skillValueColor returns AC_COLORS.skillTrained regardless of caller context', () => {
    expect(GameUI.skillValueColor()).toBe(AC_COLORS.skillTrained);
  });

  it('every rendered skill value (all four groups) uses the shared skillValueColor — no per-status tint', () => {
    const list = renderSkills();
    const want = norm(GameUI.skillValueColor());
    for (const s of SKILLS) {
      const span = ([...list.querySelectorAll('span')] as HTMLElement[]).find((e) => e.textContent === `${s.effective}`);
      expect(span, s.name).toBeTruthy();
      expect(span!.style.color, s.name).toBe(want);
    }
    expect(want).not.toBe(norm(AC_COLORS.textMed));
  });
});
