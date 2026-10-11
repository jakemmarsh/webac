/**
 * UtilityBelt's Aliases and GameEvents (Tools/Aliases.cs, Tools/GameEvents.cs,
 * Lib/Actions/*, Lib/GameEvents/* at 5fe9825a, MIT; docs/vtank-parity-gaps.md
 * §11.5).
 *
 * An alias is a regular expression over what you type in the chat box; each
 * matching alias runs its action, its named groups set as the expression
 * variables `capturegroup_<name>`, and an "eat" alias keeps the line from
 * going on (several aliases can match one line). A game event runs its
 * action on Login, LoginComplete, Logout or CharacterDeath, with the event's
 * variables set as `gevt_<name>` (Login / LoginComplete / Logout: id, name;
 * CharacterDeath: deathmessage, droppeditems).
 *
 * The three action kinds (BaseAction ActionType):
 *   - ChatCommand: the text as typed into the chat box;
 *   - Expression: the text evaluated as a meta expression;
 *   - ChatExpression: the expression's result typed into the chat box.
 *
 * UB edits these on its Aliases and GameEvents tabs; here `/ub alias …` and
 * `/ub events …` do (this client has no UB window), with the same fields.
 */
import type { UbAction, UbAlias, UbGameEvent, UbGameEventType } from './ubSettings.ts';

export interface UbActionRunner {
  chat(line: string): void;
  evaluate(expr: string): string;
  setVar(name: string, value: string): void;
}

export function runUbAction(a: UbAction, run: UbActionRunner): void {
  if (a.type === 'ChatCommand') run.chat(a.text);
  else if (a.type === 'Expression') run.evaluate(a.text);
  else run.chat(run.evaluate(a.text));
}

/** Named groups of a JS regex source ((?<name>…)); UB also sets group 0 as `capturegroup_0`. */
function groupNames(re: RegExp): string[] {
  return [...re.source.matchAll(/\(\?<([A-Za-z_][A-Za-z0-9_]*)>/g)].map((m) => m[1]!);
}

/** UB Aliases.Core_CommandLineText: run every alias that matches; true when one eats the line. */
export function applyAliases(line: string, aliases: readonly UbAlias[], run: UbActionRunner): boolean {
  let eat = false;
  for (const a of aliases) {
    let re: RegExp;
    try { re = new RegExp(a.alias, 'i'); } catch { continue; }
    const m = re.exec(line);
    if (!m) continue;
    if (a.eat) eat = true;
    run.setVar('capturegroup_0', m[0]);
    m.slice(1).forEach((g, i) => run.setVar(`capturegroup_${i + 1}`, g ?? ''));
    for (const name of groupNames(re)) run.setVar(`capturegroup_${name}`, m.groups?.[name] ?? '');
    runUbAction(a.action, run);
  }
  return eat;
}

/** UB GameEvents.GameEvent_Fired: each handler of the event, with `gevt_<name>` variables set first. */
export function fireGameEvent(event: UbGameEventType, vars: Record<string, string | number>, handlers: readonly UbGameEvent[], run: UbActionRunner): number {
  let n = 0;
  for (const h of handlers) {
    if (h.event !== event) continue;
    for (const [k, v] of Object.entries(vars)) run.setVar(`gevt_${k}`, String(v));
    runUbAction(h.action, run);
    n++;
  }
  return n;
}

/** The variables each event offers (UB's "?" button on the GameEvents tab). */
export const GAME_EVENT_VARS: Readonly<Record<UbGameEventType, string[]>> = {
  Login: ['id', 'name'],
  LoginComplete: ['id', 'name'],
  Logout: ['id', 'name'],
  CharacterDeath: ['deathmessage', 'droppeditems'],
};

/**
 * UB CharacterDeathGameEvent fires on the server's drop line after a death: "You've lost …" (ACE
 * Player_Death), or "You have retained all your items." / "You are enveloped in a feeling of warmth" (nothing
 * dropped). The dropped items are the rest of that line, or "" when none; null for any other line.
 */
export function deathDrops(line: string): string | null {
  const t = line.replace(/\s+$/, '');
  if (t.startsWith("You've lost ")) return t.slice("You've lost ".length);
  if (t.startsWith('You have retained all your items.') || t.startsWith('You are enveloped in a feeling of warmth')) return '';
  return null;
}
