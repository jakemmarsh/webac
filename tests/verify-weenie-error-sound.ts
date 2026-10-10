/**
 * FAITHFUL.415 → BUG.duplicate-local-sounds (2026-09-28) — a WeenieError
 * plays NO sound.
 *
 * Retail: a 0x028A WeenieError runs ClientCommunicationSystem::
 * HandleFailureEvent @ 00571990, whose arms print through one of three sinks
 * or not at all — and play nothing. The only client-side callers of
 * SoundManager::PlaySoundFromCenter are gmSmartBoxUI's teleport animation
 * (UI_EnterPortal / UI_ExitPortal), the admin Environs sounds and the
 * layout media (three UI_ButtonPress items), so the old UI_GeneralError
 * "action denied" chime (FAITHFUL.415/.416/.425, weenieErrorChimes) was
 * invented. The sink routing it rode on stays.
 */
import { describe, it, expect } from 'vitest';
import { WeenieError, weenieErrorText, Sound } from '@ac/shared';
import * as notices from '../packages/renderer/src/ui/WeenieErrorNotices.js';
import { isRetailClientLocalSound } from '../packages/renderer/src/audio/RetailLocalSounds.js';
import type { NoticeSurface } from '../packages/renderer/src/ui/ClientNotices.js';

const { deliverWeenieError } = notices;

function surface(): NoticeSurface & { spew: string[]; chat: string[] } {
  const s = { spew: [] as string[], chat: [] as string[] } as NoticeSurface & { spew: string[]; chat: string[] };
  s.displayErrorText = (t) => { s.spew.push(t); };
  s.addSystemMessage = (t) => { s.chat.push(t); };
  return s;
}

describe('onWeenieError: the text, never a chime (BUG.duplicate-local-sounds)', () => {
  it('UI_GeneralError is not a sound the retail client plays itself', () => {
    expect(Sound.UI_GeneralError).toBe(0x6d);
    expect(isRetailClientLocalSound(Sound.UI_GeneralError)).toBe(false);
    expect('weenieErrorChimes' in notices).toBe(false);
  });

  it('a surfaced spew-box error still reaches the spew box', () => {
    const ui = surface();
    const d = deliverWeenieError(ui, WeenieError.YouAreTooFatiguedToAttack, weenieErrorText(WeenieError.YouAreTooFatiguedToAttack));
    expect(d.sink).toBe('spew');
    expect(ui.spew).toEqual(['You are too fatigued to attack!']);
  });

  it('a surfaced chat-line error still reaches chat', () => {
    const ui = surface();
    const d = deliverWeenieError(ui, WeenieError.YouDoNotOwnThatItem, weenieErrorText(WeenieError.YouDoNotOwnThatItem));
    expect(d.sink).toBe('chat');
    expect(ui.chat).toEqual(['You do not own that item!']);
  });

  it('a code retail never printed, and None, stay silent', () => {
    const ui = surface();
    expect(deliverWeenieError(ui, WeenieError.TradeClosed, weenieErrorText(WeenieError.TradeClosed)).sink).toBe('none');
    expect(deliverWeenieError(ui, WeenieError.None, weenieErrorText(WeenieError.None)).sink).toBe('none');
    expect(ui.spew).toEqual([]);
    expect(ui.chat).toEqual([]);
  });
});
