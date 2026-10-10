/**
 * CORE.10.e — PluralName parsed from CreateObject + used for stack labels.
 *
 * Ground truth:
 * - Wire: WeenieHeaderFlag.PluralName = 0x00000001 (ACE WeenieHeaderFlags.cs:9,
 *   NOT 0x100 — that's AmmoType), written as String16L immediately after the
 *   optional second header (ACE WorldObject_Networking.cs:87-88), sent only
 *   when the weenie defines PropertyString.PluralName (:718-719).
 * - Labels: ACCWeenieObject::GetObjectName @ 0058e6e0 (NAME_APPROPRIATE):
 *   a stack of >= 2 promotes to NAME_PLURAL — pwd._plural_name when
 *   non-empty, else the singular is pluralized CLIENT-SIDE in the
 *   NAME_PLURAL fallthrough (append "es" when the name ends in 's', else
 *   "s"). Retail thus shows "Pyreals" although weenie 273 defines no
 *   PluralName; wire plurals matter for irregulars ("Vials of … Dye").
 * - Toolbar strip: gmToolbarUI::HandleSelectionChanged @ 004bf380 formats
 *   "%d %hs" / coinstack "%d %hs (of %d)" with %hs =
 *   GetObjectName(NAME_APPROPRIATE, 0).
 *
 * Suites drive the shipped code: parseCreateObject with constructed wire
 * bytes, the shared getAppropriateName selector, OpenContainerTracker
 * plumbing, and the real GameUI toolbar strip under happy-dom.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { parseCreateObject } from '../packages/network/src/MessageSerializer.js';
import { getAppropriateName } from '../packages/shared/src/inventory/objectName.js';
import { OpenContainerTracker } from '../packages/renderer/src/world/OpenContainerTracker.js';

// ─── Wire writer mirroring BinaryReader semantics (same helper shape as
//     verify-bug-icon-overlay-underlay-dropped.ts). ───
class Writer {
  private bytes: number[] = [];
  private get pos(): number { return this.bytes.length; }
  u8(v: number): this { this.bytes.push(v & 0xff); return this; }
  u16(v: number): this { this.bytes.push(v & 0xff, (v >> 8) & 0xff); return this; }
  u32(v: number): this {
    this.bytes.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
    return this;
  }
  packed(v: number): this {
    if (v >= 0x8000) throw new Error('packed() helper only supports the 2-byte form in this test');
    return this.u16(v);
  }
  align(boundary = 4): this {
    const rem = this.pos % boundary;
    if (rem !== 0) for (let i = 0; i < boundary - rem; i++) this.u8(0);
    return this;
  }
  string16(s: string): this {
    this.u16(s.length);
    for (let i = 0; i < s.length; i++) this.u8(s.charCodeAt(i));
    const totalRead = 2 + s.length;
    const rem = totalRead % 4;
    if (rem !== 0) for (let i = 0; i < 4 - rem; i++) this.u8(0);
    return this;
  }
  toUint8Array(): Uint8Array { return new Uint8Array(this.bytes); }
}

const FLAG_PLURAL_NAME = 0x00000001;
const FLAG_STACK_SIZE = 0x00001000;

/** Minimal CreateObject payload: name + optional PluralName + StackSize. */
function buildPayload(opts: { name: string; pluralName?: string; stackSize?: number }): Uint8Array {
  const flags = (opts.pluralName !== undefined ? FLAG_PLURAL_NAME : 0)
    | (opts.stackSize !== undefined ? FLAG_STACK_SIZE : 0);
  const w = new Writer();
  w.u32(0x800a0001); // guid
  w.u8(0x11).u8(0).u8(0).u8(0); // modelByte, subPalettes, texChanges, animParts
  w.align(4);
  w.u32(0); // physFlags
  w.u32(0); // physicsState
  for (let i = 0; i < 9; i++) w.u16(0); // sequence timestamps
  w.align(4);
  w.u32(flags);
  w.string16(opts.name);
  w.packed(273); // weenieClassId (coinstack)
  w.packed(0x1a4); // iconId
  w.u32(0); // itemType
  w.u32(0); // objectDescFlags (no second header)
  w.align(4);
  if (opts.pluralName !== undefined) w.string16(opts.pluralName);
  if (opts.stackSize !== undefined) w.u16(opts.stackSize);
  w.align(4);
  return w.toUint8Array();
}

describe('CORE.10.e — parseCreateObject captures PluralName (flag 0x1)', () => {
  it('reads the String16L into pluralName and keeps later fields aligned (StackSize intact)', () => {
    const obj = parseCreateObject(buildPayload({ name: 'Pyreal', pluralName: 'Pyreals', stackSize: 5000 }));
    expect(obj).not.toBeNull();
    expect(obj!.name).toBe('Pyreal');
    expect(obj!.pluralName).toBe('Pyreals');
    expect(obj!.stackSize).toBe(5000);
  });

  it("defaults pluralName to '' when the flag is absent", () => {
    const obj = parseCreateObject(buildPayload({ name: 'Drudge Skulker' }));
    expect(obj).not.toBeNull();
    expect(obj!.pluralName).toBe('');
  });
});

describe('CORE.10.e — getAppropriateName (GetObjectName NAME_APPROPRIATE semantics)', () => {
  it('a stack of >=2 with a wire plural uses it (irregulars win over +s)', () => {
    expect(getAppropriateName('Vial of Berimphur Dye', 'Vials of Berimphur Dye', 5)).toBe('Vials of Berimphur Dye');
    expect(getAppropriateName('Arrowhead', 'Arrowheads', 2)).toBe('Arrowheads');
  });
  it('no wire plural → client-side pluralize: +s, or +es after a trailing s', () => {
    expect(getAppropriateName('Pyreal', '', 5000)).toBe('Pyreals');
    expect(getAppropriateName('Widget', undefined, 50)).toBe('Widgets');
    expect(getAppropriateName('Glass', '', 3)).toBe('Glasses');
    expect(getAppropriateName('', '', 3)).toBe('');
  });
  it('a single (or non-stack) always uses the singular, plural sent or not', () => {
    expect(getAppropriateName('Pyreal', 'Pyreals', 1)).toBe('Pyreal');
    expect(getAppropriateName('Pyreal', 'Pyreals', 0)).toBe('Pyreal');
    expect(getAppropriateName('Drudge Skulker', undefined, undefined)).toBe('Drudge Skulker');
  });
});

describe('CORE.10.e — OpenContainerTracker carries pluralName to panel rows', () => {
  it('trackCreateObject → items() keeps the plural for container rows', () => {
    const t = new OpenContainerTracker();
    t.viewContents(0x600, [{ guid: 0x601, containerType: 0 }]);
    expect(t.trackCreateObject({
      guid: 0x601, containerId: 0x600, name: 'Pyreal', pluralName: 'Pyreals',
      iconDid: 0x0600, stackSize: 5000, itemType: 0,
    })).toBe(true);
    const row = t.items().find(i => i.guid === 0x601)!;
    expect(row.pluralName).toBe('Pyreals');
    expect(getAppropriateName(row.name, row.pluralName, row.stackSize)).toBe('Pyreals');
  });

  it("trackStoredItem without a plural yields '' (rows fall back to client-side +s)", () => {
    const t = new OpenContainerTracker();
    t.viewContents(0x600, []);
    t.trackStoredItem(0x602, { name: 'Widget', iconDid: 0, stackSize: 3 });
    const row = t.items().find(i => i.guid === 0x602)!;
    expect(row.pluralName).toBe('');
    expect(getAppropriateName(row.name, row.pluralName, row.stackSize)).toBe('Widgets');
  });
});

// ─── Toolbar strip label under happy-dom (real GameUI) ───
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

describe('CORE.10.e — toolbar strip "%d %hs" uses the wire plural', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    const makeHandle = (_layoutId: number, parent: HTMLElement) => {
      const root = domWindow.document.createElement('div');
      parent.appendChild(root);
      return {
        root, elements: new Map(), descs: new Map(),
        setText: () => {}, setState: () => {}, setInteractive: () => {}, setVisible: () => {},
        setTexture: () => {}, close: () => { root.remove(); },
      };
    };
    ui.layoutRenderer = {
      render: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
      renderPanel: (layoutId: number, parent: HTMLElement) => makeHandle(layoutId, parent),
    };
    ui.uiManager.setScreen('game');
    ui.renderHUD();
  });

  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  function setTarget(t: Record<string, unknown>): void {
    ui.hud.setTarget({ level: 0, healthFraction: 0, distance: 0, type: 'item', ...t });
    ui.updateHUD();
  }

  it('a stack of >=2 labels "%d <plural>" when the wire sent one', () => {
    setTarget({ id: 0x700, name: 'Arrowhead', pluralName: 'Arrowheads', stackSize: 50 });
    expect(ui.targetNameHost.textContent).toBe('50 Arrowheads');
  });

  it('a stack with NO wire plural labels "%d <name+s>" (NAME_PLURAL fallthrough)', () => {
    setTarget({ id: 0x701, name: 'Widget', stackSize: 50 });
    expect(ui.targetNameHost.textContent).toBe('50 Widgets');
  });

  it('an owned coinstack labels "%d <plural> (of %d)" against total CoinValue', () => {
    ui.hud.coinValue = 10000;
    setTarget({ id: 0x702, name: 'Pyreal', pluralName: 'Pyreals', stackSize: 5000, isCoin: true });
    expect(ui.targetNameHost.textContent).toBe('5000 Pyreals (of 10000)');
  });

  it('a single selection keeps the bare singular name', () => {
    setTarget({ id: 0x703, name: 'Pyreal', pluralName: 'Pyreals', stackSize: 1 });
    expect(ui.targetNameHost.textContent).toBe('Pyreal');
  });
});
