/**
 * char-skills panel visual-fidelity (burndown 2026-06-10).
 *
 * VISUAL.47 — skill rows had no pictographic icons. Each SkillTable (0x0E000004)
 * entry carries an iconId (20x20 orange pictogram); the row prepends that
 * icon (lazy-loaded via getItemIconURL) left of the skill name, matching retail.
 *
 * CORE.7 — converted from a source-text pin (regex over renderSkillsTab)
 * to a behavioral test: renders the real skills tab in happy-dom and
 * asserts the icon box carries the SkillTable iconId texture.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

describe('char-skills visual fidelity 2026-06-10', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.getTexURL = (id: number): string => `tex:0x${id.toString(16)}`;
    ui.getItemIconURL = (id: number): string => `icon:0x${id.toString(16)}`;
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('VISUAL.47 — skill rows show the DAT skill pictogram from the SkillTable iconId', () => {
    // Healing (21) → iconId 0x06000133 per the SkillTable (panel-spec sweep map).
    ui.skillTable = { skills: new Map([[21, { iconId: 0x06000133 }]]) };
    ui.charInfo.skills = [
      { id: 21, name: 'Healing', status: 'Trained', base: 47, effective: 47, raises: 0 },
    ];
    const list = domWindow.document.createElement('div');
    ui.renderSkillsTab(list);
    // The 20x20 icon slot (row template 0x10000248 child 0x10000129) carries
    // the lazy-loaded pictogram.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const iconBox = Array.from(list.querySelectorAll('div')).find((d: any) =>
      d.style.backgroundImage?.includes('icon:0x6000133')) as HTMLElement;
    expect(iconBox).toBeTruthy();
    expect(iconBox.style.width).toBe('20px');
    expect(iconBox.style.height).toBe('20px');
    ui.skillTable = null;
    ui.charInfo.skills = [];
  });
});
