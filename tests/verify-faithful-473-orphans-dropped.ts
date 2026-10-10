/**
 * FAITHFUL.473 — drop 5 more orphan helpers.
 *
 *  Continuing the FAITHFUL.468-472 orphan-helper cleanup:
 *  - `addChatMessage(sender, text, color)` — local echo was
 *    deliberately suppressed in FAITHFUL.352/.356; server's
 *    HearSpeech + per-handler retail-format lines own local display.
 *  - `destroy()` — never called; browser handles DOM cleanup on
 *    tab close, and HMR reloads the module.
 *  - `showLoadingScreen` + `hideLoadingScreen` (plus the
 *    `loadingScreen` field) — main.ts uses its own loadingOverlay
 *    path (setLoadStatusDual + stopMeterAnimation) with a different
 *    visual. The dead 100-line DAT-driven build-up just bloated the
 *    file.
 *  - `showSalvagePanel` + `setSalvageItems` — salvage panel-open
 *    client-flow not wired at the time; the then-working path was
 *    onSalvage → CreateTinkeringTool → setSalvageResult.
 *    GAP.22 later WIRED the retail entry (dblclick Ust → panel), so
 *    showSalvagePanel is back BY DESIGN and asserted wired below;
 *    setSalvageItems stays gone (drag-into-panel replaced it).
 *
 *  Per FAITHFUL.437 drop-dead-code principle.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { decideUseObject, ownedUseSubject } from '../packages/renderer/src/input/UseObject.js';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO = resolve(__dirname, '..');
const UI = readFileSync(resolve(REPO, 'packages/renderer/src/ui/GameUI.ts'), 'utf8');

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('FAITHFUL.473 — orphans removed', () => {
  it('addChatMessage definition KEPT (pinned by other tests as regression API)', () => {
    expect(UI).toMatch(/addChatMessage\(sender: string, text: string/);
  });

  it('destroy() definition is gone', () => {
    expect(UI).not.toMatch(/destroy\(\): void \{[\s\S]+?this\.screenContainer\.remove/);
  });

  it('showLoadingScreen definition is gone', () => {
    expect(UI).not.toMatch(/showLoadingScreen\(statusText/);
  });

  it('hideLoadingScreen definition is gone', () => {
    expect(UI).not.toMatch(/hideLoadingScreen\(\): void \{[\s\S]+?this\.loadingScreen/);
  });

  it('showSalvagePanel is back AND wired (GAP.22): using the Ust is DetermineUseResult case 6 (the panel), not a Use', () => {
    // SWEEP1006B — the pack double-click runs ItemHolder::UseObject, whose
    // case 6 is main.ts's gameUI.showSalvagePanel(guid).
    const ust = ownedUseSubject(0x8000_0ab0, { name: 'Ust', containerId: 0x5000_0001, itemType: 0x20000000, usable: 0x8 }, 0x5000_0001);
    expect(decideUseObject(ust, {
      playerGuid: 0x5000_0001, groundObject: 0, allowSelection: false, skipDetermine: false, selectedGuid: 0,
      attackable: false, peaceMode: true, confirmVolatileRare: false, selectionCompatible: false,
    })).toEqual({ kind: 'usingItem', result: 6 });
  });

});

describe('FAITHFUL.473 — kept helpers still work', () => {
  it('addSystemMessage still defined', () => {
    expect(UI).toMatch(/addSystemMessage\(text: string/);
  });

});

// setSalvageResult's "still defined" pin was a source-text regex on the
// old single-object signature; it was converted to a behavioral drive, and
// CORE.17.k.b.b.c.c.a.a.c.a.a then retired the method: retail prints the
// salvage result to chat (ClientUISystem::Handle_Inventory__Recv_
// SalvageOperationsResultData @ 00565620 → AddTextToScroll), never into the
// panel — main.ts posts salvageResultChatLines. The salvage source pins here
// are now behavioral drives of the real GameUI.
describe('FAITHFUL.473 — the salvage entry points (behavioral)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('showSalvagePanel opens and hideSalvagePanel closes the panel', () => {
    ui.showSalvagePanel(0x8000cccc);
    expect(ui.isSalvageOpen).toBe(true);
    ui.hideSalvagePanel();
    expect(ui.isSalvageOpen).toBe(false);
  });

  it('setSalvageItems (FAITHFUL.473) and setSalvageResult (CORE.17.k.b.b.c.c.a.a.c.a.a) are gone', () => {
    expect(ui.setSalvageItems).toBeUndefined();
    expect(ui.setSalvageResult).toBeUndefined();
  });
});

describe('FAITHFUL.473 citation', () => {
  it('GameUI cites FAITHFUL.473', () => {
    expect(UI).toMatch(/FAITHFUL\.473/);
  });
});
