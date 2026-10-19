/**
 * BOOT.notice-plate — the pre-DAT screens (the capability screen and a failed
 * game-data download) draw on one plate that reproduces the retail OK message
 * dialog (0x2100003C element 0x24, GameUI.buildMessageDialog) in CSS:
 * boot/BootNotice.ts.
 *
 *  1. Behaviour, on the real modules in happy-dom: the plate's text is the
 *     dialog text template's cream with its 0xFF110F07 outline, the button
 *     has the keyboard focus and answers, the plate sits above the boot
 *     loading overlay, the capability screen keeps its title and its
 *     Continue-anyway path (and a hard problem's only way out is Reload),
 *     and the download failure has a Reload button and never a raw error.
 *  2. The DAT (skipped without it): every colour the CSS uses is the pixel of
 *     the 0x21000042 plate / 0x21000040 button textures it cites, every size
 *     is 0x2100003C:0x24's, and the button label is the template's white.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { existsSync } from 'node:fs';
import { loadDomWindow, installDomGlobals, restoreDomGlobals } from './_harness/dom.js';
import { openDat, DAT_PATHS } from './_harness/dat.js';
import { DIALOG_TEXT_TEMPLATE } from '../packages/renderer/src/ui/ConnectionNotices.js';
import { cssFromArgb } from '../packages/renderer/src/ui/DatTextStyle.js';
import { ZLayer, zLayer } from '../packages/renderer/src/ui/ZIndexRegistry.js';
import {
  BOOT_NOTICE_COLORS, BOOT_NOTICE_GEOMETRY, BOOT_NOTICE_BUTTON_LABEL_ARGB, cssRgbaFromArgb, outlineTextShadow, buttonFace,
  type DatPixelColor,
} from '../packages/renderer/src/boot/BootNotice.js';
import { patchFailureText, PATCH_FAILURE_GENERIC_TEXT } from '../packages/renderer/src/ui/PatchScreen.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const domWindow: any = await loadDomWindow({ innerWidth: 1280, innerHeight: 720 });
const DOM_GLOBALS = ['window', 'document', 'HTMLElement', 'Node', 'Event', 'MouseEvent', 'KeyboardEvent'] as const;

/** happy-dom normalises colours in inline styles; compare through the same parser. */
function normColor(css: string): string {
  const el = domWindow.document.createElement('div');
  el.style.color = css;
  return el.style.color;
}

describe('BOOT.notice-plate — the boot notice plate (behaviour)', () => {
  const saved: Partial<Record<(typeof DOM_GLOBALS)[number], unknown>> = {};
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let showBootNotice: any;
  let showCapabilityScreen: any;
  let capabilityProblems: any;
  let showPatchFailureNotice: any;
  let createLoadingOverlay: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const ok = { webgl2: true, websocket: true, deviceMemoryGb: 8, finePointer: true };

  beforeAll(async () => {
    installDomGlobals(domWindow, DOM_GLOBALS, saved, 'functions');
    ({ showBootNotice } = await import('../packages/renderer/src/boot/BootNotice.js'));
    ({ showCapabilityScreen, capabilityProblems } = await import('../packages/renderer/src/boot/Capability.js'));
    ({ showPatchFailureNotice } = await import('../packages/renderer/src/ui/PatchScreen.js'));
    ({ createLoadingOverlay } = await import('../packages/renderer/src/ui/LoadingOverlay.js'));
  });
  afterAll(() => restoreDomGlobals(DOM_GLOBALS, saved));
  afterEach(() => { domWindow.document.body.innerHTML = ''; });

  const doc = (): Document => domWindow.document as Document;

  it('the plate is the OK dialog: 400 wide, the template\'s cream centred text with its 0xFF110F07 outline, above the loading overlay', () => {
    const overlay = createLoadingOverlay() as HTMLElement;
    doc().body.appendChild(overlay);
    let clicked = 0;
    const n = showBootNotice(doc(), { id: 'n1', paragraphs: [{ text: 'Hello' }], buttons: [{ label: 'OK', onClick: () => { clicked++; } }] });
    expect(n.root.parentElement).toBe(doc().body);
    expect(n.root.style.zIndex).toBe(zLayer(ZLayer.BOOT_NOTICE));
    expect(Number(n.root.style.zIndex)).toBeGreaterThan(Number(overlay.style.zIndex));
    expect(n.plate.style.width).toBe(`${BOOT_NOTICE_GEOMETRY.plateWidth}px`);
    expect(n.plate.style.minHeight).toBe(`${BOOT_NOTICE_GEOMETRY.plateBaseHeight}px`);
    expect(normColor(n.plate.style.color)).toBe(normColor(cssFromArgb(DIALOG_TEXT_TEMPLATE.colorArgb)));
    expect(DIALOG_TEXT_TEMPLATE.outline).toBe(true);
    expect(n.plate.style.textShadow).toBe(outlineTextShadow(DIALOG_TEXT_TEMPLATE.outlineColorArgb));
    expect(n.plate.style.textShadow).toContain(cssFromArgb(0xFF110F07));
    expect(n.plate.style.textAlign).toBe('center');
    expect(n.plate.style.backgroundColor).toBe(normColor(cssRgbaFromArgb(BOOT_NOTICE_COLORS.plateFill.argb)));
    expect(n.plate.textContent).toContain('Hello');
    // The button: focused for the keyboard, the template's white label, the normal face, then the pressed one.
    const btn = n.buttons[0] as HTMLButtonElement;
    expect(doc().activeElement).toBe(btn);
    expect(btn.style.minWidth).toBe(`${BOOT_NOTICE_GEOMETRY.buttonWidth}px`);
    expect(btn.style.height).toBe(`${BOOT_NOTICE_GEOMETRY.buttonHeight}px`);
    expect(normColor(btn.style.color)).toBe(normColor(cssFromArgb(BOOT_NOTICE_BUTTON_LABEL_ARGB)));
    expect(btn.dataset.pressed).toBe('0');
    btn.dispatchEvent(new domWindow.MouseEvent('mousedown'));
    expect(btn.dataset.pressed).toBe('1');
    expect(btn.style.textShadow).not.toBe('none');
    btn.dispatchEvent(new domWindow.MouseEvent('mouseup'));
    expect(btn.dataset.pressed).toBe('0');
    btn.click();
    expect(clicked).toBe(1);
    n.close();
    expect(doc().getElementById('n1')).toBeNull();
  });

  it('the button faces carry the DAT ring and fill colours', () => {
    const normal = buttonFace(false);
    const pressed = buttonFace(true);
    for (const c of BOOT_NOTICE_COLORS.buttonRing) expect(normal.boxShadow).toContain(cssRgbaFromArgb(c.argb));
    expect(normal.background).toContain(cssRgbaFromArgb(BOOT_NOTICE_COLORS.buttonFill.argb));
    expect(normal.background).toContain(cssRgbaFromArgb(BOOT_NOTICE_COLORS.buttonHighlight.argb));
    expect(pressed.background).toContain(cssRgbaFromArgb(BOOT_NOTICE_COLORS.pressedFill.argb));
    expect(pressed.background).not.toBe(normal.background);
  });

  it('capability, hard problem: the title line, the problem, and Reload as the only way out (no Continue)', () => {
    const reloads: number[] = [];
    let resolved = false;
    void showCapabilityScreen(doc(), capabilityProblems({ ...ok, webgl2: false }), () => reloads.push(1)).then(() => { resolved = true; });
    const screen = doc().getElementById('capability-screen')!;
    expect(screen.classList.contains('boot-notice')).toBe(true);
    expect(screen.querySelector('.boot-notice-title')?.textContent).toBe('This browser can\'t run the game');
    expect(screen.querySelector('.capability-webgl2')?.textContent).toMatch(/WebGL 2/);
    expect(screen.querySelector('.capability-continue')).toBeNull();
    const reload = screen.querySelector('.capability-reload') as HTMLButtonElement;
    expect(reload.textContent).toBe('Reload');
    expect(doc().activeElement).toBe(reload);
    reload.click();
    expect(reloads).toEqual([1]);
    expect(resolved).toBe(false);
  });

  it('capability, soft problem: "Before you continue", Continue anyway focused, and it hands the page back', async () => {
    const prompt = showCapabilityScreen(doc(), capabilityProblems({ ...ok, deviceMemoryGb: 2, finePointer: false }));
    const screen = doc().getElementById('capability-screen')!;
    expect(screen.querySelector('.boot-notice-title')?.textContent).toBe('Before you continue');
    expect(screen.querySelectorAll('.capability-problem').length).toBe(2);
    const cont = screen.querySelector('.capability-continue') as HTMLButtonElement;
    expect(cont.textContent).toBe('Continue anyway');
    expect(doc().activeElement).toBe(cont);
    // Same plate as every other notice: the template cream.
    expect(normColor((screen.querySelector('.boot-notice-plate') as HTMLElement).style.color)).toBe(normColor(cssFromArgb(DIALOG_TEXT_TEMPLATE.colorArgb)));
    cont.click();
    await prompt;
    expect(doc().getElementById('capability-screen')).toBeNull();
  });

  it('download failure: the text on the plate over the splash (clear backdrop), a focused Reload button, one plate at a time', () => {
    const overlay = createLoadingOverlay() as HTMLElement;
    doc().body.appendChild(overlay);
    const reloads: number[] = [];
    showPatchFailureNotice(doc(), 'first', () => reloads.push(1));
    const n = showPatchFailureNotice(doc(), patchFailureText(new TypeError('Failed to fetch')), () => reloads.push(2));
    expect(doc().querySelectorAll('#patch-failure').length).toBe(1);
    expect(n.root.style.background).toBe('transparent');
    expect(Number(n.root.style.zIndex)).toBeGreaterThan(Number(overlay.style.zIndex));
    expect(n.root.querySelector('.patch-failure-text')?.textContent).toBe('Could not reach the game data server. Check your connection and reload.');
    const reload = n.root.querySelector('.patch-failure-reload') as HTMLButtonElement;
    expect(reload.textContent).toBe('Reload');
    expect(doc().activeElement).toBe(reload);
    reload.click();
    expect(reloads).toEqual([2]);
  });
});

describe('BOOT.notice-plate — a fatal boot error never shows its raw message', () => {
  it('an unknown error reads as the generic game-data text', () => {
    expect(patchFailureText(new Error('WebGL2 unavailable'))).toBe(PATCH_FAILURE_GENERIC_TEXT);
    expect(patchFailureText(new RangeError('Offset is outside the bounds of the DataView'))).toBe(PATCH_FAILURE_GENERIC_TEXT);
    expect(patchFailureText('weird')).toBe(PATCH_FAILURE_GENERIC_TEXT);
    expect(PATCH_FAILURE_GENERIC_TEXT).toBe('The game data couldn\'t be loaded. Check your connection and reload.');
    expect(patchFailureText(new Error('x'))).not.toMatch(/^Error:/);
  });
});

const hasDats = existsSync(DAT_PATHS.portal) && existsSync(DAT_PATHS.local);

describe.skipIf(!hasDats)('BOOT.notice-plate — every colour and size is the DAT\'s', () => {
  /* eslint-disable @typescript-eslint/no-explicit-any */
  let pixel: (c: DatPixelColor) => number;
  let okDialog: any;
  let buttonTemplate: any;
  let textStyleFromDesc: any;
  /* eslint-enable @typescript-eslint/no-explicit-any */

  beforeAll(async () => {
    const dat = await import('@ac/dat-parser');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { Texture } = await import('../packages/dat-parser/src/file-types/Texture.js');
    ({ textStyleFromDesc } = await import('../packages/renderer/src/ui/DatTextStyle.js'));
    const portal = openDat(DAT_PATHS.portal);
    const local = openDat(DAT_PATHS.local);
    dat.setMasterPropertyTypes(dat.parseMasterProperty(portal.getReader(0x39000001)));
    okDialog = dat.parseLayoutDesc(local.getReader(0x2100003c)).elements.get(0x24);
    buttonTemplate = dat.parseLayoutDesc(local.getReader(0x21000040)).elements.get(0x100002cd);
    const decoded = new Map<number, { data: Uint8Array; width: number }>();
    pixel = (c) => {
      let t = decoded.get(c.texture);
      if (!t) {
        const bytes = portal.getFileData(c.texture);
        if (!bytes) throw new Error(`texture 0x${c.texture.toString(16)} missing`);
        t = Texture.read(new DatReader(bytes)).toRGBA() as unknown as { data: Uint8Array; width: number };
        decoded.set(c.texture, t);
      }
      const i = (c.y * t.width + c.x) * 4;
      return ((t.data[i + 3] << 24) | (t.data[i] << 16) | (t.data[i + 1] << 8) | t.data[i + 2]) >>> 0;
    };
  });

  it('each plate and button colour is its cited texture pixel', () => {
    const all: DatPixelColor[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) { v.forEach(walk); return; }
      if (v && typeof v === 'object' && 'texture' in v) { all.push(v as DatPixelColor); return; }
      if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(BOOT_NOTICE_COLORS);
    expect(all.length).toBeGreaterThanOrEqual(20);
    for (const c of all) {
      expect(pixel(c).toString(16), `0x${c.texture.toString(16)} (${c.x},${c.y})`).toBe((c.argb >>> 0).toString(16));
    }
  });

  it('the cited textures are the dialog chrome the in-game OK dialog draws (plate 0x3d on 0x21000042:0x100002af, button 0x26 on 0x21000040:0x100002cd)', () => {
    const plate = okDialog.children.get(0x3d);
    expect([plate.baseLayout, plate.baseElement]).toEqual([0x21000042, 0x100002af]);
    const btn = plate.children.get(0x10000338).children.get(0x26);
    expect([btn.baseLayout, btn.baseElement]).toEqual([0x21000040, 0x100002cd]);
    // The middle slice of the normal / pressed faces (CORE.17.k.b.b.c.b's art table).
    const middle = buttonTemplate.children.get(0x100002cf);
    const file = (stateId: number) => middle.states.get(stateId)?.media?.find((m: { file?: number }) => m.file !== undefined)?.file;
    expect(file(0x1)).toBe(BOOT_NOTICE_COLORS.buttonFill.texture);
    expect(file(0x3)).toBe(BOOT_NOTICE_COLORS.pressedFill.texture);
  });

  it('the geometry is 0x2100003C:0x24\'s: plate 400x95, text 0x3e at (15,15) 370x18, row at y 48, OK 80x32 centred', () => {
    const G = BOOT_NOTICE_GEOMETRY;
    const plate = okDialog.children.get(0x3d);
    expect([plate.width, plate.height]).toEqual([G.plateWidth, G.plateBaseHeight]);
    const text = plate.children.get(0x3e);
    expect([text.x, text.y, text.width, text.height]).toEqual([G.inset, G.inset, G.textWidth, G.lineHeight]);
    const row = plate.children.get(0x10000338);
    expect(row.y).toBe(G.buttonRowY);
    expect(G.plateBaseHeight - row.y - row.height).toBe(G.inset);
    const btn = row.children.get(0x26);
    expect([btn.width, btn.height]).toEqual([G.buttonWidth, G.buttonHeight]);
    expect(btn.x).toBe((G.plateWidth - G.buttonWidth) / 2);
  });

  it('the button label is the template\'s white, outlined in black only while pressed', () => {
    expect(textStyleFromDesc(buttonTemplate, 0x1).colorArgb >>> 0).toBe(BOOT_NOTICE_BUTTON_LABEL_ARGB);
    expect(textStyleFromDesc(buttonTemplate, 0x1).outline).toBe(false);
    expect(textStyleFromDesc(buttonTemplate, 0x3).outline).toBe(true);
    expect(textStyleFromDesc(buttonTemplate, 0x3).outlineColorArgb >>> 0).toBe(0xFF000000);
  });
});

describe('cssRgbaFromArgb', () => {
  it('opaque colours are rgb(); translucent ones carry their alpha', () => {
    expect(cssRgbaFromArgb(0xFF110F07)).toBe('rgb(17, 15, 7)');
    expect(cssRgbaFromArgb(0x80FF0000)).toBe('rgba(255, 0, 0, 0.502)');
    expect(cssRgbaFromArgb(0x00000000)).toBe('rgba(0, 0, 0, 0)');
  });
});
