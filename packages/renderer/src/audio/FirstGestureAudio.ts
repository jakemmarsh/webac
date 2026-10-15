/**
 * The browser's autoplay rule: the AudioContext opens on the page's first
 * user gesture (a click, a key or a pointer press). The gesture can land at
 * any moment of the boot — on the patch screen, during the DAT loads, on the
 * launcher — so the handler must not reach anything the boot builds later.
 *
 * BUG.boot-click-tdz (2026-10-13, prod build 5101ef32): main() installed the
 * listener at world_init and its body read `gameUI`, a `const` declared ~3,700
 * lines later behind several awaits. A click during that stretch (the player
 * pressing the patch screen's Cancel) threw "Cannot access 'E' before
 * initialization" from the document click handler. `afterInit` is now a
 * callback the caller points at whatever exists when it runs; nothing it does
 * is needed before the GameUI exists (AudioManager keeps category state set
 * before init and copies it into the gain nodes at init).
 *
 * BUG.combat-sounds-need-a-click (2026-10-15): world entry opens the context
 * itself, so without a gesture yet it is suspended; the gesture resumes it.
 * Keys count as well as clicks (a keyboard-only player), and the listeners
 * stay until the context runs.
 */
export interface FirstGestureAudioSource {
  init(): boolean;
  /** Resume a context opened before the gesture (it starts suspended). */
  resume?(): Promise<void>;
  /** The context's clock runs (AudioManager.isRunning). */
  readonly isRunning?: boolean;
}

export interface FirstGestureAudio {
  /** Whether the AudioContext is open. */
  readonly initialized: boolean;
}

/** The events that are user activations for the autoplay rule. */
export const AUDIO_GESTURE_EVENTS = ['click', 'keydown', 'pointerdown'] as const;

export function installFirstGestureAudio(
  target: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>,
  audio: FirstGestureAudioSource,
  afterInit: () => void,
): FirstGestureAudio {
  let initialized = false;
  let tried = false;
  const opts = { capture: true, passive: true } as const;
  const remove = (): void => {
    for (const t of AUDIO_GESTURE_EVENTS) target.removeEventListener(t, onGesture, opts);
  };
  function onGesture(): void {
    if (!tried) {
      tried = true;
      initialized = audio.init();
      if (initialized) afterInit();
    }
    // A context that could not open never will: stop listening.
    if (!initialized) { remove(); return; }
    void Promise.resolve(audio.resume?.())
      .catch(() => { /* the next gesture tries again */ })
      .then(() => { if (audio.isRunning ?? true) remove(); });
  }
  for (const t of AUDIO_GESTURE_EVENTS) target.addEventListener(t, onGesture, opts);
  return { get initialized() { return initialized; } };
}
