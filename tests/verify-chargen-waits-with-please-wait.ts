/**
 * Create Character while the streamed world packs are still loading.
 *
 * Chargen draws the world packs' heritage / clothing art, so with streamed
 * DATs showCharacterCreate waits for them (RELEASE.streaming-charselect-weight).
 * On a cold first visit to playwebac.com they landed 55-154 s after char
 * select (2026-10-08), and the click showed nothing for that long: a new
 * player saw a dead button. It now raises retail's Please Wait box
 * (MakePleaseWaitDialog @ 004eced0, string 7426468) until chargen opens.
 *
 * UX.chargen-click-during-texture-load (AC1999 local, 2026-10-11): retail
 * opened chargen on the click (QueueUIMode @ 0x004ed721; 1999
 * IntroUI_EnterChargen @ 0x00504da0), so ours never loses it: the queued open
 * keeps its Please Wait through char-select redraws, opens once, and is
 * dropped when the player moves on. A press split by a redraw still counts.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1568, innerHeight: 775 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;

describe('Create Character before the world art is resident', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mod: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    mod = await import('../packages/renderer/src/ui/GameUI.js');
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  it('shows Please Wait at once, opens chargen and drops the box when the art lands; a second click raises no second box', async () => {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    let land!: () => void;
    const worldArtReady = new Promise<void>((r) => { land = r; });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = new mod.GameUI(container, {}, undefined, undefined, undefined, undefined, null, null, { worldArtReady });

    ui.showCharacterCreate();
    ui.showCharacterCreate();
    const boxes = domWindow.document.querySelectorAll(`#${mod.CHARGEN_WORLD_ART_WAIT_ID}`);
    expect(boxes.length).toBe(1);
    expect(ui.uiManager.currentScreen).not.toBe('character-create');

    land();
    await worldArtReady;
    await new Promise((r) => setTimeout(r, 0));
    expect(domWindow.document.getElementById(mod.CHARGEN_WORLD_ART_WAIT_ID)).toBeNull();
    expect(ui.uiManager.currentScreen).toBe('character-create');
  });

  it('whole DATs (no pending world art): chargen opens directly, no box', () => {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ui: any = new mod.GameUI(container);
    ui.showCharacterCreate();
    expect(domWindow.document.getElementById(mod.CHARGEN_WORLD_ART_WAIT_ID)).toBeNull();
    expect(ui.uiManager.currentScreen).toBe('character-create');
  });

  // ── UX.chargen-click-during-texture-load ──
  const SLOTS = [{ id: '1342177281', name: 'Alpha' }, { id: '1342177282', name: 'Beta' }];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function selectScreen(streaming?: { worldArtReady: Promise<void> }): { ui: any; container: HTMLElement } {
    domWindow.document.body.innerHTML = '';
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new mod.GameUI(container, {}, undefined, undefined, undefined, undefined, null, null, streaming);
    ui.showCharacterSelect(SLOTS);
    return { ui, container };
  }
  const createBtn = (): HTMLElement => domWindow.document.querySelector('#btn-create-character');
  const enterBtn = (): HTMLElement => domWindow.document.querySelector('[data-ac-press="21000004:100003a2"]');
  const fire = (el: Element, type: string): void => { el.dispatchEvent(new domWindow.MouseEvent(type, { bubbles: true })); };
  const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
  const deferred = (): { p: Promise<void>; land: () => void } => {
    let land!: () => void;
    const p = new Promise<void>((r) => { land = r; });
    return { p, land };
  };
  const waitBox = (): Element | null => domWindow.document.getElementById(mod.CHARGEN_WORLD_ART_WAIT_ID);

  it('a Create Character click keeps its Please Wait through char-select redraws (ServerName, 1999 news, a re-sent list) and opens chargen when the art lands', async () => {
    const art = deferred();
    const { ui } = selectScreen({ worldArtReady: art.p });
    fire(createBtn(), 'click');
    expect(waitBox()).toBeTruthy();
    // Each of these redraws character select (innerHTML reset): before the fix the box went with it.
    ui.setWorldName('Dereth');
    expect(waitBox()).toBeTruthy();
    ui.setCharSelectNews('Welcome to Dereth');
    expect(waitBox()).toBeTruthy();
    ui.showCharacterSelect(SLOTS);
    expect(domWindow.document.querySelectorAll(`#${mod.CHARGEN_WORLD_ART_WAIT_ID}`).length).toBe(1);
    // The box is modal: it covers the buttons under it.
    expect((waitBox() as HTMLElement).style.pointerEvents).toBe('auto');
    expect(ui.chargenOpenQueued).toBe(true);
    expect(ui.uiManager.currentScreen).toBe('character-select');
    art.land();
    await art.p;
    await tick();
    expect(ui.uiManager.currentScreen).toBe('character-create');
    expect(waitBox()).toBeNull();
    expect(ui.chargenOpenQueued).toBe(false);
  });

  it('an enter while the click waits drops the queued open: the art landing later does not replace Entering World with chargen', async () => {
    const art = deferred();
    const { ui } = selectScreen({ worldArtReady: art.p });
    const entered: unknown[] = [];
    ui.callbacks.onEnterWorld = (s: unknown) => entered.push(s);
    fire(createBtn(), 'click');
    // The page's own enter (auto-resume / agent tools) is not blocked by the modal box.
    ui.autoEnterCharacter(SLOTS[1]);
    expect(entered.length).toBe(1);
    expect(waitBox()).toBeNull();
    expect(ui.chargenOpenQueued).toBe(false);
    art.land();
    await art.p;
    await tick();
    expect(ui.uiManager.currentScreen).toBe('character-select');
    expect(domWindow.document.querySelector('#charsel-enteringworld')).toBeTruthy();
  });

  it('a new connect cycle, the Disconnected screen or a CharacterError drops the queued open', async () => {
    for (const leave of ['connect', 'disconnected', 'error'] as const) {
      const art = deferred();
      const { ui } = selectScreen({ worldArtReady: art.p });
      fire(createBtn(), 'click');
      if (leave === 'connect') ui.showConnectingScreen();
      else if (leave === 'disconnected') ui.showDisconnectedScreen('gone', () => {});
      else ui.showCharacterErrorDialog('refused', SLOTS);
      expect(ui.chargenOpenQueued).toBe(false);
      // Back on a live character select (the connect's list arrives) before the art lands.
      ui.showCharacterSelect(SLOTS);
      art.land();
      await art.p;
      await tick();
      expect(ui.uiManager.currentScreen, leave).toBe('character-select');
      expect(waitBox(), leave).toBeNull();
    }
  });

  it('a click after a cancelled one queues again and the art opens chargen once, not twice', async () => {
    const art = deferred();
    const { ui } = selectScreen({ worldArtReady: art.p });
    fire(createBtn(), 'click');
    ui.showConnectingScreen();
    ui.showCharacterSelect(SLOTS);
    fire(createBtn(), 'click');
    fire(createBtn(), 'click');
    expect(domWindow.document.querySelectorAll(`#${mod.CHARGEN_WORLD_ART_WAIT_ID}`).length).toBe(1);
    let renders = 0;
    const orig = ui.renderCharacterCreate.bind(ui);
    ui.renderCharacterCreate = () => { renders++; orig(); };
    art.land();
    await art.p;
    await tick();
    expect(ui.uiManager.currentScreen).toBe('character-create');
    expect(renders).toBe(1);
  });

  it('a press split by a char-select redraw still counts, once (Create, ENTER)', async () => {
    const { ui } = selectScreen();
    let creates = 0;
    ui.callbacks.onCreateNew = () => { creates++; };
    const oldCreate = createBtn();
    fire(oldCreate, 'pointerdown');
    ui.setWorldName('Dereth'); // rebuilds every button mid-press
    expect(oldCreate.isConnected).toBe(false);
    fire(createBtn(), 'pointerup');
    // The browser sends no click (down and up hit different elements).
    await tick();
    expect(creates).toBe(1);
    expect(ui.uiManager.currentScreen).toBe('character-create');

    // ENTER, where the browser does deliver a click to the new button: no second enter.
    const s2 = selectScreen();
    const entered: unknown[] = [];
    s2.ui.callbacks.onEnterWorld = (s: unknown) => entered.push(s);
    fire(enterBtn(), 'pointerdown');
    s2.ui.setWorldName('Dereth');
    fire(enterBtn(), 'pointerup');
    fire(enterBtn(), 'click');
    await tick();
    expect(entered.length).toBe(1);
  });

  it('a release on a different button, a disabled one, or with no redraw is left to the browser', async () => {
    const { ui } = selectScreen();
    let creates = 0;
    ui.callbacks.onCreateNew = () => { creates++; };
    const entered: unknown[] = [];
    ui.callbacks.onEnterWorld = (s: unknown) => entered.push(s);
    // Down on Create, redraw, up on ENTER: no click for either.
    fire(createBtn(), 'pointerdown');
    ui.setWorldName('Dereth');
    fire(enterBtn(), 'pointerup');
    await tick();
    expect(creates).toBe(0);
    expect(entered.length).toBe(0);
    // No redraw: nothing synthesized (the browser's own click is the only one).
    fire(createBtn(), 'pointerdown');
    fire(createBtn(), 'pointerup');
    await tick();
    expect(creates).toBe(0);
    // ENTER disabled by the redraw (no selection left): the press does nothing.
    fire(enterBtn(), 'pointerdown');
    ui.showCharacterSelect([]);
    fire(enterBtn(), 'pointerup');
    await tick();
    expect(entered.length).toBe(0);
  });

  // ── A character row double-click (EnterGame on message 0x1a, @ 004ed5a0) split by a redraw ──
  const row = (id: string): HTMLElement => domWindow.document.querySelector(`.char-slot[data-char-id="${id}"]`);
  const fireD = (el: Element, type: string, detail: number): void => {
    el.dispatchEvent(new domWindow.MouseEvent(type, { bubbles: true, detail }));
  };

  it('a row double-click whose second press straddles a redraw still enters, once', async () => {
    const { ui } = selectScreen();
    const entered: Array<{ name: string }> = [];
    ui.callbacks.onEnterWorld = (s: { name: string }) => entered.push(s);
    // First click: selects Beta (its handler redraws the list).
    fireD(row(SLOTS[1].id), 'pointerdown', 1);
    fireD(row(SLOTS[1].id), 'pointerup', 1);
    fireD(row(SLOTS[1].id), 'mouseup', 1);
    fireD(row(SLOTS[1].id), 'click', 1);
    expect(ui.selectScreen.selectedCharacter.name).toBe('Beta');
    expect(entered.length).toBe(0);
    // Second press: down on the row, a ServerName redraw, up on Beta's rebuilt row; no browser click.
    const old = row(SLOTS[1].id);
    fireD(old, 'pointerdown', 2);
    ui.setWorldName('Dereth');
    expect(old.isConnected).toBe(false);
    fireD(row(SLOTS[1].id), 'pointerup', 2);
    fireD(row(SLOTS[1].id), 'mouseup', 2);
    await tick();
    expect(entered.map((s) => s.name)).toEqual(['Beta']);
    expect(domWindow.document.querySelector('#charsel-enteringworld')).toBeTruthy();
  });

  it('a split row press where the browser also clicks enters once; a single split press only selects', async () => {
    const a = selectScreen();
    const entered: unknown[] = [];
    a.ui.callbacks.onEnterWorld = (s: unknown) => entered.push(s);
    fireD(row(SLOTS[1].id), 'click', 1);
    fireD(row(SLOTS[1].id), 'pointerdown', 2);
    a.ui.setWorldName('Dereth');
    fireD(row(SLOTS[1].id), 'pointerup', 2);
    fireD(row(SLOTS[1].id), 'mouseup', 2);
    fireD(row(SLOTS[1].id), 'click', 2);
    await tick();
    expect(entered.length).toBe(1);

    // A first (single) press split by a redraw: the row is selected, nothing entered.
    const b = selectScreen();
    const entered2: unknown[] = [];
    b.ui.callbacks.onEnterWorld = (s: unknown) => entered2.push(s);
    fireD(row(SLOTS[0].id), 'pointerdown', 1);
    b.ui.setWorldName('Dereth');
    fireD(row(SLOTS[0].id), 'pointerup', 1);
    fireD(row(SLOTS[0].id), 'mouseup', 1);
    await tick();
    expect(b.ui.selectScreen.selectedCharacter.name).toBe('Alpha');
    expect(entered2.length).toBe(0);
  });

  it('a second press that comes up on a different row, or on a row that can no longer be selected, does nothing', async () => {
    const { ui } = selectScreen();
    const entered: unknown[] = [];
    ui.callbacks.onEnterWorld = (s: unknown) => entered.push(s);
    fireD(row(SLOTS[1].id), 'click', 1);
    fireD(row(SLOTS[1].id), 'pointerdown', 2);
    ui.setWorldName('Dereth');
    fireD(row(SLOTS[0].id), 'pointerup', 2);
    fireD(row(SLOTS[0].id), 'mouseup', 2);
    await tick();
    expect(entered.length).toBe(0);
    expect(ui.selectScreen.selectedCharacter.name).toBe('Beta');

    // 1999: the redraw turned Beta into a pending delete ("Temporarily Unavailable", unselectable).
    if (ui.clientRules.world.pendingDeleteRowText === null) {
      ui.clientRules = { ...ui.clientRules, world: { ...ui.clientRules.world, pendingDeleteRowText: 'Temporarily Unavailable' } };
    }
    ui.showCharacterSelect(SLOTS);
    fireD(row(SLOTS[1].id), 'click', 1);
    fireD(row(SLOTS[1].id), 'pointerdown', 2);
    ui.showCharacterSelect([SLOTS[0], { ...SLOTS[1], deleteTime: 3600 }]);
    expect(row(SLOTS[1].id).dataset.inert).toBe('1');
    fireD(row(SLOTS[1].id), 'pointerup', 2);
    fireD(row(SLOTS[1].id), 'mouseup', 2);
    await tick();
    expect(entered.length).toBe(0);
  });
});
