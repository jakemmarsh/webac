/**
 * What the macro is doing, for the VirindiTank window (docs/vtank-parity-gaps.md
 * §9.6, §8.8): its status line, the Action History window's list, and VTank's
 * `/vt log [type] [on/off]` debug logging.
 *
  * - The `/vt log` command is VTank's (Virindi_Tank_Commands: "Displays the current
 *   logging state" / "Sets or unsets logging of a particular type. Valid types
 *   are ActiveRule, SalvageList, SpellCast, RuleInfo, Timers, CastInfo,
 *   DebuffChoice, Loot, CharProps, Misc"). A logged type's lines print in chat
 *   as they happen. Our engine's lines are sorted into VTank's types by what
 *   they are (a buff or recharge cast is SpellCast, a debuff choice
 *   DebuffChoice, a corpse Loot, a salvage bag SalvageList, a state change
 *   RuleInfo, the step the macro picks ActiveRule); Timers, CastInfo and
 *   CharProps are accepted but the engine writes nothing under them.
 *   Logging lasts for the session.
 * - **The Action History** follows MOSS's facts (MossTankPanel.ActionHistory,
 *   ActionHistory.cs): a session list of "[HH:mm:ss] what" lines, at most
 *   1000, a status that repeats is not written again, a Clear button, and the
 *   current status above the list.
 */
import type { RoutineStatus } from '../../agent/RoutineEngine.js';

/** VTank's log types, in the order its help lists them. */
export const VT_LOG_TYPES = ['ActiveRule', 'SalvageList', 'SpellCast', 'RuleInfo', 'Timers', 'CastInfo', 'DebuffChoice', 'Loot', 'CharProps', 'Misc'] as const;
export type VtLogType = (typeof VT_LOG_TYPES)[number];

/** The history's size (MOSS ActionHistory.Capacity). */
export const VT_HISTORY_CAPACITY = 1000;

/** The type a line of the engine's history is logged under. */
export function vtLogType(line: string): VtLogType {
  const t = line.replace(/^\d\d:\d\d:\d\d\s+/, '');
  if (/^combat: (F|B|G|I|Y|V|WC|FC|Cp|DC|Cs|Ex\. Vuln) on /.test(t)) return 'DebuffChoice';
  if (/salvag/i.test(t)) return 'SalvageList';
  if (/^(buff|force buff|buff item|recharge|dispel|helper)\b|^combat: .*\b(at|bolt|arc|streak|ring)\b/i.test(t)) return 'SpellCast';
  if (/^(loot|corpse|approach|read |mana donor|scroll)/i.test(t)) return 'Loot';
  if (/^(state set to|watchdog|view button|started|rule\b|meta\b)/i.test(t)) return 'RuleInfo';
  return 'Misc';
}

/** The status line: stopped, paused, or what the running macro is doing now. */
export function vtStatusText(st: RoutineStatus, mine: boolean): string {
  if (!st.running || !mine) return 'Macro: Stopped.';
  if (st.paused) return 'Macro: Paused.';
  const doing = st.acting && st.acting !== 'macro' ? st.acting : null;
  return doing ? `Macro: ${doing}` : 'Macro: Running.';
}

export class VtActivity {
  /** The history, oldest first. */
  lines: string[] = [];
  /** Types `/vt log` has switched on. */
  readonly logging = new Set<VtLogType>();
  private lastStatus: string | null = null;
  private lastActing: string | null = null;
  private seen: string | null = null;

  constructor(private readonly clock: () => Date = () => new Date()) {}

  private stamp(): string {
    const d = this.clock();
    const p = (n: number) => String(n).padStart(2, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  private push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > VT_HISTORY_CAPACITY) this.lines.splice(0, this.lines.length - VT_HISTORY_CAPACITY);
  }

  /** A status the history hasn't just written (MOSS: the same status twice in a row is one line). */
  record(status: string): void {
    if (status === this.lastStatus) return;
    this.lastStatus = status;
    this.push(`[${this.stamp()}] ${status}`);
  }

  clear(): void { this.lines = []; }

  /**
   * One look at the run: a changed status goes into the history, and the
   * engine's new history lines too (each printed through `emit` when its type
   * is being logged). `engine` is the engine's own log, oldest first, each
   * line "HH:MM:SS what".
   */
  observe(st: RoutineStatus, mine: boolean, engine: string[], emit: (line: string) => void): void {
    this.record(vtStatusText(st, mine));
    const acting = mine && st.running && !st.paused ? st.acting : null;
    if (acting && acting !== this.lastActing && this.logging.has('ActiveRule')) emit(`[VT log ActiveRule] ${acting}`);
    this.lastActing = acting;
    // The engine keeps its last 60 lines: the new ones are those after the last one seen.
    let from = 0;
    if (this.seen !== null) {
      const at = engine.lastIndexOf(this.seen);
      from = at >= 0 ? at + 1 : 0;
    }
    if (!mine) { this.seen = engine.at(-1) ?? this.seen; return; }
    for (const line of engine.slice(from)) {
      const m = /^(\d\d:\d\d:\d\d)\s+(.*)$/.exec(line);
      this.push(m ? `[${m[1]}] ${m[2]}` : line);
      const type = vtLogType(line);
      if (this.logging.has(type)) emit(`[VT log ${type}] ${m ? m[2] : line}`);
    }
    if (engine.length) this.seen = engine[engine.length - 1];
  }

  /** `/vt log` and `/vt log <type> on|off`, as VTank answers them. */
  command(args: string[]): string[] {
    if (!args.length) {
      return [
        this.logging.size ? `Log state: ${VT_LOG_TYPES.filter((t) => this.logging.has(t)).join(' ')}` : 'Not currently logging.',
        `Log types: ${VT_LOG_TYPES.join(' ')}`,
      ];
    }
    const [name = '', on = ''] = args;
    const type = VT_LOG_TYPES.find((t) => t.toLowerCase() === name.toLowerCase());
    if (args.length !== 2 || !/^(on|off)$/i.test(on)) return ['Syntax: /vt log [type] [on/off]'];
    if (!type) return [`Unknown log type "${name}". Log types: ${VT_LOG_TYPES.join(' ')}`];
    if (/^on$/i.test(on)) { this.logging.add(type); return [`Set ${type}`]; }
    this.logging.delete(type);
    return [`Reset ${type}`];
  }
}
