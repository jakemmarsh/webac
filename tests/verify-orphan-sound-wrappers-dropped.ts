/**
 * FAITHFUL.469 — drop 15 orphan play*Sound wrappers.
 *
 *  Closes the "defined-but-uncalled GameUI helpers" gap from the
 *  session-opening summary. Each removed wrapper was a one-line
 *  `playUISound(Sound.X)` proxy with zero callers anywhere in the
 *  codebase. main.ts plays the equivalent sounds via direct
 *  `soundPlayer.playGameSound(SOUND_TABLE, Sound.X, 'effects')` calls
 *  with per-object sound tables (e.g. fizzle uses the object's
 *  `soundTableId` per main.ts:7362). The wrappers were dead
 *  duplicates that bloated the API surface.
 *
 *  BUG.duplicate-local-sounds (2026-09-28) dropped the 7 that were left
 *  (playOpenSound, playCloseSound, playSpellExpireSound, playRaiseTraitSound,
 *  playLifestoneSound, playWieldSound, playUnwieldSound): each doubled a
 *  Sound message ACE sends on the player or played a sound retail never
 *  plays, and playUISound itself now refuses anything outside the retail
 *  client's own set (audio/RetailLocalSounds).
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Sound } from '@ac/shared';
import { mountGameUI, type GameUIFixture } from './_harness/gameui.js';

describe('FAITHFUL.469 — play*Sound wrappers on the real GameUI', () => {
  let H: GameUIFixture;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let proto: any;
  beforeAll(async () => { H = await mountGameUI(); proto = H.mod.GameUI.prototype; });
  afterAll(() => H.teardown());

  const orphans = [
    'playPortalEnterSound', 'playPortalExitSound', 'playFizzleSound', 'playSpellLaunchSound',
    'playSpellExplodeSound', 'playResistSpellSound', 'playEnchantUpSound', 'playEnchantDownSound',
    'playHealthUpSound', 'playHealthDownSound', 'playPickUpItemSound', 'playErrorSound',
    'playQuerySound', 'playLockSuccessSound', 'playLockFailSound',
    // BUG.server-sound-not-positional — the drop chime is the server's
    // Sound message on the player (ACE Player_Inventory.cs:1445), not local.
    'playDropItemSound',
    // BUG.duplicate-local-sounds — ACE sends each on the player
    // (Lifestone.cs:58, EnchantmentManager.cs:331, Player_Attributes.cs:48,
    // Player_Inventory.cs:306/405); retail plays no container chime.
    'playOpenSound', 'playCloseSound', 'playSpellExpireSound', 'playRaiseTraitSound',
    'playLifestoneSound', 'playWieldSound', 'playUnwieldSound',
  ];
  it.each(orphans)('%s is gone', (name) => {
    expect(proto[name]).toBeUndefined();
    expect(H.ui[name]).toBeUndefined();
  });

  const record = (fn: () => void): unknown[][] => {
    const played: unknown[][] = [];
    const prev = H.ui.soundPlayer;
    H.ui.soundPlayer = new Proxy({}, { get: () => (...args: unknown[]) => { played.push(args); } });
    try { fn(); } finally { H.ui.soundPlayer = prev; }
    return played;
  };

  // SoundManager::PlaySoundFromCenter's only callers: BeginTeleportAnimation
  // (UI_EnterPortal), UseTime (UI_ExitPortal), Handle_Admin__Environs, and
  // MediaMachine::Update_Sound (three UI_ButtonPress layout media).
  it.each([Sound.UI_EnterPortal, Sound.UI_ExitPortal, Sound.UI_ButtonPress, Sound.UI_Thunder1])(
    'playUISound(%s) — a retail client-local sound — plays from the UI table', (sound) => {
      const played = record(() => H.ui.playUISound(sound));
      expect(played).toEqual([[0x2000004b, sound, 'ui']]);
    });

  it.each([
    Sound.LifestoneOn, Sound.SpellExpire, Sound.RaiseTrait, Sound.WieldObject, Sound.UnwieldObject,
    Sound.Open, Sound.Close, Sound.UI_GeneralError, Sound.UI_TransientMessage, Sound.UI_NewTargetSelected,
    Sound.UI_IconPickUp, Sound.UI_IconSuccessfulDrop, Sound.Death1, Sound.EnchantUp,
  ])('playUISound(%s) — not a retail client-local sound — plays nothing', (sound) => {
    expect(record(() => H.ui.playUISound(sound))).toEqual([]);
  });
});
