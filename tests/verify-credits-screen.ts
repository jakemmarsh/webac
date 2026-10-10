/**
 * RECON.charselect-dat-controls.a — the char-select CREDITS button opens the
 * retail Credits screen (gmCreditsUI, UI mode 0x10000005, layout 0x21000003)
 * instead of an external wiki tab.
 *
 * - the model: Initialize's `ID_Credits%d` loop + m_duration, ScrollText's
 *   clamp/ftol, ScrollPictures' placement and SmartArray unordered remove;
 * - the DAT ground truth the screen reads (UILAYOUT 0x10000004, the text /
 *   picture fields' attributes, the string tables, the 400x300 JPEGs);
 * - the real GameUI under happy-dom with a real LayoutRenderer: CREDITS shows
 *   the screen in the char-select frame, Escape / Return leave, a click does not.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { DAT_PATHS, openDat } from './_harness/dat.js';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';
import {
  CreditsPictureColumn, CreditsScroll, creditsDuration, creditsStringId, creditsUseAltVariant, readCreditsText,
  CREDITS_LAYOUT, EL_CREDITS_PICTURE_FIELD, EL_CREDITS_TEXT_FIELD,
} from '../packages/renderer/src/ui/CreditsScreen.js';
import { acStringHash } from '../packages/dat-parser/src/file-types/LayoutDesc.js';

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe('gmCreditsUI model', () => {
  it('Initialize appends ID_Credits1.. until the first missing id; the strings are one text', () => {
    expect(creditsStringId(1)).toBe(acStringHash('ID_Credits1'));
    const table = new Map<number, string>([
      [creditsStringId(1), 'PRODUCER\n'],
      [creditsStringId(2), '\n'],
      [creditsStringId(3), 'Lead '],
      [creditsStringId(4), 'Designer\n'],
      [creditsStringId(6), 'never reached\n'],
    ]);
    const { lines, entryCount } = readCreditsText((id) => table.get(id) ?? null);
    expect(entryCount).toBe(4);
    expect(lines).toEqual(['PRODUCER', '', 'Lead Designer']);
  });

  it('m_duration = (fieldH + textH) / ((textH / n + fieldH) / speed), n = entries + 1', () => {
    // 2345 entries, 16 px rows: (600 + 37520) / ((37520 / 2346 + 600) / 20).
    const d = creditsDuration(600, 37520, 2345, 20);
    expect(d).toBeCloseTo((600 + 37520) / ((37520 / 2346 + 600) / 20), 9);
    expect(d).toBeGreaterThan(1200);
    expect(d).toBeLessThan(1300);
  });

  it('ScrollText: starts below the field, rises by ftol(t·(fieldH+textH)), ends at t = 1', () => {
    const s = new CreditsScroll(600, 400, 9, 1, 100);
    expect(s.duration).toBeCloseTo(1000 / ((400 / 10 + 600) / 1), 9);
    expect(s.textY).toBe(600);
    const half = s.update(100 + s.duration / 2);
    expect(half.done).toBe(false);
    expect(s.textY).toBe(600 - Math.trunc(0.5 * 1000));
    expect(half.delta).toBe(500);
    const before = s.update(99); // clamped at t = 0
    expect(s.textY).toBe(600);
    expect(before.delta).toBe(-500);
    expect(s.update(100 + s.duration * 2).done).toBe(true);
  });

  it('ScrollPictures: first at fieldH + 1, the next directly below, cycling the list', () => {
    const added: number[] = [];
    const col = new CreditsPictureColumn([0xa, 0xb, 0xc], 600, () => 300, (p) => added.push(p.id));
    col.scroll(0);
    expect(col.pictures.map(p => [p.id, p.y])).toEqual([[0xa, 601]]);
    col.scroll(0); // last top (601) is not above the bottom (600): nothing new
    expect(col.pictures).toHaveLength(1);
    col.scroll(2);
    expect(col.pictures.map(p => [p.id, p.y])).toEqual([[0xa, 599], [0xb, 899]]);
    col.scroll(300);
    expect(col.pictures.map(p => [p.id, p.y])).toEqual([[0xa, 299], [0xb, 599], [0xc, 899]]);
    col.scroll(300);
    expect(col.pictures.map(p => p.id)).toEqual([0xa, 0xb, 0xc, 0xa]);
    expect(added).toEqual([0xa, 0xb, 0xc, 0xa]);
  });

  it('the first slot leaves once its bottom is above the field, by SmartArray unordered remove', () => {
    const removed: number[] = [];
    const col = new CreditsPictureColumn([1, 2, 3, 4, 5, 6], 600, () => 300, () => {}, (p) => removed.push(p.id));
    col.scroll(0);
    for (let i = 0; i < 3; i++) col.scroll(300);
    expect(col.pictures.map(p => [p.id, p.y])).toEqual([[1, -299], [2, 1], [3, 301], [4, 601]]);
    col.scroll(1); // picture 1's ScreenY1 = -300 + 299 = -1 < 0
    expect(removed).toEqual([1]);
    // Slot 0 now holds the old last slot; the new last (3, top 300) asks for one more below IT.
    expect(col.pictures.map(p => [p.id, p.y])).toEqual([[4, 600], [2, 0], [3, 300], [5, 600]]);
  });

  it('the hidden variant needs Alt + Ctrl + Shift together', () => {
    expect(creditsUseAltVariant({ altKey: true, ctrlKey: true, shiftKey: true })).toBe(true);
    expect(creditsUseAltVariant({ altKey: true, ctrlKey: true })).toBe(false);
    expect(creditsUseAltVariant(undefined)).toBe(false);
  });
});

describe.skipIf(!hasDats)('gmCreditsUI DAT ground truth', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dat: any;
  beforeAll(async () => {
    dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
  });

  it('UILAYOUT enum 0x10000004 is layout 0x21000003 "credits"', async () => {
    const { readDidMapper } = await import('../packages/dat-parser/src/file-types/DidMapper.js');
    const m = readDidMapper(openDat(DAT_PATHS.portal).getReader(0x2500000e)!);
    expect(m.client.enumToId.get(0x10000004)).toBe(CREDITS_LAYOUT);
    expect(m.client.enumToName.get(0x10000004)).toBe('credits');
  });

  it('the text field reads table 0x23000008 at speed 20; the picture field lists seven 400x300 JPEGs', () => {
    const layout = dat.parseLayoutDesc(openDat(DAT_PATHS.local).getReader(CREDITS_LAYOUT));
    const text = layout.elements.get(EL_CREDITS_TEXT_FIELD);
    expect([text.x, text.y, text.width, text.height]).toEqual([400, 0, 400, 600]);
    expect(text.properties.get(0x10000003).valueDataFile).toBe(0x23000008);
    expect(text.properties.get(0x10000004).valueFloat).toBe(20);
    const pics = layout.elements.get(EL_CREDITS_PICTURE_FIELD);
    const ids = pics.properties.get(0x10000005).valueArray.map((v: { valueDataFile: number }) => v.valueDataFile);
    expect(ids).toEqual([0x06005f14, 0x06005f15, 0x06005f16, 0x06005f17, 0x06005f18, 0x06005f19, 0x06005f1a]);
    const portal = openDat(DAT_PATHS.portal);
    for (const id of ids) {
      const bytes = new Uint8Array(portal.getFileData(id)!);
      const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      expect(v.getUint32(16, true)).toBe(500); // PFID_CUSTOM_RAW_JPEG
      // The JPEG's largest SOF frame (the file also embeds a 128x96 thumbnail).
      let w = 0; let h = 0;
      for (let i = 20; i < bytes.length - 8; i++) {
        if (bytes[i] === 0xff && (bytes[i + 1] === 0xc0 || bytes[i + 1] === 0xc2)) {
          const fh = (bytes[i + 5] << 8) | bytes[i + 6]; const fw = (bytes[i + 7] << 8) | bytes[i + 8];
          if (fw * fh > w * h) { w = fw; h = fh; }
        }
      }
      expect([w, h]).toEqual([400, 300]);
    }
  });

  it('table 0x23000008 holds ID_Credits1..2345; the hidden table 0x23000009 1..1831', () => {
    for (const [tableId, count] of [[0x23000008, 2345], [0x23000009, 1831]] as const) {
      const t = dat.parseStringTable(openDat(DAT_PATHS.local).getReader(tableId));
      const byId = new Map<number, string>(t.entries.map((e: { id: number; strings: string[] }) => [e.id, e.strings[0]]));
      const { entryCount } = readCreditsText((id) => byId.get(id) ?? null);
      expect(entryCount).toBe(count);
    }
  });
});

describe.skipIf(!hasDats)('CREDITS on the real GameUI (happy-dom + real LayoutRenderer)', () => {
  let fx: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let ui: any;
  const openSpy = vi.fn();

  beforeAll(async () => {
    fx = await mountGameUI();
    const dat = await import('@ac/dat-parser');
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    dat.registerStringTable(dat.parseStringTable(local.getReader(0x23000001)));
    const { LayoutRenderer } = await import('../packages/renderer/src/ui/LayoutRenderer.js');
    const tex = { getTextureDataURL: (id: number) => `data:tex-${id.toString(16)}`, getTextureDataURLWithAlpha: (id: number) => `data:tex-${id.toString(16)}` };
    ui = fx.ui;
    ui.layoutRenderer = new LayoutRenderer(local, tex as never, null);
    ui.getTexURL = (id: number) => `tex:${id.toString(16)}`;
    ui.loadFontRenderer = () => ({
      isReady: true, lineHeight: 16, outlinePadding: { x: 1, y: 1 },
      measureText: (t: string) => t.length * 8,
      measureWrappedText: (t: string, w: number) => ({ width: 0, height: 16, lines: Math.max(1, Math.ceil((t.length * 8) / w)) }),
      renderTextToCanvas: () => document.createElement('canvas'),
      renderWrappedTextToCanvas: () => document.createElement('canvas'),
    });
    (window as unknown as { open: unknown }).open = openSpy;
  });
  afterAll(() => fx?.teardown());

  function select(): HTMLElement {
    ui.showCharacterSelect([{ id: '1342177281', name: 'Alpha' }]);
    const btn = document.querySelector('[data-ac-press="21000004:100003a3"]') as HTMLElement;
    expect(btn).toBeTruthy();
    return btn;
  }
  const screen = (): HTMLElement | null => document.getElementById('credits-screen');
  const key = (k: string): void => { document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); };

  it('CREDITS shows the credits screen over the char-select frame, no external tab', () => {
    const btn = select();
    btn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(openSpy).not.toHaveBeenCalled();
    const s = screen();
    expect(s).toBeTruthy();
    expect(s!.dataset.acLayout).toBe('21000003');
    expect(document.getElementById('credits-text-field')!.dataset.acElement).toBe('10000410');
    expect(document.getElementById('credits-picture-field')!.dataset.acElement).toBe('10000413');
    // The whole of table 0x23000008, loaded on demand; the text starts below the field.
    expect(ui.creditsScreen.lineCount).toBeGreaterThan(2000);
    expect(ui.creditsScreen.textY).toBe(600);
    // Only the lines inside the field are drawn — none yet.
    expect(document.querySelectorAll('.credits-line').length).toBe(0);
    ui.creditsScreen.tick(performance.now() / 1000 + 60);
    expect(ui.creditsScreen.textY).toBeLessThan(600);
    const drawn = document.querySelectorAll('.credits-line').length;
    expect(drawn).toBeGreaterThan(0);
    expect(drawn).toBeLessThan(600 / 16 + 2);
    expect(document.querySelector('.credits-picture')!.getAttribute('data-ac-image')).toBe('6005f14');
    // A click is not an input-map-9 action.
    s!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(screen()).toBeTruthy();
    key('Escape');
    expect(screen()).toBeNull();
    expect(ui.creditsScreen).toBeNull();
  });

  it('Return leaves too, and other keys stay with the credits screen', () => {
    select().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const seen = vi.fn();
    document.addEventListener('keydown', seen);
    key('a');
    expect(seen).not.toHaveBeenCalled();
    expect(screen()).toBeTruthy();
    key('Enter');
    expect(screen()).toBeNull();
    key('a');
    expect(seen).toHaveBeenCalledTimes(1);
    document.removeEventListener('keydown', seen);
  });

  it('the end of the scroll returns to character management', () => {
    select().dispatchEvent(new MouseEvent('click', { bubbles: true }));
    const cs = ui.creditsScreen;
    cs.tick(performance.now() / 1000 + cs.duration + 1);
    expect(screen()).toBeNull();
    expect(document.querySelector('[data-ac-press="21000004:100003a3"]')).toBeTruthy();
  });

  it('Alt+Ctrl+Shift+click opens the hidden variant (0x10000412 / 0x10000414, table 0x23000009)', () => {
    select().dispatchEvent(new MouseEvent('click', { bubbles: true, altKey: true, ctrlKey: true, shiftKey: true }));
    expect(document.getElementById('credits-text-field')!.dataset.acElement).toBe('10000412');
    expect(document.getElementById('credits-picture-field')!.dataset.acElement).toBe('10000414');
    expect(ui.creditsScreen.lineCount).toBeGreaterThan(1500);
    key('Escape');
  });
});
