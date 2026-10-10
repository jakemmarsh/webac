/**
 * CORE.3.a — LayoutDesc element base-inheritance resolution.
 *
 * Retail ground truth (decompiled EoL client, acclient-decompiled.c):
 * an element with type==0 is a PARTIAL desc deriving from a base element
 * (m_baseElement, top-level in m_baseLayout). LayoutDesc::InqFullDesc
 * (0069a520) resolves the base chain recursively; ElementDesc::Incorporate
 * (0069b5a0) then overlays the derived desc: states merge per-id, media
 * CONCATENATE (base first), properties override per-id, geometry only
 * where the derived's incorporation flag bit is set, and the base chain's
 * type (element class) wins. StateDesc::Incorporate is 0069cca0.
 *
 * Concrete case (Jake's live play-test follow-up): the classic_chat
 * (0x21000006) numbered chat-window buttons 0x10000522-525 carry only a
 * digit (p23) and a command (p18) — their gold box art comes from the
 * inheritance chain 0x10000526@0x21000006 (state1 tex 0x06006218 normal /
 * state6 0x06006219 lit) → 0x100002b9@0x21000040 (text centering) →
 * 0x1000047f@0x21000040 (type 1 = UIElement_Button). gmMainChatUI::
 * RecvNotice_SetPanelVisibility (004ccd80) flips these buttons between
 * states 1 and 6 as the corresponding floaty chat window hides/shows.
 *
 * Unit tests exercise the merge semantics on synthetic descs (no DAT);
 * the DAT suite resolves the real chat layout and asserts the buttons
 * gain exactly the retail art.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import {
  DatDatabase, DatReader, parseMasterProperty, setMasterPropertyTypes,
  parseLayoutDesc, resolveLayoutDesc, resolveElementDesc, IncorporationFlags,
} from '@ac/dat-parser';
import type { ElementDesc, StateDesc, LayoutDescData } from '@ac/dat-parser';
import { openDat } from './_harness/dat.js';

const PORTAL_PATH = 'dat/client_portal.dat';
const LANG_PATH = 'dat/client_local_English.dat';
const hasDats = fs.existsSync(PORTAL_PATH) && fs.existsSync(LANG_PATH);

// ─── Synthetic-desc helpers (unit tests, no DAT required) ───────────────

function mkState(partial: Partial<StateDesc> = {}): StateDesc {
  return {
    stateId: 0,
    passToChildren: false,
    incorporationFlags: 0,
    properties: new Map(),
    media: [],
    ...partial,
  };
}

function mkElement(partial: Partial<ElementDesc> = {}): ElementDesc {
  return {
    ...mkState(),
    uiReadOrder: 0,
    elementId: 0,
    type: 0,
    baseElement: 0,
    baseLayout: 0,
    defaultState: 0,
    x: 0, y: 0, width: 0, height: 0, zLevel: 0,
    leftEdge: 0, topEdge: 0, rightEdge: 0, bottomEdge: 0,
    states: new Map(),
    children: new Map(),
    ...partial,
  };
}

function mkLayout(id: number, elements: [number, ElementDesc][]): LayoutDescData {
  return { id, displayWidth: 800, displayHeight: 600, elements: new Map(elements) };
}

describe('LayoutDesc inheritance resolution (retail InqFullDesc/Incorporate semantics)', () => {
  it('resolves a type-0 element against its base: base type wins, states inherited', () => {
    const base = mkElement({
      elementId: 0x100,
      type: 1, // chain root — full desc (e.g. UIElement_Button)
      defaultState: 1,
      width: 16, height: 16,
      incorporationFlags: IncorporationFlags.Width | IncorporationFlags.Height,
      states: new Map([[1, mkState({ stateId: 1, media: [{ type: 5, file: 0x06006218 }] })]]),
    });
    const derived = mkElement({
      elementId: 0x200,
      type: 0,
      baseElement: 0x100,
      baseLayout: 0x21000040,
      x: 0, y: 10,
      incorporationFlags: IncorporationFlags.X | IncorporationFlags.Y,
      properties: new Map([[23, { id: 23, propertyType: 8 } as never]]),
    });
    const layouts = new Map([[0x21000040, mkLayout(0x21000040, [[0x100, base]])]]);
    const full = resolveElementDesc(derived, (id) => layouts.get(id) ?? null);

    expect(full.type).toBe(1); // base chain's element class wins
    expect(full.elementId).toBe(0x200); // derived identity wins
    expect(full.defaultState).toBe(0); // derived defaultState copied unconditionally
    // Geometry: derived sets x/y (flags), base contributes w/h (flags OR'd)
    expect(full.x).toBe(0);
    expect(full.y).toBe(10);
    expect(full.width).toBe(16);
    expect(full.height).toBe(16);
    expect(full.incorporationFlags & IncorporationFlags.Width).toBeTruthy();
    // Inherited state art
    expect(full.states.get(1)!.media[0]!.file).toBe(0x06006218);
    // Derived property carried through
    expect(full.properties.has(23)).toBe(true);
  });

  it('resolves multi-level chains and merges states per-id with media concatenation', () => {
    const root = mkElement({
      elementId: 0x1,
      type: 1,
      states: new Map([[3, mkState({ stateId: 3, media: [{ type: 9, stateId: 0x2000004b }] })]]),
    });
    const mid = mkElement({
      elementId: 0x2,
      type: 0, baseElement: 0x1, baseLayout: 0x40,
      states: new Map([
        [1, mkState({ stateId: 1, media: [{ type: 5, file: 0xa }] })],
        [3, mkState({ stateId: 3, media: [{ type: 5, file: 0xb }] })],
      ]),
    });
    const leaf = mkElement({
      elementId: 0x3,
      type: 0, baseElement: 0x2, baseLayout: 0x40,
      states: new Map([[1, mkState({ stateId: 1, media: [{ type: 5, file: 0xc }] })]]),
    });
    const layouts = new Map([[0x40, mkLayout(0x40, [[0x1, root], [0x2, mid]])]]);
    const full = resolveElementDesc(leaf, (id) => layouts.get(id) ?? null);

    expect(full.type).toBe(1);
    // state 1: mid's media first, then leaf's appended (ConcatenateMedia order)
    expect(full.states.get(1)!.media.map((m) => m.file)).toEqual([0xa, 0xc]);
    // state 3: root's media first, then mid's
    const s3 = full.states.get(3)!.media;
    expect(s3[0]!.stateId).toBe(0x2000004b);
    expect(s3[1]!.file).toBe(0xb);
  });

  it('derived properties override base properties per-id; base-only props survive', () => {
    const base = mkElement({
      elementId: 0x1, type: 1,
      properties: new Map([
        [35, { id: 35, propertyType: 4, valueInt: 7 } as never],
        [26, { id: 26, propertyType: 12 } as never],
      ]),
    });
    const derived = mkElement({
      elementId: 0x2, type: 0, baseElement: 0x1, baseLayout: 0x40,
      properties: new Map([[35, { id: 35, propertyType: 4, valueInt: 0 } as never]]),
    });
    const layouts = new Map([[0x40, mkLayout(0x40, [[0x1, base]])]]);
    const full = resolveElementDesc(derived, (id) => layouts.get(id) ?? null);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((full.properties.get(35) as any).valueInt).toBe(0); // derived wins
    expect(full.properties.has(26)).toBe(true); // base-only survives
  });

  it('merges children by id: colliding children incorporate, base-only and derived-only both survive', () => {
    const base = mkElement({
      elementId: 0x1, type: 1,
      children: new Map([
        [0x10, mkElement({ elementId: 0x10, type: 3, media: [{ type: 5, file: 0xaa }] })],
        [0x11, mkElement({ elementId: 0x11, type: 3 })],
      ]),
    });
    const derived = mkElement({
      elementId: 0x2, type: 0, baseElement: 0x1, baseLayout: 0x40,
      children: new Map([
        [0x10, mkElement({ elementId: 0x10, type: 0, media: [{ type: 5, file: 0xbb }] })],
        [0x12, mkElement({ elementId: 0x12, type: 3 })],
      ]),
    });
    const layouts = new Map([[0x40, mkLayout(0x40, [[0x1, base]])]]);
    const full = resolveElementDesc(derived, (id) => layouts.get(id) ?? null);

    expect(full.children.size).toBe(3);
    // Colliding child: media concatenated base-first
    expect(full.children.get(0x10)!.media.map((m) => m.file)).toEqual([0xaa, 0xbb]);
    expect(full.children.has(0x11)).toBe(true);
    expect(full.children.has(0x12)).toBe(true);
  });

  it('does not mutate the input descs or the base layouts (raw caches stay valid)', () => {
    const base = mkElement({
      elementId: 0x1, type: 1,
      states: new Map([[1, mkState({ stateId: 1, media: [{ type: 5, file: 0xa }] })]]),
    });
    const derived = mkElement({
      elementId: 0x2, type: 0, baseElement: 0x1, baseLayout: 0x40,
      states: new Map([[1, mkState({ stateId: 1, media: [{ type: 5, file: 0xb }] })]]),
    });
    const layouts = new Map([[0x40, mkLayout(0x40, [[0x1, base]])]]);
    resolveElementDesc(derived, (id) => layouts.get(id) ?? null);

    expect(base.states.get(1)!.media).toHaveLength(1);
    expect(derived.states.get(1)!.media).toHaveLength(1);
    expect(derived.type).toBe(0);
  });

  it('survives a base-reference cycle by falling back to the partial desc', () => {
    const a = mkElement({ elementId: 0x1, type: 0, baseElement: 0x2, baseLayout: 0x40 });
    const b = mkElement({ elementId: 0x2, type: 0, baseElement: 0x1, baseLayout: 0x40 });
    const layouts = new Map([[0x40, mkLayout(0x40, [[0x1, a], [0x2, b]])]]);
    const full = resolveElementDesc(a, (id) => layouts.get(id) ?? null);
    expect(full.elementId).toBe(0x1); // no infinite recursion
  });

  it('falls back to the partial desc when the base layout or element is missing', () => {
    const orphan = mkElement({ elementId: 0x5, type: 0, baseElement: 0x99, baseLayout: 0x77, width: 8 });
    const full = resolveElementDesc(orphan, () => null);
    expect(full.elementId).toBe(0x5);
    expect(full.width).toBe(8);
  });
});

// ─── Real-DAT resolution: classic_chat numbered window buttons ──────────

describe.skipIf(!hasDats)('CORE.3.a — classic_chat buttons resolve to retail gold box art', () => {
  let resolved: LayoutDescData;
  let raw: LayoutDescData;

  beforeAll(() => {
    const portal = openDat(PORTAL_PATH);
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portal.getFileData(0x39000001)!)));

    const lang = openDat(LANG_PATH);
    const cache = new Map<number, LayoutDescData | null>();
    const load = (id: number): LayoutDescData | null => {
      if (cache.has(id)) return cache.get(id)!;
      const data = lang.getFileData(id);
      const parsed = data ? parseLayoutDesc(new DatReader(data)) : null;
      cache.set(id, parsed);
      return parsed;
    };
    raw = load(0x21000006)!;
    resolved = resolveLayoutDesc(raw, load);
  });

  function findElement(layout: LayoutDescData, id: number): ElementDesc | null {
    const walk = (el: ElementDesc): ElementDesc | null => {
      if ((el.elementId >>> 0) === id) return el;
      for (const [, c] of el.children) {
        const hit = walk(c);
        if (hit) return hit;
      }
      return null;
    };
    for (const [, e] of layout.elements) {
      const hit = walk(e);
      if (hit) return hit;
    }
    return null;
  }

  it('buttons 0x10000522-525 resolve to UIElement_Button (type 1) with the gold box state art', () => {
    for (const id of [0x10000522, 0x10000523, 0x10000524, 0x10000525]) {
      const el = findElement(resolved, id)!;
      expect(el, `element 0x${id.toString(16)}`).not.toBeNull();
      // Chain 0x10000526@0x21000006 → 0x100002b9@0x21000040 → 0x1000047f (type 1)
      expect(el.type).toBe(1);
      // state 1 (Normal): gold box 0x06006218; state 6 (lit): 0x06006219
      expect(el.states.get(1)!.media.map((m) => m.file)).toContain(0x06006218);
      expect(el.states.get(6)!.media.map((m) => m.file)).toContain(0x06006219);
      // Own digit text + toggle command preserved
      expect(el.properties.has(23)).toBe(true);
      expect(el.properties.has(18)).toBe(true);
      // Own 16x16 geometry preserved (not clobbered by the base)
      expect(el.width).toBe(16);
      expect(el.height).toBe(16);
    }
  });

  it('buttons keep their layout positions down the left edge of the chat log', () => {
    const ys = [0x10000522, 0x10000523, 0x10000524, 0x10000525]
      .map((id) => findElement(resolved, id)!.y);
    expect(ys).toEqual([10, 28, 46, 64]);
  });

  it('resolution does not mutate the raw parsed layout', () => {
    const rawBtn = findElement(raw, 0x10000522)!;
    expect(rawBtn.type).toBe(0);
    expect(rawBtn.states.size).toBe(0);
    expect(rawBtn.media).toHaveLength(0);
  });

  it('the whole resolved layout leaves no unresolved type-0 elements with a live base ref', () => {
    const unresolved: string[] = [];
    const walk = (el: ElementDesc) => {
      if (el.type === 0 && el.baseElement !== 0) {
        unresolved.push(`0x${(el.elementId >>> 0).toString(16)}`);
      }
      for (const [, c] of el.children) walk(c);
    };
    for (const [, e] of resolved.elements) walk(e);
    expect(unresolved).toEqual([]);
  });
});
