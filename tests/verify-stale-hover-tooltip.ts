/**
 * BUG.stale-hover-tooltip — a HUD tooltip outlived its element: hover an
 * inventory item or a character-panel row until its tooltip shows, then close
 * (or swap) the panel by its key without moving the mouse, and the tooltip
 * stayed over whatever replaced it.
 *
 * Retail (the decompiled EoL client): UIElement::OnVisibilityChanged @
 * 00463700 sets UIElementManager::m_bPerformMouseHitTest when an element shown
 * or hidden covers the mouse, UIElementManager::DeletingElement @ 0045e520
 * SwitchMouseOver(null)s a deleted element under the mouse, and the next
 * UseTime's DoMouseUpdate @ 0045cc60 re-hit-tests at the mouse and
 * SwitchMouseOver's the result with no mouse-move stamp: the old tooltip goes
 * (StopHover) and the element now under the mouse is entered, its own tooltip
 * following once the delay since the last real move has run.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { hudMutationsMayMoveMouseOver, DEFAULT_TOOLTIP_DURATION_SECONDS } from '../packages/renderer/src/ui/DatTooltip.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'HTMLCanvasElement', 'Node', 'Event', 'MouseEvent', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 15));

describe('hudMutationsMayMoveMouseOver — which DOM changes can move what is under a still mouse', () => {
  const saved: Record<string, unknown> = {};
  beforeAll(() => { installDomGlobals(domWindow, DOM_GLOBALS, saved); });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });

  const doc = (): Document => domWindow.document as Document;
  const styleRecord = (el: HTMLElement, oldValue: string) => ({
    type: 'attributes' as const, target: el, attributeName: 'style', oldValue,
    addedNodes: [] as unknown as NodeList, removedNodes: [] as unknown as NodeList,
  });

  it('a display / visibility / z-index / placement change counts; colour, background and size changes do not', () => {
    const el = doc().createElement('div');
    el.setAttribute('style', 'position:absolute;left:10px;top:10px;display:none;');
    expect(hudMutationsMayMoveMouseOver([styleRecord(el, 'position:absolute;left:10px;top:10px;display:block;')])).toBe(true);
    el.setAttribute('style', 'left:10px;top:10px;color:red;background-image:url(b);width:50px;');
    expect(hudMutationsMayMoveMouseOver([styleRecord(el, 'left:10px;top:10px;color:blue;background-image:url(a);width:40px;')])).toBe(false);
    el.setAttribute('style', 'left:12px;top:10px;');
    expect(hudMutationsMayMoveMouseOver([styleRecord(el, 'left:10px;top:10px;')])).toBe(true);
    el.setAttribute('style', 'visibility:hidden;');
    expect(hudMutationsMayMoveMouseOver([styleRecord(el, '')])).toBe(true);
    el.setAttribute('style', 'z-index:5;');
    expect(hudMutationsMayMoveMouseOver([styleRecord(el, 'z-index:4;')])).toBe(true);
  });

  it('a class or hidden change counts; an element added or removed counts, a text node or a tooltip box does not', () => {
    const el = doc().createElement('div');
    const none = [] as unknown as NodeList;
    expect(hudMutationsMayMoveMouseOver([{ type: 'attributes', target: el, attributeName: 'class', oldValue: 'a', addedNodes: none, removedNodes: none }])).toBe(true);
    expect(hudMutationsMayMoveMouseOver([{ type: 'attributes', target: el, attributeName: 'hidden', oldValue: null, addedNodes: none, removedNodes: none }])).toBe(true);
    const child = doc().createElement('div');
    expect(hudMutationsMayMoveMouseOver([{ type: 'childList', target: el, attributeName: null, oldValue: null, addedNodes: [child] as unknown as NodeList, removedNodes: none }])).toBe(true);
    expect(hudMutationsMayMoveMouseOver([{ type: 'childList', target: el, attributeName: null, oldValue: null, addedNodes: none, removedNodes: [child] as unknown as NodeList }])).toBe(true);
    const text = doc().createTextNode('42');
    expect(hudMutationsMayMoveMouseOver([{ type: 'childList', target: el, attributeName: null, oldValue: null, addedNodes: [text] as unknown as NodeList, removedNodes: none }])).toBe(false);
    const tip = doc().createElement('div'); tip.className = 'ac-dat-tooltip';
    expect(hudMutationsMayMoveMouseOver([{ type: 'childList', target: doc().body, attributeName: null, oldValue: null, addedNodes: [tip] as unknown as NodeList, removedNodes: [tip] as unknown as NodeList }])).toBe(false);
  });
});

describe('GameUI — a tooltip goes with its element (DoMouseUpdate after a visibility change)', () => {
  const saved: Record<string, unknown> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any; let now = 1000;
  let under: Element | null = null;
  let hitTests = 0;
  const tip = (): HTMLElement | null => domWindow.document.querySelector('.ac-dat-tooltip');
  const move = (target: HTMLElement, x: number, y: number): void => {
    under = target;
    target.dispatchEvent(new domWindow.MouseEvent('mousemove', { bubbles: true, clientX: x, clientY: y }));
  };
  /** A panel (the inventory / character panel stand-in) holding one tooltip-carrying row. */
  const panel = (text: string | null): { panel: HTMLElement; row: HTMLElement } => {
    const p = domWindow.document.createElement('div') as HTMLElement;
    p.setAttribute('style', 'position:absolute;left:100px;top:100px;width:300px;height:300px;');
    const row = domWindow.document.createElement('div') as HTMLElement;
    p.appendChild(row);
    domWindow.document.body.appendChild(p);
    if (text) ui.tagHudTooltip(row, text);
    return { panel: p, row };
  };
  const hoverUntilShown = (row: HTMLElement): void => {
    move(row, 200, 200);
    now += 0.3; ui.checkHudTooltip();
  };

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const g = globalThis as Record<string, unknown>;
    if (typeof g.requestAnimationFrame !== 'function') { g.requestAnimationFrame = () => 0; g.cancelAnimationFrame = () => {}; }
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.hudTooltipNow = () => now;
    // The DOM shim has no layout: the hit test answers with whatever the test put under the mouse.
    ui.hudHitTest = () => { hitTests++; return under; };
  });
  afterAll(() => { restoreDomGlobals(DOM_GLOBALS, saved); });
  beforeEach(async () => {
    const plain = domWindow.document.createElement('div') as HTMLElement;
    domWindow.document.body.appendChild(plain);
    move(plain, 0, 0);
    await settle();
    expect(tip()).toBeNull();
  });

  it('closing the panel by its key (display:none) under a still mouse deletes its row\'s tooltip', async () => {
    const inv = panel('Wand (wielded)');
    hoverUntilShown(inv.row);
    expect(tip()?.dataset.acText).toBe('Wand (wielded)');
    const world = domWindow.document.createElement('div') as HTMLElement;
    domWindow.document.body.appendChild(world);
    await settle();
    under = world;                       // the panel is gone: the 3D view is under the mouse now
    inv.panel.style.display = 'none';
    await settle();
    expect(tip()).toBeNull();
    now += DEFAULT_TOOLTIP_DURATION_SECONDS + 5; ui.checkHudTooltip();
    expect(tip()).toBeNull();
    // Reopened under the same still mouse: retail's DoMouseUpdate re-enters the row with no
    // move stamp, so its tooltip is back once the delay since the last real move has run.
    under = inv.row;
    inv.panel.style.display = '';
    await settle();
    ui.checkHudTooltip();
    expect(tip()?.dataset.acText).toBe('Wand (wielded)');
  });

  it('swapping to another panel in the same place shows the new element\'s tooltip, not the old one', async () => {
    const chr = panel('Measures how healthy your character is.');
    hoverUntilShown(chr.row);
    expect(tip()?.dataset.acText).toBe('Measures how healthy your character is.');
    const social = panel('Friends');
    social.panel.style.display = 'none';
    await settle();
    expect(tip()?.dataset.acText).toBe('Measures how healthy your character is.');
    under = social.row;
    chr.panel.style.display = 'none';
    social.panel.style.display = '';
    await settle();
    expect(tip()?.dataset.acText).not.toBe('Measures how healthy your character is.');
    ui.checkHudTooltip();
    expect(tip()?.dataset.acText).toBe('Friends');
  });

  it('a row removed from the tree (a panel rebuilt) takes its tooltip with it', async () => {
    const inv = panel('Pyreal');
    hoverUntilShown(inv.row);
    expect(tip()?.dataset.acText).toBe('Pyreal');
    under = inv.panel;
    inv.row.remove();
    await settle();
    expect(tip()).toBeNull();
  });

  it('paint-only changes under the mouse never re-hit-test; a mouse outside the window is not watched', async () => {
    const inv = panel('Health Potion');
    hoverUntilShown(inv.row);
    const before = hitTests;
    inv.row.style.backgroundImage = 'url(hover.png)';
    inv.panel.style.color = 'red';
    await settle();
    expect(hitTests).toBe(before);
    expect(tip()?.dataset.acText).toBe('Health Potion');
    // The mouse left the window: nothing is watched, so even a hide costs no hit test.
    domWindow.document.documentElement.dispatchEvent(new domWindow.MouseEvent('mouseleave'));
    expect(tip()).toBeNull();
    await settle();
    const idle = hitTests;
    inv.panel.style.display = 'none';
    await settle();
    expect(hitTests).toBe(idle);
  });
});
