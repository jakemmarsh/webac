/**
 * GAP.indicator-bar-interactive (mini-game panel) — GameUI's chess board
 * (gmMiniGameUI, LayoutDesc 0x2100001e root 0x1000016a) driven through the
 * real GameUI against a stub LayoutRenderer: BeginGame opens it and joins,
 * the server notices draw the pieces from the list box's p0x10000021 DID
 * array, a click-select + click-move sends Event_Move through chessActions,
 * toggleMiniGamePanel closes / reopens it, EndGame hides it and ghosts the
 * indicator. A DAT-gated block checks the layout ids and art the panel reads.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import type { LayoutHandle, PanelHandle, PanelOptions } from '../packages/renderer/src/ui/LayoutRenderer.js';
import { chessListIndex } from '../packages/renderer/src/ui/MiniGameChess.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1024, innerHeight: 768 });
const DOM_GLOBALS = ['window', 'document', 'localStorage', 'HTMLElement', 'Node', 'Event', 'MouseEvent'] as const;

const PIECE_DIDS = Array.from({ length: 12 }, (_, i) => 0x06004cfd + i);
const OVERLAY_DID = 0x06004d09;
const BOARD = 0x7a0000aa;

interface StubState {
  renderCalls: Array<{ layoutId: number; opts?: PanelOptions }>;
  hidden: Set<number>;
  clicks: Map<number, () => void>;
  closed: number;
}

function makeStubRenderer(doc: Document, st: StubState) {
  return {
    applyMediaToElement: (el: HTMLElement, media: Array<{ file?: number }>) => {
      const f = media.find((m) => m.file)?.file;
      if (f) el.style.backgroundImage = `url(tex-${f.toString(16)})`;
    },
    renderPanel: (layoutId: number, parent: Element, opts?: PanelOptions): PanelHandle => {
      st.renderCalls.push({ layoutId, opts });
      const root = doc.createElement('div');
      const listBox = doc.createElement('div');
      root.appendChild(listBox);
      parent.appendChild(root);
      const elements = new Map<number, HTMLElement>([[0x10000174, listBox]]);
      const descs = new Map<number, unknown>([
        [0x1000016a, { elementId: 0x1000016a, width: 300, height: 362 }],
        [0x10000174, {
          elementId: 0x10000174,
          properties: new Map<number, unknown>([
            [95, { valueInt: 8 }],
            [0x10000021, { valueArray: PIECE_DIDS.map((d) => ({ valueDataFile: d })) }],
          ]),
        }],
      ]);
      const template = {
        elementId: 0x10000178, width: 32, height: 32,
        children: new Map([[0x10000179, { elementId: 0x10000179, x: 0, y: 0, width: 32, height: 32, media: [{ type: 5, file: OVERLAY_DID }] }]]),
      };
      const handle = {
        root,
        layout: { elements: new Map([[0x10000178, template]]) } as unknown as LayoutHandle['layout'],
        elements,
        descs: descs as unknown as LayoutHandle['descs'],
        setText: () => {},
        setFill: () => {},
        setVisible: (id: number, v: boolean) => { if (v) st.hidden.delete(id); else st.hidden.add(id); },
        setState: () => {},
        setPalette: () => {},
        setInteractive: (id: number, h?: (...args: unknown[]) => void) => { if (h) st.clicks.set(id, () => h()); },
        setScrollable: () => ({}) as ReturnType<LayoutHandle['setScrollable']>,
        setDraggable: () => {},
        setDropTarget: () => {},
        destroy: () => { root.remove(); },
        onClick: () => {},
        moveTo: () => {},
        close: () => { st.closed++; root.remove(); },
        bringToFront: () => {},
      };
      return handle as unknown as PanelHandle;
    },
  };
}

describe('GameUI chess panel (gmMiniGameUI, layout 0x2100001e)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let GameUICtor: any;

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved);
    GameUICtor = (await import('../packages/renderer/src/ui/GameUI.js')).GameUI;
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));

  function setup() {
    const st: StubState = { renderCalls: [], hidden: new Set(), clicks: new Map(), closed: 0 };
    const container = domWindow.document.createElement('div');
    domWindow.document.body.appendChild(container);
    const ui = new GameUICtor(container, {}, undefined, undefined, undefined, undefined, undefined, makeStubRenderer(domWindow.document, st));
    const sent: string[] = [];
    const chat: string[] = [];
    const indicator: boolean[] = [];
    ui.addSystemMessage = (t: string) => { chat.push(t); };
    ui.chessActions = {
      join: (b: number) => sent.push(`join 0x${b.toString(16)}`),
      move: (a: number, b: number, c: number, d: number) => sent.push(`move ${a},${b}->${c},${d}`),
      movePass: () => sent.push('pass'),
      quit: () => sent.push('quit'),
      stalemate: (on: boolean) => sent.push(`stalemate ${on}`),
    };
    ui.onMiniGameIndicatorChange = (on: boolean) => indicator.push(on);
    const cells = (): HTMLElement[] => Array.from(container.querySelectorAll('[data-chess-index]')) as HTMLElement[];
    return { ui, st, sent, chat, indicator, cells, container };
  }

  it('BeginGame opens the DAT panel, joins, and enables the indicator', () => {
    const { ui, st, sent, chat, indicator, cells } = setup();
    ui.onMiniGameBegin(BOARD);
    expect(st.renderCalls).toHaveLength(1);
    expect(st.renderCalls[0].layoutId).toBe(0x2100001e);
    expect(st.renderCalls[0].opts?.subtreeElementId).toBe(0x1000016a);
    expect(st.renderCalls[0].opts?.closeButtonId).toBe(0x1000016b);
    expect(ui.isMiniGamePanelOpen()).toBe(true);
    expect(sent).toEqual([`join 0x${BOARD.toString(16)}`]);
    expect(chat).toEqual(['Attempting to join game, please wait...']);
    expect(indicator).toEqual([true]);
    // PostInit: Pass hidden, Resign + Stalemate live.
    expect(st.hidden.has(0x10000176)).toBe(true);
    expect(st.clicks.has(0x10000175)).toBe(true);
    expect(st.clicks.has(0x10000177)).toBe(true);
    // 64 list-box items, empty until the join resets the board.
    expect(cells()).toHaveLength(64);
    expect(cells().filter((c) => c.dataset.chessPiece)).toHaveLength(0);
  });

  it('renders the pieces from the DID array after the join and moves by click', () => {
    const { ui, sent, chat, cells } = setup();
    ui.onMiniGameBegin(BOARD);
    ui.onChessJoinGameResponse(BOARD, 0);
    ui.onChessStartGame(BOARD, 0);
    const c = cells();
    expect(c.filter((e) => e.dataset.chessPiece)).toHaveLength(32);
    // White's a1 rook (DID index 3) is drawn at item 56; black's e8 king (index 11) at item 4.
    expect(c[56].dataset.chessPiece).toBe(`0x${PIECE_DIDS[3].toString(16)}`);
    expect(c[56].style.backgroundImage).toContain(PIECE_DIDS[3].toString(16));
    expect(c[chessListIndex(4, 7, 0)].dataset.chessPiece).toBe(`0x${PIECE_DIDS[11].toString(16)}`);

    const overlay = (i: number) => c[i].querySelector('[data-chess-selected]') as HTMLElement;
    expect(overlay(0).style.backgroundImage).toContain(OVERLAY_DID.toString(16));
    c[chessListIndex(4, 1, 0)].dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(overlay(chessListIndex(4, 1, 0)).style.display).toBe('block');
    c[chessListIndex(4, 3, 0)].dispatchEvent(new domWindow.MouseEvent('click', { bubbles: true }));
    expect(sent).toContain('move 4,1->4,3');
    expect(chat).toContain('Move in progress.');
    expect(c[chessListIndex(4, 3, 0)].dataset.chessPiece).toBe(`0x${PIECE_DIDS[0].toString(16)}`);
    expect(c[chessListIndex(4, 1, 0)].dataset.chessPiece).toBeUndefined();

    ui.onChessMoveResponse(BOARD, 1);
    ui.onChessOpponentTurn(BOARD, { x: 3, y: 6 }, { x: 3, y: 4 });
    expect(c[chessListIndex(3, 4, 0)].dataset.chessPiece).toBe(`0x${PIECE_DIDS[6].toString(16)}`);
    expect(chat[chat.length - 1]).toBe('It is your turn to move.');
    expect(ui.getMiniGameState()).toEqual({ state: 3, gameId: BOARD, team: 0 });
  });

  it('toggleMiniGamePanel closes and reopens with the board intact', () => {
    const { ui, st, cells } = setup();
    ui.onMiniGameBegin(BOARD);
    ui.onChessJoinGameResponse(BOARD, 1);
    ui.toggleMiniGamePanel();
    expect(ui.isMiniGamePanelOpen()).toBe(false);
    expect(st.closed).toBe(1);
    expect(cells()).toHaveLength(0);
    ui.toggleMiniGamePanel();
    expect(ui.isMiniGamePanelOpen()).toBe(true);
    expect(cells().filter((e) => e.dataset.chessPiece)).toHaveLength(32);
    // Black's view: its own h8 rook (DID index 9) sits at the bottom-right item 63.
    expect(cells()[63].dataset.chessPiece).toBe(`0x${PIECE_DIDS[9].toString(16)}`);
  });

  it('resign confirms, quits, hides the panel and ghosts the indicator (EndGame)', () => {
    const { ui, st, sent, indicator } = setup();
    ui.showConfirmationDialog = (_t: string, cb: (ok: boolean) => void) => cb(true);
    ui.onMiniGameBegin(BOARD);
    ui.onChessJoinGameResponse(BOARD, 0);
    st.clicks.get(0x10000175)!();
    expect(sent).toContain('quit');
    expect(ui.isMiniGamePanelOpen()).toBe(false);
    expect(indicator).toEqual([true, false]);
    expect(ui.getMiniGameState().gameId).toBe(0);
  });

  it('the stalemate button toggles the offer', () => {
    const { ui, st, sent } = setup();
    ui.onMiniGameBegin(BOARD);
    ui.onChessJoinGameResponse(BOARD, 0);
    st.clicks.get(0x10000177)!();
    st.clicks.get(0x10000177)!();
    expect(sent.filter((s) => s.startsWith('stalemate'))).toEqual(['stalemate true', 'stalemate false']);
  });
});

const REPO = resolve(__dirname, '..');
const LOCAL_DAT = resolve(REPO, 'dat/client_local_English.dat');
const PORTAL_DAT = resolve(REPO, 'dat/client_portal.dat');

describe.skipIf(!existsSync(LOCAL_DAT) || !existsSync(PORTAL_DAT))('LayoutDesc 0x2100001e carries what the panel reads', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let layout: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let portal: any;

  beforeAll(async () => {
    const dp = await import('../packages/dat-parser/src/index.js');
    const open = (p: string) => {
      const b = readFileSync(p);
      return new dp.DatDatabase(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength));
    };
    portal = open(PORTAL_DAT);
    const local = open(LOCAL_DAT);
    dp.setMasterPropertyTypes(dp.parseMasterProperty(new dp.DatReader(portal.getFileData(0x39000001)!)));
    const raw = dp.parseLayoutDesc(new dp.DatReader(local.getFileData(0x2100001e)!));
    layout = dp.resolveLayoutDesc(raw, (id: number) => {
      const d = local.getFileData(id);
      return d ? dp.parseLayoutDesc(new dp.DatReader(d)) : null;
    });
  });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const find = (els: Map<number, any>, id: number): any => {
    for (const [, e] of els) {
      if (e.elementId === id) return e;
      const hit = find(e.children, id);
      if (hit) return hit;
    }
    return null;
  };

  it('root, list box, piece DIDs, 8 per row, selection overlay, buttons', () => {
    const root = find(layout.elements, 0x1000016a);
    expect(root).toMatchObject({ width: 300, height: 362 });
    const list = find(layout.elements, 0x10000174);
    expect(list).toMatchObject({ width: 256, height: 256 });
    expect(list.properties.get(95).valueInt).toBe(8);
    const dids = list.properties.get(0x10000021).valueArray.map((v: { valueDataFile: number }) => v.valueDataFile);
    expect(dids).toEqual(PIECE_DIDS);
    const template = layout.elements.get(0x10000178);
    expect(template).toMatchObject({ width: 32, height: 32 });
    expect(template.children.get(0x10000179).media[0].file).toBe(OVERLAY_DID);
    for (const id of [0x1000016b, 0x1000016c, 0x10000175, 0x10000176, 0x10000177]) {
      expect(find(root.children, id)).toBeTruthy();
    }
    for (const did of [...PIECE_DIDS, OVERLAY_DID, list.media[0].file]) {
      expect(portal.getFileData(did)).toBeTruthy();
    }
  });
});
