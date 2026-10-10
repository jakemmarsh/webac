/**
 * FAITHFUL.541 — propagate CreateObject value + burden through ServerObject
 * to the trade panel; render per-side burden/value totals row.
 *
 * Pre-fix: the trade panel's partner-side rows always showed value=0
 * because lookup hit ServerObject which had no `value` field. Only own
 * items (looked up from InventoryItem) had real values. ACE
 * WorldObject_Networking.cs:99-100 ships `Value` via WeenieHeaderFlag.Value
 * and lines 156-157 ship Burden (as ushort); parser already extracted
 * them into CreateObjectData.value / .burden but ServerObjectManager
 * dropped them on the floor when constructing the ServerObject.
 *
 * Also pre-fix: the DAT layout 0x2100000d has elements at left-half y=89
 * (elem 0x10000082) and right-half y=89 (elem 0x10000089) for per-side
 * burden/value totals — both were unrendered. Now both totals rows show
 * "Burden: N  Value: M" derived from the items added to each side.
 * CORE.17.k.b.b.c.c.a.a.c.a.b — that half is overturned by the decompiled
 * client: 0x10000082 / 0x10000089 are the item lists' scrollbars, and the
 * per-side label is 0x10000080 / 0x10000087, "Total Items: N"
 * (ID_SecureTrade_TotalItemsLabel, gmSecureTradeUI::SetMyItemNumber @
 * 004c98d0 / SetOtherItemNumber @ 004c9970). Retail shows no burden or value
 * sums; the value/burden propagation (the ServerObject half) stands.
 *
 * CONVERTED from a source-text pin (regex-matched raw GameUI.ts/
 * ServerObjectManager.ts source, never executed either module) to a
 * behavioral test, per the FAITHFUL.566/.567 conversion shape (CLAUDE.md
 * "Never Break Tests" — source-text pins catch nothing). Two halves:
 *  1. Drive the real ServerObjectManager.createObject()/updateAppearance()
 *     with constructed CreateObjectData/ObjDescEventData and assert on the
 *     returned ServerObject's value/burden fields.
 *  2. Drive the real GameUI (happy-dom, stub layoutRenderer per the
 *     FAITHFUL.548/GAP.20 pattern in verify-trade-drop-from-inventory.ts)
 *     through showTradeWindow()/setTradeData() and read the rendered
 *     totals rows' actual DOM text content.
 *
 * Converting turned up that the original pin's claim about bug #2 ("the
 * mesh rebuild path was zeroing value/burden — fixed") doesn't hold up
 * behaviorally: updateAppearance()'s local CreateObjectData literal
 * passes value/burden through to buildMesh(), but buildMesh() never reads
 * those two fields (it only consumes setupId/animPartChanges/
 * textureChanges/palettes) — and updateAppearance() never writes
 * obj.value/obj.burden at all, regardless of what's in that literal. The
 * "fix" is inert boilerplate satisfying the CreateObjectData type, not an
 * observable behavior change. See the comment fixed alongside this test
 * at ServerObjectManager.ts's updateAppearance() rebuild block. The third
 * test below asserts the actual (true, but differently-caused) invariant:
 * appearance-only updates never touch value/burden.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';
import type { CreateObjectData } from '@ac/network';
import type { ObjDescEventData } from '../packages/renderer/src/network/ServerMessageHandler.js';

const REPO = resolve(fileURLToPath(import.meta.url), '../..');
const ACE_NET = readFileSync(resolve(REPO, 'reference/ACE/Source/ACE.Server/WorldObjects/WorldObject_Networking.cs'), 'utf8');

function baseCreateObjectData(overrides: Partial<CreateObjectData> = {}): CreateObjectData {
  return {
    guid: 0x80001111,
    name: 'Test Item',
    weenieClassId: 300,
    itemType: 0,
    position: null,
    setupId: 0,
    motionTableId: 0,
    iconId: 0x06000001,
    physicsState: 0,
    objectDescFlags: 0,
    radarColor: 0,
    radarBehavior: 0,
    basePalette: 0,
    subPalettes: [],
    textureChanges: [],
    animPartChanges: [],
    containerId: 0,
    wielderId: 0,
    currentWieldedLocation: 0,
    parentLocation: 0,
    validLocations: 0,
    stackSize: 0,
    maxStackSize: 0,
    value: 0,
    burden: 0,
    uiEffects: 0,
    usable: 0,
    useRadius: 0.6,
    velocityX: 0,
    velocityY: 0,
    velocityZ: 0,
    soundTableId: 0,
    objScale: 1.0,
    translucency: 0,
    defaultScript: 0,
    defaultScriptIntensity: 1.0,
    iconOverlayId: 0,
    iconUnderlayId: 0,
    cooldownId: 0,
    cooldownDuration: 0,
    ...overrides,
  };
}

describe('FAITHFUL.541 — ServerObjectManager.createObject() propagates value + burden', () => {
  async function makeSOM() {
    const { ServerObjectManager } = await import('../packages/renderer/src/world/ServerObjectManager.js');
    const scene = { add: () => {}, remove: () => {} };
    const setupModelRenderer = {
      createSetupMeshWithOverrides: () => new THREE.Group(),
      loadSetupModel: () => null,
    };
    const appearanceManager = { loadPaletteColors: () => null };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const som = new ServerObjectManager(setupModelRenderer as any, appearanceManager as any, scene as any);
    return som;
  }

  it('a real CreateObject wire-decoded payload lands value/burden on the ServerObject', async () => {
    const som = await makeSOM();
    const data = baseCreateObjectData({ guid: 0x80002222, value: 1234, burden: 56 });
    const obj = som.createObject(data);
    expect(obj).not.toBeNull();
    expect(obj!.value).toBe(1234);
    expect(obj!.burden).toBe(56);
  });

  it('missing value/burden on the wire default to 0, not undefined', async () => {
    const som = await makeSOM();
    const data = baseCreateObjectData({ guid: 0x80003333 });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (data as any).value;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    delete (data as any).burden;
    const obj = som.createObject(data);
    expect(obj!.value).toBe(0);
    expect(obj!.burden).toBe(0);
  });

  it('an ObjDesc-triggered mesh rebuild leaves the object\'s value/burden untouched', async () => {
    const som = await makeSOM();
    // setupId non-zero + the stub setupModelRenderer above returns a real
    // THREE.Group, so obj.mesh is truthy and the rebuild branch inside
    // updateAppearance() actually executes (mesh-less objects skip it).
    const data = baseCreateObjectData({ guid: 0x80004444, setupId: 0x02000123, value: 777, burden: 42 });
    const obj = som.createObject(data);
    expect(obj).not.toBeNull();
    const meshBeforeRebuild = obj!.mesh;
    expect(meshBeforeRebuild).not.toBeNull();
    expect(obj!.value).toBe(777);
    expect(obj!.burden).toBe(42);

    const objDesc: ObjDescEventData = {
      guid: 0x80004444,
      basePalette: 0,
      subPalettes: [],
      textureChanges: [{ partIndex: 0, oldTexture: 0x05000001, newTexture: 0x05000002 }],
      animPartChanges: [],
      instanceSequence: 1,
      visualDescSequence: 1,
    };
    som.updateAppearance(objDesc);

    const rebuilt = som.getObject(0x80004444);
    expect(rebuilt).toBeDefined();
    // Confirm the rebuild path actually ran (mesh got replaced), so this
    // test can't pass by accident because nothing happened.
    expect(rebuilt!.mesh).not.toBe(meshBeforeRebuild);
    // updateAppearance() never assigns obj.value/obj.burden — an
    // appearance-only update (palette/texture swap) correctly leaves the
    // item's value and weight unchanged.
    expect(rebuilt!.value).toBe(777);
    expect(rebuilt!.burden).toBe(42);
  });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });

const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;
/** The trade slot 0x1000005f and its elements (layout 0x2100000d). */
const TRADE_SLOT_IDS = [0x1000005f, 0x1000007b, 0x1000007d, 0x1000007e, 0x1000007f, 0x10000080, 0x10000081, 0x10000082,
  0x10000083, 0x10000085, 0x10000086, 0x10000087, 0x10000088, 0x10000089, 0x1000008a, 0x1000008b];
/** The texts the last dock handle set, by element id. */
const TEXTS = new Map<number, string>();

describe('FAITHFUL.541 / CORE.17.k.b.b.c.c.a.a.c.a.b — the per-side totals are "Total Items: N" (SetMyItemNumber / SetOtherItemNumber)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    const mod = await import('../packages/renderer/src/ui/GameUI.js');
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    ui = new mod.GameUI(container);
    ui.layoutRenderer = {
      // CORE.17.k.b.b.c.c.a.a.c.a.b — the transaction dock 0x2100006d with the
      // trade slot's elements (the panel is the DAT slot).
      render: (_layoutId: number, parent: HTMLElement) => {
        const root = domWindow.document.createElement('div');
        parent.appendChild(root);
        const elements = new Map<number, HTMLElement>();
        for (const id of TRADE_SLOT_IDS) {
          const el = domWindow.document.createElement('div');
          el.dataset.elementId = `0x${id.toString(16)}`;
          if (id === 0x10000088 || id === 0x10000081) el.style.width = '295px';
          root.appendChild(el);
          elements.set(id, el);
        }
        TEXTS.clear();
        return {
          root, elements, descs: new Map(),
          setText: (id: number, t: string) => { TEXTS.set(id, t); },
          setFill: () => {}, setPalette: () => {}, setVisible: () => {}, setState: () => {},
          setInteractive: () => {}, onClick: () => {},
          destroy: () => { root.remove(); },
        };
      },
    };
  });
  afterAll(() => {
    restoreDomGlobals(DOM_GLOBALS, saved);
  });

  it('each side\'s label counts its list: the player\'s 0x10000087, the partner\'s 0x10000080 — no burden / value sums (retail draws none; the y=89 rows are the lists\' bars)', () => {
    ui.showTradeWindow('Partner');
    ui.setTradeData({
      yourItems: [
        { name: 'Arrow', value: 10, guid: 0x80001111, burden: 5, iconDid: 0 },
        { name: 'Rock', value: 0, guid: 0x80001112, burden: 3, iconDid: 0 },
      ],
      theirItems: [
        { name: 'Gem', value: 100, guid: 0x80002222, burden: 2, iconDid: 0 },
      ],
      theirName: 'Partner', yourName: 'Me',
      partnerGuid: 0x50002222, initiatorGuid: 0x50000001,
      tradeStamp: 0, tradeStatus: 0, yourReady: false, theirReady: false,
    });
    expect(TEXTS.get(0x10000087)).toBe('Total Items: 2');
    expect(TEXTS.get(0x10000080)).toBe('Total Items: 1');
    expect([...TEXTS.values()].some((t) => /Burden|Value/.test(t))).toBe(false);
    expect(TEXTS.has(0x10000089)).toBe(false);
    expect(TEXTS.has(0x10000082)).toBe(false);
  });

  it('an empty table reads "Total Items: 0" on both sides (Reset calls both setters at PostInit)', () => {
    ui.showTradeWindow('Partner');
    ui.setTradeData({
      yourItems: [], theirItems: [],
      theirName: 'Partner', yourName: 'Me',
      partnerGuid: 0x50002222, initiatorGuid: 0x50000001,
      tradeStamp: 0, tradeStatus: 0, yourReady: false, theirReady: false,
    });
    expect([TEXTS.get(0x10000087), TEXTS.get(0x10000080)]).toEqual(['Total Items: 0', 'Total Items: 0']);
  });
});

describe('ACE source anchors for FAITHFUL.541 (citation check, not the primary behavioral verification above)', () => {
  it('WorldObject_Networking.cs ships Value and Burden as documented at the cited line ranges', () => {
    const lines = ACE_NET.split('\n');
    // Lines are 1-indexed in the doc comments above; slice is inclusive.
    const valueBlock = lines.slice(98, 100).join('\n');
    const burdenBlock = lines.slice(155, 157).join('\n');
    expect(valueBlock).toMatch(/Value/);
    expect(burdenBlock).toMatch(/Burden/);
  });
});
