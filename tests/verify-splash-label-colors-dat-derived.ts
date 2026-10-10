/**
 * GAP.81 — splashLabel/splashCopyright AC_COLORS entries must be DAT/
 * decompiled-client-derived, not hand-picked hex guesses.
 *
 * Prior cycles invented '#8090b0' (blue-grey) for splashLabel and '#706850'
 * (desaturated dark gold) for splashCopyright with no citation, and two
 * separate screenshot/WebSearch passes for the retail patch/connect screen
 * (LayoutDesc 0x21000000, client_local_English.dat) turned up nothing.
 *
 * This cycle found the answer in two independent sources instead:
 *
 * 1. DAT ground truth: parsing LayoutDesc 0x21000000's full BaseProperty
 *    tree (client_local_English.dat) shows ElementDesc 0x10000420
 *    (ConnectText), 0x10000421 (PatchText), and 0x1000041d (the copyright
 *    bar) carry ZERO BasePropertyType.Color entries in their default state
 *    or any named state.
 * 2. Decompiled retail client: gmDataPatchUI's constructor (004ee2b0) binds
 *    m_connectText/m_patchText via GetChildRecursive off that same layout,
 *    and none of its methods (constructor, SetConnectLevel @ 004ede60,
 *    SetPatchLevel @ 004edee0, UseTime @ 004edf10, OnDDDEvent @ 004edff0)
 *    ever call UIElement_Text::SetFontColorHelper/SetFontColorNum on them.
 *    UIElement_Text's own constructor (004eff0 -> 00468570) initializes
 *    every text element's m_curFontColor/m_curTagFontColor to the
 *    engine-wide ::RGBAColor_White constant (the same constant used
 *    throughout the client for opaque white, e.g. MaterialLayer diffuse/
 *    specular defaults) — so absent any override, retail renders these
 *    labels in plain white.
 *
 * Drives the real DAT parser (packages/dat-parser) against LayoutDesc
 * 0x21000000 to confirm finding (1) from the shipped bytes — not a
 * source-text regex pin.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { AC_COLORS } from '../packages/renderer/src/ui/GameUI.js';
import { DatDatabase } from '../packages/dat-parser/src/DatDatabase.js';
import {
  parseLayoutDesc,
  parseMasterProperty,
  setMasterPropertyTypes,
  BasePropertyType,
  type ElementDesc,
} from '../packages/dat-parser/src/file-types/LayoutDesc.js';
import { openDat } from './_harness/dat.js';

const ROOT = resolve(__dirname, '..');
const PORTAL_DAT = resolve(ROOT, 'dat/client_portal.dat');
const LANG_DAT = resolve(ROOT, 'dat/client_local_English.dat');
const hasDats = existsSync(PORTAL_DAT) && existsSync(LANG_DAT);

describe('GAP.81: splashLabel/splashCopyright resolve to AC_COLORS.white', () => {
  it('splashLabel is AC_COLORS.white, not the discredited invented blue-grey', () => {
    expect(AC_COLORS.splashLabel).toBe(AC_COLORS.white);
    expect(AC_COLORS.splashLabel).not.toBe('#8090b0');
  });

  it('splashCopyright is AC_COLORS.white, not the discredited invented dark gold', () => {
    expect(AC_COLORS.splashCopyright).toBe(AC_COLORS.white);
    expect(AC_COLORS.splashCopyright).not.toBe('#706850');
  });
});

describe.skipIf(!hasDats)('GAP.81: LayoutDesc 0x21000000 carries no Color property for the patch-screen text elements', () => {
  let elements: Map<number, ElementDesc>;

  beforeAll(() => {
    const portalDb = openDat(PORTAL_DAT);
    const langDb = openDat(LANG_DAT);

    const masterTypes = parseMasterProperty(portalDb.getReader(0x39000001));
    setMasterPropertyTypes(masterTypes);

    const layout = parseLayoutDesc(langDb.getReader(0x21000000));
    elements = layout.elements;
  });

  function findElement(id: number, els: Map<number, ElementDesc> = elements): ElementDesc | null {
    for (const el of els.values()) {
      if (el.elementId === id) return el;
      const found = findElement(id, el.children);
      if (found) return found;
    }
    return null;
  }

  function hasAnyColorProperty(el: ElementDesc): boolean {
    for (const p of el.properties.values()) {
      if (p.propertyType === BasePropertyType.Color) return true;
    }
    for (const state of el.states.values()) {
      for (const p of state.properties.values()) {
        if (p.propertyType === BasePropertyType.Color) return true;
      }
    }
    return false;
  }

  it('ConnectText (0x10000420) exists and has no Color property', () => {
    const el = findElement(0x10000420);
    expect(el).not.toBeNull();
    expect(hasAnyColorProperty(el!)).toBe(false);
  });

  it('PatchText (0x10000421) exists and has no Color property', () => {
    const el = findElement(0x10000421);
    expect(el).not.toBeNull();
    expect(hasAnyColorProperty(el!)).toBe(false);
  });

  it('the copyright bar element (0x1000041d) exists and has no Color property', () => {
    const el = findElement(0x1000041d);
    expect(el).not.toBeNull();
    expect(hasAnyColorProperty(el!)).toBe(false);
  });
});
