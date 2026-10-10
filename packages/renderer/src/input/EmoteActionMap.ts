/**
 * Maps each Emote keyboard command (ActionClass.Emotes) to its MotionCommand,
 * so the input router can fire the right animation when an emote key is pressed.
 *
 * The retail command label (from the ActionMap) matches the MotionCommand enum
 * name once non-alphanumerics are stripped, except for four labels that need an
 * explicit alias (the enum dropped a "State" suffix or abbreviated the verb).
 */
import { MotionCommand } from '../animation/MotionCommands.js';
import { KEYBIND_ACTIONS } from './KeybindActions.generated.js';
import { ActionClass } from './KeybindActionClass.js';

const EMOTE_NAME_ALIASES: Record<string, string> = {
  'ATOYOT State': 'ATOYOT',
  'Mime Drinking': 'MimeDrink',
  'Mime Eating': 'MimeEat',
  'Yawn and Stretch': 'YawnStretch',
};

const norm = (s: string): string => s.replace(/[^a-z0-9]/gi, '').toLowerCase();

/** actionId → MotionCommand for every Emote command (covers all 87). */
export function buildEmoteMotionMap(): Map<number, number> {
  const motionByName = new Map<string, number>();
  for (const [k, v] of Object.entries(MotionCommand)) {
    if (typeof v === 'number') motionByName.set(norm(k), v);
  }
  const out = new Map<number, number>();
  for (const a of KEYBIND_ACTIONS) {
    if (a.cls !== ActionClass.Emotes) continue;
    const m = motionByName.get(norm(EMOTE_NAME_ALIASES[a.name] ?? a.name));
    if (m !== undefined) out.set(a.id, m);
  }
  return out;
}
