/**
 * The in-world keydown router's front half (main.ts's document keydown listener), DOM-free so the
 * tests drive the shipped code with real KeyboardEvent shapes (BUG.cast-flood-remaining).
 *
 * Order, as main.ts ran it inline: a text field keeps its keys; the automation hotkeys answer; the
 * active input maps are synced and the key resolved (a chord with no binding of its own answers as
 * the bare key); an OS key repeat runs only an action retail repeats; a movement key is
 * CameraController's; anything else is dispatched once.
 *
 * Key repeat: neither client acts on an OS repeat. The 1999 WndProc drops a WM_KEYDOWN whose
 * lParam bit 30 (previous key state) is set unless a text field turned repeats on (0x00408250 /
 * 0x00408260 around an edit field; the check sits in the client's window procedure), so digits 1-9
 * in magic mode (0x004f4120 → 0x00513480 → SpellCastSubPanel_Cast) cast once per press. End of
 * retail reads DirectInput and CInputManager repeats only ActionMap toggle-type-4 actions
 * (@ 00431c99, keyRepeatDispatches).
 */
import { eventToCode, type KeyLike } from './KeybindRegistry.js';
import { HELD_CAMERA_ACTIONS, MOVEMENT_CANONICAL, keyRepeatDispatches } from './KeybindDefaults.js';

export interface GameKeyDownEvent extends KeyLike {
  readonly repeat: boolean;
}

export interface GameKeyDownDeps {
  /** A chat line, a DAT edit field or any other text field has the keyboard. */
  textFocused(): boolean;
  /** The automation window's hotkeys (vhsHotkeys.onKey): true when it took the key. */
  automationHotkey(code: string, repeat: boolean): boolean;
  /** Register the input maps of the current combat mode (ClientCombatSystem::RegisterInputMaps). */
  syncMaps(): void;
  /** KeybindRegistry.resolveOrBare. */
  resolve(code: string): number | null;
  /** Run a one-shot command (main.ts dispatchAction); true when handled. */
  dispatch(id: number): boolean;
}

/**
 * What the router did with a key going down:
 * - `text`: a text field has it (nothing else runs);
 * - `automation`: an automation hotkey took it;
 * - `held`: an OS repeat of a command retail does not repeat (swallowed);
 * - `movement`: a movement key, which CameraController's own listener handles;
 * - `dispatched`: its command ran;
 * - `unbound`: no command took it (main.ts's system keys get it).
 */
export type GameKeyDownResult = 'text' | 'automation' | 'held' | 'movement' | 'dispatched' | 'unbound';

/** Whether main.ts prevents the browser default for this result. */
export function keyDownConsumed(r: GameKeyDownResult): boolean {
  return r === 'automation' || r === 'held' || r === 'dispatched';
}

export function routeGameKeyDown(e: GameKeyDownEvent, deps: GameKeyDownDeps): GameKeyDownResult {
  if (deps.textFocused()) return 'text';
  const code = eventToCode(e);
  if (deps.automationHotkey(code, e.repeat)) return 'automation';
  deps.syncMaps();
  const id = deps.resolve(code);
  if (id == null) return 'unbound';
  // A held zoom key is one press too (the repeat would restart its tick clock).
  if (e.repeat && (HELD_CAMERA_ACTIONS.has(id) || !keyRepeatDispatches(id))) return 'held';
  if (MOVEMENT_CANONICAL[id] !== undefined) return 'movement';
  return deps.dispatch(id) ? 'dispatched' : 'unbound';
}
