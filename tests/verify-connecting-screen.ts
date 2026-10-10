/**
 * VISUAL.78/104/105 — the server-connect phase shows the ToD login screen
 * (charselect backdrop + wordmark + World/Characters panels from layout
 * 0x21000004), not the black PatchField splash.
 *
 * CORE.13 — per the decompiled retail client the connecting phase draws the
 * FULL charmgmt screen (buttons included; UpdateButtons @ 004ec240 never
 * hides them) with a modal "Please Wait" dialog on top, closed when the
 * character set arrives (Update @ 004ecab0). The PatchField splash
 * (0x21000000, classic logo on black) is the PATCHER's screen and ends when
 * the DATs finish loading.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const GAMEUI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf8');
const MAIN = readFileSync(resolve(REPO, 'packages/renderer/src/main.ts'), 'utf8');
const CAPTURE = readFileSync(resolve(REPO, 'tools/capture-preworld-screens.ts'), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'requestAnimationFrame'] as const;

describe('VISUAL.78/104/105 — connecting-phase login screen', () => {
  it('GameUI.showConnectingScreen sets connectingMode and renders the charselect scaffold', () => {
    const block = GAMEUI.match(/showConnectingScreen\(\): void \{[\s\S]+?\n  \}/)?.[0] ?? '';
    expect(block).toMatch(/this\.connectingMode = true;/);
    expect(block).toMatch(/this\.renderCharacterSelect\(\);/);
  });

  it('renderCharacterSelect draws the full chrome while connecting (CORE.13)', () => {
    // CORE.13 — the decompiled retail client draws the whole charmgmt
    // screen while waiting for the character set (UpdateButtons @ 004ec240
    // never hides buttons) and covers it with a modal Please Wait dialog
    // (Update @ 004ecab0 closes it when the set arrives). The world field
    // is empty until ServerName (0xF7E1) arrives — retail UpdateWorldName
    // @ 004ec120 populates it only from the notice.
    expect(GAMEUI).toMatch(/this\.worldName \?\? ''/);
    // The old early return before the Create Character button is gone.
    expect(GAMEUI).not.toMatch(/if \(this\.connectingMode\) return;/);
  });

  it('ACE mode enters the connecting screen when the bridge connection starts', () => {
    const connIdx = MAIN.indexOf('Connecting to ACE server via bridge');
    expect(connIdx).toBeGreaterThan(0);
    // ASSESS — the /reconnect chat command added a second (earlier-in-file)
    // showConnectingScreen call site, so assert the bridge-connect-phase
    // call specifically: the first occurrence AFTER the connect log line.
    const idx = MAIN.indexOf('gameUI.showConnectingScreen();', connIdx);
    expect(idx).toBeGreaterThan(connIdx);
  });

  it('capture harness keys on the persistent charsel-inner data-mode marker', () => {
    expect(GAMEUI).toMatch(/inner\.dataset\.mode = this\.connectingMode \? 'connecting' : 'select';/);
    expect(CAPTURE).toMatch(/dataset\.mode === 'connecting'/);
    expect(CAPTURE).toMatch(/dataset\.mode === 'select'/);
  });
});

// Behavioral suite — drives the real GameUI class under happy-dom (same
// harness as verify-charselect-no-resurrect.ts). Converted from a source-text
// pin per CLAUDE.md's "convert the pin to a behavioral test" rule: the pin's
// literal `showCharacterSelect(characters: CharacterSlot[] = []): void`
// regex broke when BUG.character-select-create-button-not-capped added a
// second `slotCount` parameter.
describe('VISUAL.78/104/105 — showCharacterSelect clears connectingMode', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};

  beforeAll(() => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('the connecting screen renders the buttons + Please Wait modal; showCharacterSelect drops the modal', async () => {
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new mod.GameUI(container);

    // CORE.13 — retail draws the full chrome while connecting (buttons
    // included) with a modal Please Wait dialog on top.
    ui.showConnectingScreen();
    expect(container.querySelector('#btn-create-character')).toBeTruthy();
    expect(container.querySelector('#charsel-pleasewait')).toBeTruthy();

    ui.showCharacterSelect([]);
    expect(container.querySelector('#btn-create-character')).toBeTruthy();
    expect(container.querySelector('#charsel-pleasewait')).toBeFalsy();
    // RECON.charselect-dat-controls — an empty set draws an empty list, no
    // invented "No characters" placeholder (RebuildCharacterList @ 004ec3a0).
    expect(container.querySelector('#charsel-inner')!.textContent).not.toContain('No characters');
    expect(container.querySelectorAll('.char-slot-name').length).toBe(0);
  });
});
