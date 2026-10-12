/**
 * The UtilityBelt `/ub` commands this client runs (renderer agent/ub/ubCommands.ts, plus
 * ui/automation/metaCommands.ts's autostack / autocram / count / clearbugged), so a meta's
 * Chat Command importing one becomes a step that reaches them (vtank.ts chatAction).
 * UB's dispatcher matches a verb exactly, else a command allowing suffix flags whose verb
 * starts it (`usepi`, `jumpsw`): UB_SUFFIX_VERBS.
 */
export const UB_COMMAND_VERBS: readonly string[] = [
  'alias', 'autocram', 'autostack', 'autotinker', 'autovendor', 'breakallegiance', 'calcdamage', 'clearbugged',
  'close', 'closestportal', 'combatstate', 'count', 'date', 'delay', 'dungeonmaps', 'equip', 'events', 'face', 'fellow', 'follow',
  'getjob', 'give', 'help', 'id', 'ig', 'jump', 'landscapemaps', 'listgvars', 'listpvars', 'listvars', 'login', 'logout', 'magic',
  'melee', 'mexec', 'missile', 'myquests', 'opt', 'peace', 'playeroption', 'portal', 'pos', 'prepclick',
  'propertydump', 'quests', 'quit', 'select', 'simplejump', 'swearallegiance', 'tinkcalc', 'use', 'vendor', 'vitae', 'xp',
];

/** The verbs that take suffix flags (UB CommandPattern allowPartialVerbMatch). */
export const UB_SUFFIX_VERBS: readonly string[] = [
  'breakallegiance', 'close', 'date', 'fellow', 'follow', 'give', 'ig', 'jump', 'mexec', 'portal', 'select', 'simplejump', 'swearallegiance', 'use',
];

/** The UB command a `/ub …` line runs here, or null (UB's own dispatch: exact, then a suffix verb it starts with). */
export function ubVerbOf(line: string): string | null {
  const m = /^\s*[/@]+ub(?:\s+(\S+))?/i.exec(line);
  if (!m) return null;
  const v = (m[1] ?? '').toLowerCase();
  if (UB_COMMAND_VERBS.includes(v)) return v;
  return UB_SUFFIX_VERBS.find((s) => v.startsWith(s)) ?? null;
}
