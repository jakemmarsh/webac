/**
 * The retail @framerate FPS meter (gmSmartBoxUI::UpdateFPSMeter @ 004d63a0 +
 * SceneTool::UpdateFPSCounter @ 0043e510). Spec:
 * docs/retail-commands/framerate-meter.md. Behavioural tests drive the real
 * FramerateMeter with a fake clock; the DAT block checks the shipped
 * fallback/ids against client_local_English.dat.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync } from 'node:fs';
import { openDat, DAT_PATHS } from './_harness/dat';
import { DatReader } from '../packages/dat-parser/src/DatReader';
import {
  parseStringTable, parseLayoutDesc, parseMasterProperty, setMasterPropertyTypes, registerStringTable,
  type ElementDesc, type LayoutDescData,
} from '../packages/dat-parser/src/file-types/LayoutDesc';
import {
  FramerateMeter, formatFramerateText, framerateMeterTemplate,
  FPS_STRING_ID, FPS_STRING_TABLE, FPS_TEMPLATE_FALLBACK, FPS_SAMPLE_COUNT,
  SMARTBOX_LAYOUT_ID, SMARTBOX_ELEMENT_ID, FPS_ELEMENT_ID, FPS_ELEMENT_RECT, FPS_FONT_ID, FPS_TEXT_COLOR_ARGB,
} from '../packages/renderer/src/ui/FramerateMeter';

/** Drive `n` frames `dt` seconds apart starting at `t0`; returns the last timestamp. */
function run(m: FramerateMeter, t0: number, dt: number, n: number): number {
  let t = t0;
  for (let i = 0; i < n; i++) { t += dt; m.frame(t); }
  return t;
}

describe('FramerateMeter — SceneTool::UpdateFPSCounter averaging', () => {
  it('starts at 0 fps and is hidden (fShowFramerate is bss false)', () => {
    const m = new FramerateMeter();
    expect(m.framesPerSecond).toBe(0);
    expect(m.shown).toBe(false);
    expect(m.text(0)).toBeNull();
  });

  it('computes the rate BEFORE storing the newest sample (one-frame lag)', () => {
    const m = new FramerateMeter();
    m.frame(10);            // first sample = 10 - m_LastFlipTime(0) = 10 s; rate from all-zero ring
    expect(m.framesPerSecond).toBe(0);
    m.frame(10.5);          // ring now holds [10]; rate = 20 / 10
    expect(m.framesPerSecond).toBe(2);
  });

  it('averages exactly the last 20 frame times: 20 / sum', () => {
    const m = new FramerateMeter();
    m.frame(0);                                  // sample 0 (flip time 0 → 0)
    const t = run(m, 0, 1 / 32, FPS_SAMPLE_COUNT); // ring fills with 1/32 s
    // Read before the 20th sample landed: 19 samples of 1/32 plus the 0 from frame(0).
    expect(m.framesPerSecond).toBeCloseTo(20 / (19 / 32), 3);
    m.frame(t + 1 / 32);
    expect(m.framesPerSecond).toBe(32);          // 20 × 1/32 = 0.625 → 32
  });

  it('a long hitch drags the meter down until it ages out 20 frames later', () => {
    const m = new FramerateMeter();
    let t = run(m, 0, 1 / 16, 25);
    expect(m.framesPerSecond).toBe(16);
    t += 1.0625; m.frame(t);                     // one 1.0625 s frame — not yet counted
    expect(m.framesPerSecond).toBe(16);
    t += 1 / 16; m.frame(t);                     // now counted: 20 / (19/16 + 1.0625) = 20 / 2.25
    expect(m.framesPerSecond).toBeCloseTo(20 / 2.25, 4);
    t = run(m, t, 1 / 16, 19);                   // still inside the window
    expect(m.framesPerSecond).toBeCloseTo(20 / 2.25, 4);
    t = run(m, t, 1 / 16, 1);                    // the hitch has been shifted out
    expect(m.framesPerSecond).toBe(16);
  });

  it('reports 0 while the frame-time sum is <= F_EPSILON (0.0002)', () => {
    const m = new FramerateMeter();
    m.frame(0); m.frame(0.0001); m.frame(0.0002);
    expect(m.framesPerSecond).toBe(0);           // ring sum 0.0001 <= 0.0002
  });
});

describe('FramerateMeter — gmSmartBoxUI::UpdateFPSMeter text', () => {
  it('formats "FPS: <fps>\\nDEG: <deg>" with precision 2, truncated', () => {
    const m = new FramerateMeter();
    run(m, 0, 1 / 32, 22);
    m.setShown(true);
    expect(m.text(0)).toBe('FPS: 32.00\nDEG: 0.00');
    expect(m.text(-0.15)).toBe('FPS: 32.00\nDEG: -0.15');
    expect(m.text(1)).toBe('FPS: 32.00\nDEG: 1.00');
  });

  it('truncates rather than rounds and groups thousands (StringInfoDataHelper::NumToString)', () => {
    expect(formatFramerateText(FPS_TEMPLATE_FALLBACK, 59.999, 0.129)).toBe('FPS: 59.99\nDEG: 0.12');
    expect(formatFramerateText(FPS_TEMPLATE_FALLBACK, 1234.5, 0)).toBe('FPS: 1,234.50\nDEG: 0.00');
  });

  it('updates every frame while shown and hides on setShown(false)', () => {
    const m = new FramerateMeter();
    m.setShown(true);
    let t = run(m, 0, 1 / 16, 22);
    expect(m.text(0)).toBe('FPS: 16.00\nDEG: 0.00');
    t = run(m, t, 1 / 32, 21);
    expect(m.text(0)).toBe('FPS: 32.00\nDEG: 0.00');
    m.setShown(false);
    expect(m.text(0)).toBeNull();
    run(m, t, 1 / 32, 1);                         // measurement keeps running while hidden
    expect(m.framesPerSecond).toBe(32);
  });

  it('uses the template fragments it is given, in fps-then-deg order', () => {
    const m = new FramerateMeter(['<', '|', '>']);
    run(m, 0, 1 / 16, 22);
    m.setShown(true);
    expect(m.text(0.5)).toBe('<16.00|0.50>');
  });
});

const HAVE_DATS = existsSync(DAT_PATHS.local) && existsSync(DAT_PATHS.portal);

describe.skipIf(!HAVE_DATS)('FramerateMeter — DAT ground truth', () => {
  let layout: LayoutDescData;
  beforeAll(() => {
    const portal = openDat(DAT_PATHS.portal);
    setMasterPropertyTypes(parseMasterProperty(new DatReader(portal.getFileData(0x39000001)!)));
    const local = openDat(DAT_PATHS.local);
    registerStringTable(parseStringTable(new DatReader(local.getFileData(FPS_STRING_TABLE)!)));
    layout = parseLayoutDesc(new DatReader(local.getFileData(SMARTBOX_LAYOUT_ID)!));
  });

  it('ID_SmartBox_FPS (231735155) in StringTable 0x23000001 is the shipped fallback', () => {
    expect(FPS_STRING_ID).toBe(231735155);
    expect(framerateMeterTemplate()).toEqual(FPS_TEMPLATE_FALLBACK);
  });

  it('element 0x10000047 is the 128x36 hidden white outlined text at the 3D view top-left', () => {
    const view = layout.elements.get(SMARTBOX_ELEMENT_ID)!;
    expect(view.type).toBe(0x10000014);
    const el: ElementDesc = view.children.get(FPS_ELEMENT_ID)!;
    expect(el.type).toBe(0xc);
    expect({ x: el.x, y: el.y, width: el.width, height: el.height }).toEqual(FPS_ELEMENT_RECT);
    expect([el.leftEdge, el.topEdge, el.rightEdge, el.bottomEdge]).toEqual([1, 1, 2, 2]);
    const p = el.properties;
    expect(p.get(59)?.valueBool).toBe(true);
    expect(p.get(33)?.valueBool).toBe(true);
    expect(p.get(20)?.valueEnum).toBe(2);
    expect(p.get(21)?.valueEnum).toBe(4);
    expect(p.get(35)?.valueInt).toBe(2);
    expect(p.get(37)?.valueInt).toBe(2);
    expect(p.get(26)?.valueArray?.[0]?.valueDataFile).toBe(FPS_FONT_ID);
    expect((p.get(27)?.valueArray?.[0]?.valueColor ?? 0) >>> 0).toBe(FPS_TEXT_COLOR_ARGB);
  });
});
