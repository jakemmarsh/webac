/**
 * CORE.17.h — chat window opacity model vs the decompiled EoL client.
 *
 * Anchors (reference/client-eol, build ac1_sep13):
 *  - ChatInterface::ChatInterface @ 004f4550 — disassembly stores
 *    0x3f000000 (0.5) at [this+0x600] (m_fDefaultOpacity) and [this+0x608]
 *    (m_fCurrentOpacity), 0x3f800000 (1.0) at [this+0x604] (m_fActiveOpacity).
 *  - gmMainChatUI::gmMainChatUI @ 004cd0f0 — calls that constructor, then
 *    stores 0x3f800000 (1.0) at [this+0x600] and [this+0x608]: the main
 *    window is fully opaque by default.
 *  - gmFloatyChatUI::Create @ 004ce2c0 — calls the ChatInterface constructor
 *    only: the floaty windows 1-4 keep 0.5 / 1.0.
 *  - ChatInterface::SetDefaultOpacity @ 004f3bc0 raises active to the new
 *    default when active < default; SetActiveOpacity @ 004f3c40 lowers the
 *    default when the new active is smaller.
 *  - gmFloatyMainChatUI::UpdateFromPlayerModule @ 004d2970 applies option
 *    0x10000080 then 0x10000081, each only on an InqOption hit.
 *  - ChatInterface::ListenToGlobalMessage @ 004f3840 — 0.05 * |active -
 *    default| per UseTime tick (global message 3, UIElementManager::UseTime
 *    @ 0045cfd0) = 20 ticks.
 *
 * Ground truth for the numbers on screen: the 48x48 message tile 0x06004cc2
 * is uniform black at alpha 175 (0.686); both retail captures measure the
 * message body at ~0.69 coverage with the frame undimmed, i.e. material
 * opacity 1.0 — the main-window constructor value.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import {
  CHAT_INTERFACE_CTOR_OPACITY, MAIN_CHAT_CTOR_OPACITY,
  CHAT_OPACITY_FADE_TICKS, CHAT_OPACITY_FADE_MS,
  setChatDefaultOpacity, setChatActiveOpacity, chatOpacityFor, resolveChatOpacity,
} from '../packages/renderer/src/ui/FloatyChatModel.js';
import { openDat } from './_harness/dat.js';

describe('CORE.17.h — constructor values', () => {
  it('ChatInterface::ChatInterface @ 004f4550: default 0.5, active 1.0 (floaty windows 1-4)', () => {
    expect(CHAT_INTERFACE_CTOR_OPACITY).toEqual({ defaultOpacity: 0.5, activeOpacity: 1.0 });
  });
  it('gmMainChatUI::gmMainChatUI @ 004cd0f0: the main window is 1.0 / 1.0', () => {
    expect(MAIN_CHAT_CTOR_OPACITY).toEqual({ defaultOpacity: 1.0, activeOpacity: 1.0 });
  });
  it('the fade is 20 UseTime ticks (0.05 of the span per tick), 333 ms at 60 fps', () => {
    expect(CHAT_OPACITY_FADE_TICKS).toBe(20);
    expect(1 / CHAT_OPACITY_FADE_TICKS).toBeCloseTo(0.05, 9);
    expect(CHAT_OPACITY_FADE_MS).toBe(333);
  });
});

describe('CORE.17.h — SetDefaultOpacity / SetActiveOpacity keep default <= active', () => {
  it('SetDefaultOpacity above the active value drags active up with it', () => {
    const s = { ...CHAT_INTERFACE_CTOR_OPACITY };
    setChatActiveOpacity(s, 0.6);
    setChatDefaultOpacity(s, 0.8);
    expect(s).toEqual({ defaultOpacity: 0.8, activeOpacity: 0.8 });
  });
  it('SetDefaultOpacity below the active value leaves active alone', () => {
    const s = { ...CHAT_INTERFACE_CTOR_OPACITY };
    setChatDefaultOpacity(s, 0.2);
    expect(s).toEqual({ defaultOpacity: 0.2, activeOpacity: 1.0 });
  });
  it('SetActiveOpacity below the default drags the default down', () => {
    const s = { ...MAIN_CHAT_CTOR_OPACITY };
    setChatActiveOpacity(s, 0.3);
    expect(s).toEqual({ defaultOpacity: 0.3, activeOpacity: 0.3 });
  });
  it('SetActiveOpacity above the default leaves the default alone', () => {
    const s = { ...CHAT_INTERFACE_CTOR_OPACITY };
    setChatActiveOpacity(s, 0.7);
    expect(s).toEqual({ defaultOpacity: 0.5, activeOpacity: 0.7 });
  });
  it('chatOpacityFor picks active while the entry is focused, default otherwise', () => {
    const s = { defaultOpacity: 0.4, activeOpacity: 0.9 };
    expect(chatOpacityFor(s, true)).toBe(0.9);
    expect(chatOpacityFor(s, false)).toBe(0.4);
  });
});

describe('CORE.17.h — UpdateFromPlayerModule resolution', () => {
  it('no options: each window class sits on its constructor values', () => {
    expect(resolveChatOpacity(MAIN_CHAT_CTOR_OPACITY, {})).toEqual({ defaultOpacity: 1.0, activeOpacity: 1.0 });
    expect(resolveChatOpacity(CHAT_INTERFACE_CTOR_OPACITY, {})).toEqual({ defaultOpacity: 0.5, activeOpacity: 1.0 });
  });
  it('0x10000080 alone: default applied, active stays at the constructor value', () => {
    expect(resolveChatOpacity(MAIN_CHAT_CTOR_OPACITY, { defaultOpacity: 0.5 }))
      .toEqual({ defaultOpacity: 0.5, activeOpacity: 1.0 });
    expect(resolveChatOpacity(CHAT_INTERFACE_CTOR_OPACITY, { defaultOpacity: 0.2 }))
      .toEqual({ defaultOpacity: 0.2, activeOpacity: 1.0 });
  });
  it('0x10000081 alone below the constructor default pulls the default down (main window: 1.0 -> value)', () => {
    expect(resolveChatOpacity(MAIN_CHAT_CTOR_OPACITY, { activeOpacity: 0.6 }))
      .toEqual({ defaultOpacity: 0.6, activeOpacity: 0.6 });
  });
  it('both options: default first, then active (retail call order)', () => {
    expect(resolveChatOpacity(MAIN_CHAT_CTOR_OPACITY, { defaultOpacity: 0.8, activeOpacity: 0.4 }))
      .toEqual({ defaultOpacity: 0.4, activeOpacity: 0.4 });
    expect(resolveChatOpacity(CHAT_INTERFACE_CTOR_OPACITY, { defaultOpacity: 0.3, activeOpacity: 0.9 }))
      .toEqual({ defaultOpacity: 0.3, activeOpacity: 0.9 });
  });
  it('option values are clamped to 0..1 and the constructor objects are never mutated', () => {
    expect(resolveChatOpacity(CHAT_INTERFACE_CTOR_OPACITY, { defaultOpacity: 7, activeOpacity: -1 }))
      .toEqual({ defaultOpacity: 0, activeOpacity: 0 });
    expect(CHAT_INTERFACE_CTOR_OPACITY).toEqual({ defaultOpacity: 0.5, activeOpacity: 1.0 });
    expect(MAIN_CHAT_CTOR_OPACITY).toEqual({ defaultOpacity: 1.0, activeOpacity: 1.0 });
  });
});

// The DAT half of the retail look: the message tile's own alpha.
const PORTAL_DAT = 'dat/client_portal.dat';
describe.skipIf(!existsSync(PORTAL_DAT))('CORE.17.h — message tile 0x06004cc2 is black at alpha 175/255 (DAT)', () => {
  let rgba: { width: number; height: number; data: Uint8Array } | null = null;
  beforeAll(async () => {
    const { DatDatabase } = await import('../packages/dat-parser/src/DatDatabase.js');
    const { DatReader } = await import('../packages/dat-parser/src/DatReader.js');
    const { Texture } = await import('../packages/dat-parser/src/file-types/Texture.js');
    const db = openDat(PORTAL_DAT);
    const data = db.getFileData(0x06004cc2);
    if (!data) return;
    rgba = Texture.read(new DatReader(data)).toRGBA();
  });
  it('48x48, every texel RGB 0 with alpha 175 — the ~0.69 body coverage both retail captures measure', () => {
    expect(rgba).not.toBeNull();
    expect(rgba!.width).toBe(48);
    expect(rgba!.height).toBe(48);
    const d = rgba!.data;
    let maxRgb = 0, minA = 255, maxA = 0;
    for (let i = 0; i < d.length; i += 4) {
      maxRgb = Math.max(maxRgb, d[i], d[i + 1], d[i + 2]);
      minA = Math.min(minA, d[i + 3]);
      maxA = Math.max(maxA, d[i + 3]);
    }
    expect(maxRgb).toBe(0);
    expect(minA).toBe(175);
    expect(maxA).toBe(175);
    expect(175 / 255).toBeCloseTo(0.686, 3);
  });
});
