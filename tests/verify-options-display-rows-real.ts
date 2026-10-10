/**
 * FAITHFUL.437 — Display tab no longer shows fake settings.
 *
 * Pre-fix three rows existed that pretended to be settings but did
 * nothing:
 *   - Render Distance — value stored, never consumed by rendering code
 *   - Texture Quality — hardcoded display string 'High', no toggle
 *   - Shadows — hardcoded display string 'On', no toggle
 *
 *  Cleaner to remove than to leave UI deception in place. Only the
 *  toggles that ACTUALLY do something stay (showHelm / showCloak /
 *  disableWeather — all wired to render-state).
 *
 * VISUAL.22 moved the visual toggles from the (removed) 'display' tab into
 * the real DAT tabs, so every tab is checked.
 *
 * DEBT.test-harness-hygiene: converted from a GameUI.ts source pin — the real
 * renderOptionsPanel renders all four tabs against a layout-handle double.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mountGameUI, stubLayoutRender, type GameUIFixture } from './_harness/gameui.js';

const OPT_IDS = [
  0x10000208, 0x10000210, 0x10000211, 0x10000212, 0x10000213, 0x10000216, 0x10000217,
  0x10000218, 0x1000021a, 0x1000021d, 0x10000220, 0x10000221, 0x10000222, 0x1000050c,
  0x10000520, 0x10000521, 0x1000020d, 0x1000020e, 0x1000050b, 0x1000020f,
];
const TABS = ['gameplay', 'character', 'chat', 'config'] as const;

describe('FAITHFUL.437 — options rows are real settings only (behavioural)', () => {
  let H: GameUIFixture;
  const texts: string[] = [];
  const keys = new Set<string>();
  beforeAll(async () => {
    H = await mountGameUI();
    const doc = H.win.document;
    H.ui.layoutRenderer = {
      renderPanel: (_layoutId: number, parent: HTMLElement) => {
        const root = doc.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of OPT_IDS) {
          const el = doc.createElement('div');
          root.appendChild(el);
          elements.set(id, el);
        }
        return {
          root, elements,
          setState: () => {}, setText: () => {}, setInteractive: () => {}, setVisible: () => {},
          setTexture: () => {}, onClick: () => {}, close: () => { root.remove(); },
        };
      },
      render: stubLayoutRender(H.win.document),
    };
    for (const tab of TABS) {
      H.ui.optionsTab = tab;
      if (!H.ui.optionsPanelVisible) H.ui.toggleOptionsPanel();
      else H.ui.renderOptionsPanel();
      const panel = H.ui.optionsPanel as HTMLElement;
      texts.push(panel.textContent ?? '');
      for (const row of panel.querySelectorAll('.option-toggle-row')) keys.add((row as HTMLElement).dataset.optionKey!);
    }
  });
  afterAll(() => H.teardown());

  it('every tab renders a panel', () => {
    expect(texts.length).toBe(4);
    expect(texts.every(t => t.length > 0)).toBe(true);
    // Row labels render as text here (no DAT font) — so the absence checks below bite.
    expect(texts.join('\n')).toContain('Show Your Helm or Head Gear');
  });

  it.each(['Render Distance', 'Texture Quality', 'Shadows'])('no tab renders a fake "%s" row', (label) => {
    for (const t of texts) expect(t).not.toContain(label);
  });

  it('the real wired toggle rows are preserved (Show Helm / Show Cloak / Disable Weather)', () => {
    // BUG.character-tab-not-retail — retail's own row is Vivid Targeting
    // Indicator (0x0E), keyed vividTargetingIndicator; the invented
    // "vivifyColors" key stays gone.
    for (const key of ['showHelm', 'showCloak', 'disableWeather', 'vividTargetingIndicator']) expect(keys.has(key)).toBe(true);
    expect(keys.has('vivifyColors')).toBe(false);
  });

  it('renderDistance is not an optionsSettings default', () => {
    expect('renderDistance' in H.mod.GameUI.OPTIONS_DEFAULTS).toBe(false);
    expect('renderDistance' in H.ui.optionsSettings).toBe(false);
  });
});
