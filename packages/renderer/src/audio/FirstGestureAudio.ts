/**
 * The browser's autoplay rule: the AudioContext opens on the page's first
 * click (a user gesture). The click can land at any moment of the boot —
 * on the patch screen, during the DAT loads, on the launcher — so the
 * handler must not reach anything the boot builds later.
 *
 * BUG.boot-click-tdz (2026-10-13, prod build 5101ef32): main() installed the
 * listener at world_init and its body read `gameUI`, a `const` declared ~3,700
 * lines later behind several awaits. A click during that stretch (the player
 * pressing the patch screen's Cancel) threw "Cannot access 'E' before
 * initialization" from the document click handler. `afterInit` is now a
 * callback the caller points at whatever exists when it runs; nothing it does
 * is needed before the GameUI exists (AudioManager keeps category state set
 * before init and copies it into the gain nodes at init).
 */
export interface FirstGestureAudioSource {
  init(): boolean;
}

export interface FirstGestureAudio {
  /** Whether the AudioContext is open. */
  readonly initialized: boolean;
}

export function installFirstGestureAudio(
  target: Pick<EventTarget, 'addEventListener'>,
  audio: FirstGestureAudioSource,
  afterInit: () => void,
): FirstGestureAudio {
  let initialized = false;
  const onFirstClick = (): void => {
    if (initialized) return;
    initialized = audio.init();
    if (initialized) afterInit();
  };
  target.addEventListener('click', onFirstClick, { once: true });
  return { get initialized() { return initialized; } };
}
