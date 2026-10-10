/**
 * VISUAL.char-panel-body-too-bright.a.a — every PanelsWindowSlotPanel we
 * drive is a real slot of the EoL panels window body 0x2100006e:0x10000180,
 * based on the panel window its GameUI renderer draws, and its
 * returnsToPrevious is that base element's 0x10000049 (read by
 * gmPanelUI::RecvNotice_SetPanelVisibility @ 004bc6f0).
 *
 * DAT-dependent: skips without the DATs; every load sits in beforeAll.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import { resolve } from 'node:path';
import {
  PANELS_WINDOW, INVENTORY_PANEL, CHARACTER_PANEL, CHARACTER_INFO_PANEL, OPTIONS_PANEL,
  WORLD_PANEL, SOCIAL_PANEL, SPELLBOOK_PANEL, CONTRACTS_PANEL, VITAE_PANEL, LINK_STATUS_PANEL,
  MINI_GAME_PANEL, setPanelsWindowPanelVisibility,
  type PanelsWindowSlotPanel, type PanelsWindowSlotState,
} from '../packages/renderer/src/ui/PanelsWindow.js';

const ROOT = resolve(import.meta.dirname, '..');
const LANG_PATH = resolve(ROOT, 'dat/client_local_English.dat');
const PORTAL_PATH = resolve(ROOT, 'dat/client_portal.dat');

// The layout / window element each GameUI renderer draws for the panel.
const RENDERED: Array<[PanelsWindowSlotPanel, number, number]> = [
  [INVENTORY_PANEL, 0x21000023, 0x100001cc],
  [CHARACTER_PANEL, 0x2100002e, 0x10000227],
  [CHARACTER_INFO_PANEL, 0x2100001a, 0x1000011b],
  [OPTIONS_PANEL, 0x2100002b, 0x10000208],
  [WORLD_PANEL, 0x21000027, 0x100001f2],
  [SOCIAL_PANEL, 0x21000031, 0x1000028b],
  [SPELLBOOK_PANEL, 0x21000034, 0x100002a8],
  [CONTRACTS_PANEL, 0x21000063, 0x1000055f],
  [VITAE_PANEL, 0x21000020, 0x100001c1],
  [LINK_STATUS_PANEL, 0x2100001d, 0x10000167],
  [MINI_GAME_PANEL, 0x2100001e, 0x1000016a],
];

describe('panels-window slot panels — pure slot rules', () => {
  it('keys and slots are unique', () => {
    expect(new Set(RENDERED.map(([p]) => p.key)).size).toBe(RENDERED.length);
    expect(new Set(RENDERED.map(([p]) => p.slot)).size).toBe(RENDERED.length);
  });

  it('the four migrated panels displace each other and hand nothing back (no 0x10000049)', () => {
    let st: PanelsWindowSlotState<PanelsWindowSlotPanel> = { current: INVENTORY_PANEL, returnTo: null };
    for (const p of [SPELLBOOK_PANEL, WORLD_PANEL, SOCIAL_PANEL, CONTRACTS_PANEL]) {
      st = setPanelsWindowPanelVisibility(st, p, true);
      expect(st).toEqual({ current: p, returnTo: null });
    }
    st = setPanelsWindowPanelVisibility(st, CONTRACTS_PANEL, false);
    expect(st).toEqual({ current: null, returnTo: null });
    // Character info (0x10000049) over the spellbook returns to it.
    st = setPanelsWindowPanelVisibility(st, SPELLBOOK_PANEL, true);
    st = setPanelsWindowPanelVisibility(st, CHARACTER_INFO_PANEL, true);
    st = setPanelsWindowPanelVisibility(st, CHARACTER_INFO_PANEL, false);
    expect(st.current).toBe(SPELLBOOK_PANEL);
  });

  it('the vitae / link-status / mini-game dialogs (0x10000049) hand the slot back to a plain panel, not to each other', () => {
    // VISUAL.char-panel-body-too-bright.a.a.a
    for (const dialog of [VITAE_PANEL, LINK_STATUS_PANEL, MINI_GAME_PANEL]) {
      let st: PanelsWindowSlotState<PanelsWindowSlotPanel> = { current: INVENTORY_PANEL, returnTo: null };
      st = setPanelsWindowPanelVisibility(st, dialog, true);
      expect(st).toEqual({ current: dialog, returnTo: INVENTORY_PANEL });
      st = setPanelsWindowPanelVisibility(st, dialog, false);
      expect(st).toEqual({ current: INVENTORY_PANEL, returnTo: null });
    }
    // Vitae over link status: both carry the flag, so nothing is remembered.
    let st: PanelsWindowSlotState<PanelsWindowSlotPanel> = { current: LINK_STATUS_PANEL, returnTo: null };
    st = setPanelsWindowPanelVisibility(st, VITAE_PANEL, true);
    expect(st).toEqual({ current: VITAE_PANEL, returnTo: null });
    expect(setPanelsWindowPanelVisibility(st, VITAE_PANEL, false)).toEqual({ current: null, returnTo: null });
  });
});

describe.skipIf(!fs.existsSync(LANG_PATH) || !fs.existsSync(PORTAL_PATH))('panels-window slot panels — the DAT 0x2100006e body', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let getLayout: (id: number) => any;
  beforeAll(async () => {
    const dat = await import('@ac/dat-parser');
    const open = (p: string) => {
      const b = fs.readFileSync(p);
      return new dat.DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    };
    const portal = open(PORTAL_PATH);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(new dat.DatReader(portal.getFileData(0x39000001)!)));
    const lang = open(LANG_PATH);
    getLayout = (id: number) => dat.parseLayoutDesc(new dat.DatReader(lang.getFileData(id)!));
  }, 60_000);

  it.each(RENDERED.map(([p, layout, el]) => [p.key, p, layout, el] as const))(
    '%s: its slot in the body bases the window it renders, and returnsToPrevious is that window\'s 0x10000049',
    (_key, panel, layout, windowEl) => {
      const win = getLayout(PANELS_WINDOW.windowLayout);
      const body = win.elements.get(PANELS_WINDOW.window).children.get(PANELS_WINDOW.body);
      const slot = body.children.get(panel.slot);
      expect(slot, `slot 0x${panel.slot.toString(16)}`).toBeTruthy();
      expect([slot.x, slot.y, slot.width, slot.height]).toEqual([0, 0, 300, 362]);
      expect([slot.baseLayout, slot.baseElement]).toEqual([layout, windowEl]);
      // The base window element sits at the top of its own layout.
      const base = getLayout(layout).elements.get(windowEl);
      expect(base, `base 0x${windowEl.toString(16)}`).toBeTruthy();
      const p49 = base.states?.get?.(0)?.properties?.get?.(0x10000049) ?? base.properties?.get?.(0x10000049);
      expect(p49?.valueBool ?? false).toBe(panel.returnsToPrevious);
    },
  );
});
