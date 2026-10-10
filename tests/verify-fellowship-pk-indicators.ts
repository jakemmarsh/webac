/**
 * FAITHFUL.256 — Live fellowship + PK HUD indicators.
 *
 * Following FAITHFUL.255's setIndicatorActive helper, wire two more indicators:
 *   - 'fellowship' (texActive 0x06001932 / texInactive 0x06001933) — active
 *     when GameUI.setFellowshipData is called with a non-null payload.
 *   - 'pk-status' (texActive 0x06002817 / texInactive 0x06004ce9) — active
 *     when the PlayerKillerStatus value has the PK (0x04) or PKLite (0x40)
 *     bit set, per ACE Source/ACE.Entity/Enum/PlayerKillerStatus.cs.
 *
 * Both setter functions (setFellowshipData / setPKStatus) already exist; this
 * task just adds the setIndicatorActive call inside each.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PlayerKillerStatus } from '@ac/shared';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

/** Minimal LayoutRenderer stub: every element id the panel code asks for
 *  resolves to a real div, so the real GameUI render paths run to completion. */
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
      if (!el) { el = doc.createElement('div'); root.appendChild(el!); elements.set(id, el!); }
      return el;
    };
    const noop = () => {};
    return {
      root, layout: { elements: [] }, elements, descs: new Map(),
      setText: noop, setFill: noop, setVisible: noop, setState: noop, setPalette: noop, setInteractive: noop,
      setScrollable: () => ({ contentEl: doc.createElement('div'), setPosition: noop, scrollToBottom: noop, appendContent: noop }),
      setDraggable: noop, setDropTarget: noop, setTexture: noop, onClick: noop,
      destroy: () => root.remove(), moveTo: noop, close: () => root.remove(), bringToFront: noop,
    };
  };
  const lr = {
    render: (_id: number, parent: HTMLElement) => makeHandle(parent),
    renderPanel: (_id: number, parent: HTMLElement) => makeHandle(parent),
    getTextureDataURLWithAlpha: () => null,
  };
  H.ui.layoutRenderer = lr;
  return lr;
}

// DEBT.test-harness-hygiene: behavioural — the real renderHUD() builds the
// indicator strip against a stub LayoutRenderer, and the real setters are
// driven with a setIndicatorActive spy (were GameUI.ts source pins).
describe('FAITHFUL.256 → CORE.5.b — no fellowship / pk-status strip indicators', () => {
  let H: GameUIFixture;
  const calls: string[] = [];
  beforeAll(async () => {
    H = await mountGameUI();
    stubLayoutRenderer(H);
    H.ui.renderHUD();
    const orig = H.ui.setIndicatorActive.bind(H.ui);
    H.ui.setIndicatorActive = (id: string, active: boolean) => { calls.push(id); orig(id, active); };
  }, 60_000);
  afterAll(() => H?.teardown());

  it('PlayerKillerStatus enum values match ACE source', () => {
    expect(PlayerKillerStatus.PK).toBe(0x04);
    expect(PlayerKillerStatus.PKLite).toBe(0x40);
  });

  it('the built strip registers real indicators but no fellowship or pk-status def', () => {
    const ids = [...H.ui.indicatorTexById.keys()];
    expect(ids).toContain('minigame'); // sanity: the strip was built
    expect(ids).not.toContain('fellowship');
    expect(ids).not.toContain('pk-status');
    expect(H.win.document.getElementById('hud-indicator-fellowship')).toBeNull();
    expect(H.win.document.getElementById('hud-indicator-pk-status')).toBeNull();
  });

  it('CORE.5.b — setFellowshipData no longer drives a fellowship indicator (strip element 0x100000fa is the logout X, per gmIndicatorsUI::ListenToElementMessage @ 004bfa90)', () => {
    calls.length = 0;
    H.ui.setFellowshipData({
      fellowshipName: 'F', leaderGuid: 1, shareXP: true, evenShare: true, open: true, isLocked: false,
      fellows: [{ guid: 1, name: 'A', level: 1, healthCurrent: 1, healthMax: 1, staminaCurrent: 1, staminaMax: 1, manaCurrent: 1, manaMax: 1, shareLoot: false }],
    });
    H.ui.setFellowshipData(null);
    expect(calls).not.toContain('fellowship');
  });

  it('CORE.5.b — setPKStatus no longer drives a pk-status indicator (strip element 0x100000f3 is gmUIElement_MiniGameIndicator)', () => {
    calls.length = 0;
    for (const v of [PlayerKillerStatus.PK, PlayerKillerStatus.PKLite, PlayerKillerStatus.NPK]) H.ui.setPKStatus(v);
    expect(calls).not.toContain('pk-status');
  });
});
