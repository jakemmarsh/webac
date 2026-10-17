/**
 * A keymap action found by what a player (or an agent's ac_press) calls it. The names are the ActionMap's own
 * (portal.dat 0x26000000 via StringTable 0x23000005: KEYBIND_ACTIONS), matched as typed, then in the other forms the
 * same name comes in: without its spaces and slashes ("ShowHideInventoryPanel", "lay_down"), as the posture motion an
 * emote input action holds ("Sitting" is the Sit action: ACCmdInterp::InitializeEmoteInputActionHash @ 0058b510 maps
 * Ready / Crouch / Sit / Lay Down to MotionCommand Ready / Crouch / Sitting / Sleeping), and word for word in another
 * inflection ("Jumping", "Toggles Combat Mode"). Bulwark's `ac_press key=Sitting` was refused "no key or keymap action"
 * right after the /sit hint told him to "take the Sitting stance" (Tusker Habitat, 2026-10-17 17:20:25Z).
 */
import { MotionCommand } from '../animation/MotionCommands.js';
import { ACT } from './KeybindDefaults.js';

export interface NamedKeybindAction { id: number; name: string }

/** The emote input actions and the posture each holds (ACCmdInterp::InitializeEmoteInputActionHash; main.ts's ACT arms). */
export const EMOTE_INPUT_ACTION_MOTIONS: ReadonlyMap<number, number> = new Map([
  [ACT.Ready, MotionCommand.Ready],
  [ACT.Crouch, MotionCommand.Crouch],
  [ACT.Sitting, MotionCommand.Sitting],
  [ACT.Sleeping, MotionCommand.Sleeping],
]);

const MOTION_NAMES = new Map<number, string>(Object.entries(MotionCommand).map(([k, v]) => [v as number, k]));

/** Letters and digits only, lower case: "Show/Hide Inventory Panel" → "showhideinventorypanel". */
const squash = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
const words = (s: string): string[] => s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/** A word's possible base forms: itself, and without an -ing / -ed / -s ending ("sitting" → "sit", "toggling" → "toggle"). */
function baseForms(w: string): string[] {
  const out = [w];
  const stem = (s: string): void => {
    out.push(s, `${s}e`);
    if (s.length >= 3 && s[s.length - 1] === s[s.length - 2] && !/[aeiou]/.test(s[s.length - 1])) out.push(s.slice(0, -1));
  };
  if (w.length > 4 && w.endsWith('ing')) stem(w.slice(0, -3));
  if (w.length > 3 && w.endsWith('ed')) stem(w.slice(0, -2));
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) out.push(w.slice(0, -1));
  return out;
}

function editDistance(a: string, b: string): number {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}

/**
 * The action `input` names, or none and the closest names (at most `max`). Tried in turn: the name as typed (any case),
 * the name squashed, the posture motion's name of an emote input action, the name word for word in base forms, then a
 * name containing what was typed (the old lookup: "Inventory" → "Show/Hide Inventory Panel").
 */
export function findKeybindAction<T extends NamedKeybindAction>(actions: readonly T[], input: string, max = 3): { action: T; closest: string[] } | { action: null; closest: string[] } {
  const typed = input.trim();
  const low = typed.toLowerCase();
  const sq = squash(typed);
  const hit = (a: T | undefined): { action: T; closest: string[] } | null => (a ? { action: a, closest: [] } : null);
  const exact = hit(actions.find((a) => a.name.toLowerCase() === low)) ?? (sq ? hit(actions.find((a) => squash(a.name) === sq)) : null);
  if (exact) return exact;
  const motion = sq ? actions.find((a) => { const m = EMOTE_INPUT_ACTION_MOTIONS.get(a.id); return m !== undefined && squash(MOTION_NAMES.get(m) ?? '') === sq; }) : undefined;
  if (motion) return { action: motion, closest: [] };
  const ws = words(typed).map(baseForms);
  const inflected = ws.length ? actions.find((a) => { const an = words(a.name); return an.length === ws.length && an.every((w, i) => ws[i].includes(w)); }) : undefined;
  if (inflected) return { action: inflected, closest: [] };
  const part = low ? actions.find((a) => a.name.toLowerCase().includes(low)) : undefined;
  if (part) return { action: part, closest: [] };
  // None: the nearest names by spelling (squashed, and each emote action by its motion's name too), best first.
  const scored = actions.map((a) => {
    const names = [a.name, ...(EMOTE_INPUT_ACTION_MOTIONS.has(a.id) ? [MOTION_NAMES.get(EMOTE_INPUT_ACTION_MOTIONS.get(a.id)!) ?? ''] : [])];
    const d = Math.min(...names.map((n) => editDistance(sq, squash(n)) / Math.max(sq.length, squash(n).length, 1)));
    // A shared word ("hide" in Show/Hide …) counts for a little.
    const shared = words(a.name).some((w) => ws.some((f) => f.includes(w))) ? 0.25 : 0;
    return { name: a.name, score: d - shared };
  }).filter((x) => x.score <= 0.6).sort((x, y) => x.score - y.score);
  return { action: null, closest: [...new Set(scored.map((x) => x.name))].slice(0, max) };
}

/** A key code as the keyboard sends it ("KeyG", "F9", "Ctrl+KeyI"): pressed as given. */
export const KEY_CODE = /^((Ctrl|Alt|Shift)\+)*(Key[A-Z]|Digit\d|F\d{1,2}|Numpad\w+|Arrow\w+|Space|Enter|Escape|Tab|Backspace|Home|End|PageUp|PageDown|Insert|Delete|Minus|Equal|Bracket\w+|Semicolon|Quote|Comma|Period|Slash|Backslash|Backquote)$/;

/**
 * What ac_press presses for `input`: a key code as given, else the first key bound to the action it names. A refusal
 * names the closest action names when none matched.
 */
export function resolvePress<T extends NamedKeybindAction>(actions: readonly T[], mappings: (id: number) => readonly (string | null | undefined)[], input: string):
  { ok: true; code: string; action: T | null } | { ok: false; message: string } {
  const typed = input.trim();
  if (KEY_CODE.test(typed)) return { ok: true, code: typed, action: findKeybindAction(actions, typed).action };
  const found = findKeybindAction(actions, typed);
  if (!found.action) {
    const near = found.closest.length ? `; closest: ${found.closest.map((n) => `"${n}"`).join(', ')}` : '';
    return { ok: false, message: `no key or keymap action "${input}"${near} (ac_keys lists them)` };
  }
  const code = mappings(found.action.id).find((m): m is string => !!m);
  return code ? { ok: true, code, action: found.action } : { ok: false, message: `"${found.action.name}" has no key bound` };
}
