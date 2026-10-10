/**
 * CORE.3.d — per-window chat options: 64-bit text-type filters from the
 * Chat Options checkboxes and the extended per-window persisted state
 * (size + title). (The retail `@title` command itself is the DoTitle port
 * in chat/commands, driven in verify-retail-commands-allegiance-social.ts.)
 *
 * Ground truth: gmChatOptionsUI::InitOptions @ 0049f100 +
 * AddCheckboxBitfield64Option @ 0049eda0 (channel masks, per-window
 * defaults incl. the 64-bit `(0xfbffffff, 0)` main default — Society bit
 * 32 OFF), ChatInterface::TypeIsActive (bit test),
 * ClientCommunicationSystem::DoTitle @ 0057a640 (@title behavior), all
 * from the decompiled EoL client.
 */
import { describe, it, expect } from 'vitest';
import {
  CHAT_FILTER_CHANNELS, GAMEPLAY_FILTER_MASK, computeChatWindowFilter,
  floatyTypeIsActive,
  FLOATY_CHAT_WINDOWS, loadFloatyChatStates, saveFloatyChatState,
} from '../packages/renderer/src/ui/FloatyChatModel.js';

/** In-memory Storage stand-in. */
function memStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => { m.set(k, v); },
  };
}

describe('CORE.3.d — chat channel masks (gmChatOptionsUI::InitOptions)', () => {
  it('pins the 12 retail checkbox masks + the Gameplay mask', () => {
    const bySuffix = Object.fromEntries(CHAT_FILTER_CHANNELS.map((c) => [c.suffix, c.mask]));
    expect(bySuffix).toEqual({
      Combat: 0x600040n, Magic: 0x20080n, AreaChat: 0x1004n, Tells: 0x18n,
      Allegiance: 0x40c00n, Fellowship: 0x80000n, General: 0x8000000n,
      Trade: 0x10000000n, LFG: 0x20000000n, Roleplay: 0x40000000n,
      Society: 0x100000000n, Errors: 0x4000000n,
    });
    expect(GAMEPLAY_FILTER_MASK).toBe(0x83912021n);
    // The channel masks + Gameplay tile the low dword except AllChannels /
    // Channel / ChannelSend / Abuse / Help (bits 1, 8, 9, 14, 15) — the
    // never-filterable types no checkbox covers.
    let all = GAMEPLAY_FILTER_MASK;
    for (const { mask } of CHAT_FILTER_CHANNELS) all |= mask;
    expect(all & 0xffffffffn).toBe(0xffffffffn ^ 0xc302n);
  });
});

describe('CORE.3.d — computeChatWindowFilter (option 0x1000007f)', () => {
  const noSettings = () => undefined;

  it('defaults reproduce the ChatInterface::PostInit masks exactly', () => {
    expect(computeChatWindowFilter(noSettings, 'main')).toBe(0xfbffffffn);
    expect(computeChatWindowFilter(noSettings, 1)).toBe(0x101cn);
    expect(computeChatWindowFilter(noSettings, 2)).toBe(0x40c00n);
    expect(computeChatWindowFilter(noSettings, 3)).toBe(0x80000n);
    expect(computeChatWindowFilter(noSettings, 4)).toBe(0x78000000n);
  });

  it('a checkbox toggles exactly its channel mask', () => {
    // Turn Tells OFF in window 1: 0x101c → 0x1004.
    const w1 = computeChatWindowFilter((k) => (k === 'chatWindow1Tells' ? false : undefined), 1);
    expect(w1).toBe(0x1004n);
    // Turn Fellowship ON in window 1.
    const w1b = computeChatWindowFilter((k) => (k === 'chatWindow1Fellowship' ? true : undefined), 1);
    expect(w1b).toBe(0x101cn | 0x80000n);
    // Gameplay checkbox exists only for floaty windows.
    const w2 = computeChatWindowFilter((k) => (k === 'chatWindow2Gameplay' ? true : undefined), 2);
    expect(w2).toBe(0x40c00n | GAMEPLAY_FILTER_MASK);
    const main = computeChatWindowFilter((k) => (k === 'chatMainWindowGameplay' ? false : undefined), 'main');
    expect(main).toBe(0xfbffffffn); // no such checkbox — Gameplay bits stay on
  });

  it('main window: Society is bit 32 and defaults OFF (64-bit default (0xfbffffff, 0))', () => {
    expect(floatyTypeIsActive(computeChatWindowFilter(noSettings, 'main'), 32)).toBe(false);
    const withSociety = computeChatWindowFilter((k) => (k === 'chatMainWindowSociety' ? true : undefined), 'main');
    expect(withSociety).toBe(0xfbffffffn | 0x100000000n);
    expect(floatyTypeIsActive(withSociety, 32)).toBe(true);
  });

  it('never-filterable bits (AllChannels/Channel/ChannelSend/Abuse/Help) survive any checkbox combination in main', () => {
    const allOff = computeChatWindowFilter(() => false, 'main');
    expect(allOff & 0xc302n).toBe(0xc302n);
    expect(floatyTypeIsActive(allOff, 0x01)).toBe(true); // AllChannels
    expect(floatyTypeIsActive(allOff, 0x0e)).toBe(true); // Abuse
    expect(floatyTypeIsActive(allOff, 0x0f)).toBe(true); // Help
    expect(floatyTypeIsActive(allOff, 0x02)).toBe(false); // Speech now filtered
  });

  it('floatyTypeIsActive accepts number and bigint filters', () => {
    expect(floatyTypeIsActive(0x101c, 2)).toBe(true);
    expect(floatyTypeIsActive(0x101cn, 2)).toBe(true);
    expect(floatyTypeIsActive(0x100000000n, 32)).toBe(true);
    expect(floatyTypeIsActive(0x100000000n, 31)).toBe(false);
    expect(floatyTypeIsActive(0x101c, -1)).toBe(false);
    expect(floatyTypeIsActive(0x101c, 64)).toBe(false);
  });
});

describe('CORE.3.d — persisted per-window state (options 0x10000086-89/0x1000008d)', () => {
  it('round-trips size + title alongside open/x/y', () => {
    const storage = memStorage();
    saveFloatyChatState(storage, 'acct:char', 2, {
      open: true, x: 40, y: 60, w: 400, h: 220, title: 'Trade watch',
    });
    const loaded = loadFloatyChatStates(storage, 'acct:char');
    expect(loaded[2]).toEqual({ open: true, x: 40, y: 60, w: 400, h: 220, title: 'Trade watch' });
    // Pre-CORE.3.d records without w/h/title still load.
    saveFloatyChatState(storage, 'acct:char', 1, { open: false, x: 0, y: 35 });
    expect(loadFloatyChatStates(storage, 'acct:char')[1]).toEqual({ open: false, x: 0, y: 35 });
  });

  it('window defs remain the retail set (windows 2-5 on elements 0x10000505/0e/0f/10)', () => {
    expect(FLOATY_CHAT_WINDOWS.map((d) => d.windowId)).toEqual([2, 3, 4, 5]);
    expect(FLOATY_CHAT_WINDOWS.map((d) => d.elementId))
      .toEqual([0x10000505, 0x1000050e, 0x1000050f, 0x10000510]);
  });
});
