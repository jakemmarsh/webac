/**
 * GoArrow's chat commands (docs/plugin-specs/goarrow.md §6): parsing a line into an action, the help text,
 * and the loc / dest send line. The UI carries the actions out.
 */

/** The HUDs a show / hide / toggle names (spec §6.2). */
export type GoHudTarget = 'arrow' | 'map' | 'dereth' | 'dungeon' | 'toolbar' | 'all';
export type GoHudAction = 'show' | 'hide' | 'toggle';

export type GoCommand =
  | { kind: 'help'; topic: 'main' | 'loc' }
  | { kind: 'hud'; action: GoHudAction; target: GoHudTarget }
  | { kind: 'to' | 'start' | 'end'; arg: string }
  | { kind: 'reset' }
  | { kind: 'lock'; locked: boolean }
  | { kind: 'loc' | 'dest'; arg: string }
  | { kind: 'search'; text: string }
  | { kind: 'find'; text: string }
  | { kind: 'tag' }
  | { kind: 'error'; message: string };

export const GOARROW_MESSAGE_PREFIX = '<{ GoArrow }> ';
export const GOARROW_VERSION = '2.5.0.0';
export const GOARROW_HUD_TARGET_ERROR = "Valid values are: 'arrow', 'map', 'dereth', 'dungeon', 'toolbar', and 'all'";
export const GOARROW_COORDS_PLACEHOLDER_ERROR = 'You\'re not actually supposed to type [coords] ... replace that with coordinates or "here"';
export const GOARROW_TO_ERROR = 'Invalid coordinates or unknown location name. Coordinates must be in the form "00.0N, 00.0E" and location names must match the name in the database exactly.';
export const GOARROW_TAG_NOTHING_SELECTED = 'Select something to attach the arrow to.';
export const GOARROW_HUDS_RESET_MESSAGE = 'The HUDs should now be in visible locations on the screen';
export const GOARROW_LOCKED_MESSAGE = 'Arrow HUD position locked';
export const GOARROW_UNLOCKED_MESSAGE = 'Arrow HUD position unlocked';
export const goInvalidCommandMessage = (word: string, cmd: string): string => `Invalid command: ${word}. Type /${cmd} help for a list of available commands`;
export const goNoFindMatches = (text: string): string => `No matches found for '${text}'`;

const HUD_WORDS: Record<string, GoHudTarget> = {
  arrow: 'arrow', map: 'map', auto: 'map', dereth: 'dereth', derethmap: 'dereth', 'dereth map': 'dereth',
  dungeon: 'dungeon', dung: 'dungeon', dungeonmap: 'dungeon', 'dungeon map': 'dungeon',
  toolbar: 'toolbar', tool: 'toolbar', 'tool bar': 'toolbar', all: 'all',
};
const TOGGLE_WORDS = ['toggle', 'onoff', 'on/off', 'showhide', 'show/hide'];
const SHOW_WORDS = ['on', 'show'];
const HIDE_WORDS = ['off', 'hide'];

/** The command names in use (spec §6.1): the main one and the enabled aliases. */
export interface GoCommandNames {
  main: string;
  loc?: string | null;
  dest?: string | null;
  find?: string | null;
}

/**
 * Parse a chat line (spec §6.1–6.2). Null when it isn't a GoArrow command: `/` or `@`, the command
 * case-insensitively, then a space or the end of the line (aliases need the trailing space).
 */
export function goParseCommand(line: string, names: GoCommandNames): GoCommand | null {
  const m = /^[/@](\S+)(?:\s+([\s\S]*))?$/.exec(line.trim());
  if (!m) return null;
  const word = m[1]!.toLowerCase();
  const rest = (m[2] ?? '').trim();
  const hasSpace = /^[/@]\S+\s/.test(line.trimStart());
  for (const alias of ['loc', 'dest', 'find'] as const) {
    const a = names[alias];
    if (a && word === a.toLowerCase() && hasSpace) return alias === 'find' ? { kind: 'find', text: rest } : { kind: alias, arg: rest };
  }
  if (word !== names.main.toLowerCase()) return null;
  const sp = /^(\S+)(?:\s+([\s\S]*))?$/.exec(rest);
  const sub = (sp?.[1] ?? '').toLowerCase();
  const rawArg = (sp?.[2] ?? '').trim();
  const arg = rawArg.toLowerCase();
  if (arg === '[coords]') return { kind: 'error', message: GOARROW_COORDS_PLACEHOLDER_ERROR };
  const hudTarget = (a: string): GoHudTarget | null => (a === '' ? 'arrow' : HUD_WORDS[a] ?? null);
  if (sub === '' || sub === 'help') return { kind: 'help', topic: arg === 'loc' || arg === 'dest' ? 'loc' : 'main' };
  for (const [words, action] of [[TOGGLE_WORDS, 'toggle'], [SHOW_WORDS, 'show'], [HIDE_WORDS, 'hide']] as const) {
    if ((words as readonly string[]).includes(sub)) {
      const t = hudTarget(arg);
      return t ? { kind: 'hud', action, target: t } : { kind: 'error', message: GOARROW_HUD_TARGET_ERROR };
    }
  }
  if (sub in HUD_WORDS && sub !== 'all' && sub !== 'auto') {
    const target = HUD_WORDS[sub]!;
    if (arg === '' || arg === 'toggle') return { kind: 'hud', action: 'toggle', target };
    if (SHOW_WORDS.includes(arg)) return { kind: 'hud', action: 'show', target };
    if (HIDE_WORDS.includes(arg)) return { kind: 'hud', action: 'hide', target };
    return { kind: 'error', message: goInvalidCommandMessage(arg, names.main.toLowerCase()) };
  }
  switch (sub) {
    case 'to': return { kind: 'to', arg: rawArg };
    case 'start': case 'from': return { kind: 'start', arg: rawArg };
    case 'end': return { kind: 'end', arg: rawArg };
    case 'reset': return { kind: 'reset' };
    case 'lock': return { kind: 'lock', locked: true };
    case 'unlock': return { kind: 'lock', locked: false };
    case 'loc': return { kind: 'loc', arg: rawArg };
    case 'dest': return { kind: 'dest', arg: rawArg };
    case 'search': return { kind: 'search', text: rawArg };
    case 'find': return { kind: 'find', text: rawArg };
    case 'tag': case 'attach': return { kind: 'tag' };
    default: return { kind: 'error', message: goInvalidCommandMessage(sub, names.main.toLowerCase()) };
  }
}

/** `here` / `"here"` as the to / start / end argument. */
export const goIsHereArg = (arg: string): boolean => /^"?here"?$/i.test(arg.trim());

/** The help text (spec §6.3), one entry per line. */
export function goHelpText(names: GoCommandNames): string[] {
  const c = `/${names.main.toLowerCase()}`;
  const lines = [
    `You're using GoArrow v${GOARROW_VERSION}. Here are the commands available:`,
    `    ${c} [arrow] [on|off]  -  Show or hide the arrow`,
    `    ${c} map [on|off]  -  Show or hide either the dereth or dungeon map, depending if you're on the landscape or in a dungeon`,
    `    ${c} dereth [on|off]  -  Show or hide the dereth map`,
    `    ${c} dungeon [on|off]  -  Show or hide the dungeon map`,
    `    ${c} toolbar [on|off]  -  Show or hide the toolbar`,
    `    ${c} show|hide arrow|map|dereth|dungeon|all  -  Show or hide the specified hud(s)`,
    `    ${c} to (coords)|(location)|here  -  Set the arrow's destination coordinates (use "here" for your current coords)`,
    `    ${c} start (coords)|(location)|here  -  Set the route start coordinates`,
    `    ${c} end (coords)|(location)|here  -  Set the route end coordinates`,
    `    ${c} search (location)  -  Search the database for a location.`,
    `    ${c} tag  -  Attach the arrow to your current selection.`,
    `    ${c} loc (target)  -  Send your current coordinates to (target)`,
    `    ${c} dest (target)  -  Send the arrow's destination coordinates to (target)`,
    `    ${c} find (name)  -  Find (and select) an object by name.`,
    `    ${c} reset  -  Move the HUDs and GUI to their default positions on the screen`,
  ];
  if (names.loc) lines.push(`    /${names.loc} (target)  -  Same as ${c} loc (target)`);
  if (names.dest) lines.push(`    /${names.dest} (target)  -  Same as ${c} dest (target)`);
  if (names.find) lines.push(`    /${names.find} (name)  -  Same as ${c} find (name)`);
  lines.push(`    ${c} help loc  -  Show help for the ${c} loc and ${c} dest commands`);
  return lines;
}

/**
 * The chat command `/goarrow loc|dest <arg>` runs (spec §6.4): `/` and `@` stripped; a tell (`t` / `tell`)
 * with no comma gets `, <coords>`; else `%c` is replaced; else the coords follow after a space.
 */
export function goLocSendLine(arg: string, coordsText: string): string {
  const a = arg.replace(/[/@]/g, '').trim();
  let out: string;
  if (/^(t|tell)\b/i.test(a) && !a.includes(',')) out = `${a}, ${coordsText}`;
  else if (a.includes('%c')) out = a.split('%c').join(coordsText);
  else out = `${a} ${coordsText}`;
  return `/${out}`;
}

/** Validate a renamed command (spec §6.1): non-empty and not used by another GoArrow command. */
export function goCommandNameError(kind: 'main' | 'loc' | 'dest' | 'find', name: string, names: GoCommandNames): string | null {
  const n = name.trim().toLowerCase();
  const others = (['main', 'loc', 'dest', 'find'] as const).filter((k) => k !== kind).map((k) => names[k]?.toLowerCase()).filter(Boolean);
  if (n && !others.includes(n)) return null;
  return kind === 'main'
    ? 'The main chat command cannot be the same as another goarrow chat command.'
    : `The '/${names.main.toLowerCase()} ${kind}' command alias cannot be the same as another goarrow chat command.`;
}
