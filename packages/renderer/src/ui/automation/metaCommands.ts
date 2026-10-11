/**
 * The automation window's debug and inventory commands
 * (docs/vtank-parity-gaps.md §5.3, §6, §8): VirindiTank's `/vt
 * dumpmetavars`, `listmetafunctions`, `metafunchelp`, `testspell`,
 * `dumpspells`, `dumpskills`, `getdb` (Virindi_Tank_Commands on its wiki),
 * and UtilityBelt's `/ub autostack`, `autocram`, `count`, `clearbugged`; every other
 * `/ub` command goes to agent/ub/ubCommands.ts.
 * VTank's dump commands wrote C:\spelldump.txt and so on; here the file is a
 * download of the same name. Each answer is a line for chat.
 */
import { EXPR_FUNCTIONS, exprFunctionHelp, exprToString, type ExprValue, type LootRule, type VarScope } from '@ac/shared';
import { lootRuleFor } from '../../agent/RoutineEngine.js';

/** What the commands read and do (main.ts implements it; tests fake it). */
export interface AutomationTools {
  /** Every meta variable set now, by scope. */
  metaVars(): Array<{ scope: VarScope; name: string; value: ExprValue }>;
  /** /vt testspell's answer for a spell id. */
  testSpell(id: number): string;
  /** The era's spell table. */
  spellRows(): Array<{ id: number; name: string; school: number; power: number; category: number; duration?: number }>;
  /** The era's skills, with your training and values. */
  skillRows(): Array<{ id: number; name: string; training: string; base: number; buffed: number }>;
  /** Start a /ub autostack or autocram pass; its first line. */
  stackCram(mode: 'stack' | 'cram'): string;
  /** What you carry (count item / profile): name, stack, and what loot rules read without an appraisal. */
  carried(): Array<{ name: string; stack?: number; type?: string; value?: number; burden?: number }>;
  /** Players within this many metres, you included (count player). */
  playersWithin(meters: number): number;
  /** Start /ub clearbugged; its lines come when it ends. */
  clearBugged(): Promise<string[]>;
  /** Every other `/ub` command (agent/ub/ubCommands.ts), with the window's loot-set lookup; null when not one. */
  ub?(line: string, lootRules: (name: string) => LootRule[] | null): Promise<string[] | null>;
}

/** What the window adds: its loot profiles, and handing the player a file. */
export interface MetaCommandContext {
  /** A loot profile's rules by name (the profile's own loot as "" ), or null when there is none. */
  lootRules(name: string): LootRule[] | null;
  download(fileName: string, text: string): void;
}

const MAGIC_SCHOOL: Record<number, string> = { 1: 'War Magic', 2: 'Life Magic', 3: 'Item Enchantment', 4: 'Creature Enchantment', 5: 'Void Magic' };

/** Lines of `items` joined with ", ", none longer than `width`. */
function wrap(items: string[], width = 160): string[] {
  const out: string[] = [];
  let cur = '';
  for (const it of items) {
    if (cur && cur.length + 2 + it.length > width) { out.push(`${cur},`); cur = it; } else cur = cur ? `${cur}, ${it}` : it;
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * A `/vt …` or `/ub …` line this module answers, or null when it isn't one
 * of its commands (the window's own handler goes on).
 */
export async function metaCommand(line: string, tools: AutomationTools, ctx: MetaCommandContext): Promise<string[] | null> {
  const m = /^\s*\/(vt|vtank|ub)\s+(\S+)\s*(.*)$/i.exec(line);
  // A bare /ub is UB's version line (ubCommands.ts).
  if (!m) return /^\s*\/ub\s*$/i.test(line) && tools.ub ? tools.ub(line, (n) => ctx.lootRules(n)) : null;
  const ub = m[1]!.toLowerCase() === 'ub';
  const cmd = m[2]!.toLowerCase();
  const tail = m[3]!.trim();
  if (ub) {
    switch (cmd) {
      case 'autostack': return [tools.stackCram('stack')];
      case 'autocram': return [tools.stackCram('cram')];
      case 'count': {
        const [mode = '', ...rest] = tail.split(/\s+/);
        const subject = rest.join(' ');
        if (/^item$/i.test(mode)) return countItemsLines(tools, subject);
        if (/^player$/i.test(mode)) {
          const r = Number(subject);
          if (!Number.isFinite(r) || r <= 0) return [`Player Count: bad range: ${subject}`];
          return [`Player Count: ${tools.playersWithin(r)}`];
        }
        if (/^profile$/i.test(mode)) {
          const name = subject.replace(/\.(utl|json)$/i, '').trim();
          const rules = ctx.lootRules(name);
          if (!rules) return [`Profile does not exist: ${subject}`];
          return countByRules(tools, name, rules);
        }
        // UB's help also counts by name with no keyword (/ub count Prismatic Taper).
        if (tail) return countItemsLines(tools, tail);
        return ['/ub count item <name regex> | player <range> | profile <loot profile>'];
      }
      case 'clearbugged': return tools.clearBugged();
      default: return tools.ub ? tools.ub(line, (n) => ctx.lootRules(n)) : null;
    }
  }
  switch (cmd) {
    case 'dumpmetavars': {
      const vars = tools.metaVars();
      if (!vars.length) return ['No meta variables are set.'];
      return [`Meta variables (${vars.length}):`, ...vars.map((v) => `  ${v.scope === 'var' ? '' : `${v.scope} `}${v.name} = ${exprToString(v.value)}`)];
    }
    case 'listmetafunctions': return [`${EXPR_FUNCTIONS.length} meta functions:`, ...wrap([...EXPR_FUNCTIONS])];
    case 'metafunchelp': {
      if (!tail) return ['/vt metafunchelp <function> (/vt listmetafunctions lists them)'];
      return [exprFunctionHelp(tail) ?? `No meta function "${tail}" (/vt listmetafunctions lists them).`];
    }
    case 'testspell': {
      const id = Number(tail);
      if (!tail || !Number.isInteger(id) || id <= 0) return ['/vt testspell <spell id> (example: /vt testspell 567)'];
      return [tools.testSpell(id)];
    }
    case 'dumpspells': {
      const rows = tools.spellRows();
      if (!rows.length) return ['The spell table has not loaded yet.'];
      const text = ['Id\tName\tSchool\tDifficulty\tFamily\tDuration', ...rows.map((r) => [r.id, r.name, MAGIC_SCHOOL[r.school] ?? r.school, r.power, r.category, r.duration ?? ''].join('\t'))].join('\n');
      ctx.download('spelldump.txt', `${text}\n`);
      return [`spelldump.txt saved to your downloads (${rows.length} spells).`];
    }
    case 'dumpskills': {
      const rows = tools.skillRows();
      if (!rows.length) return ['The skill table has not loaded yet.'];
      const text = ['Id\tName\tTraining\tBase\tBuffed', ...rows.map((r) => [r.id, r.name, r.training, r.base, r.buffed].join('\t'))].join('\n');
      ctx.download('skilldump.txt', `${text}\n`);
      return [`skilldump.txt saved to your downloads (${rows.length} skills).`];
    }
    // VTank downloaded its game database; here each era's tables come with the client.
    case 'getdb': return ["The game tables (monsters, recipes, spells) come with this client for the world you're on: nothing to download."];
    default: return null;
  }
}

function countItemsLines(tools: AutomationTools, pattern: string): string[] {
  const p = pattern.trim();
  if (!p) return ['Item Count: no name pattern given.'];
  let re: RegExp;
  try { re = new RegExp(p, 'i'); } catch (e) { return [`Item Count: bad name pattern: ${(e as Error).message}`]; }
  const byName = new Map<string, number>();
  let total = 0;
  for (const i of tools.carried()) {
    if (!re.test(i.name)) continue;
    const n = Math.max(1, i.stack ?? 1);
    byName.set(i.name, (byName.get(i.name) ?? 0) + n);
    total += n;
  }
  const lines = byName.size ? [...byName].sort((a, b) => a[0].localeCompare(b[0])).map(([n, c]) => `Item Count: ${n} - ${c}`) : [`Item Count: ${p} - 0`];
  return [...lines, `Total Item Count: ${total}`];
}

/**
 * `/ub count profile <name>`: what you carry that the loot profile keeps
 * (any rule but Ignore), by rule and in total. Rules are judged on what is
 * known without an appraisal (name, type, value, burden), as the macro's
 * Keep # rule counts what you hold.
 */
function countByRules(tools: AutomationTools, name: string, rules: LootRule[]): string[] {
  const byRule = new Map<string, number>();
  let total = 0;
  for (const i of tools.carried()) {
    const r = lootRuleFor(rules, { name: i.name, ...(i.type ? { type: i.type } : {}), ...(i.value !== undefined ? { value: i.value } : {}), ...(i.burden !== undefined ? { burden: i.burden } : {}) });
    if (!r || r.action === 'ignore') continue;
    const n = Math.max(1, i.stack ?? 1);
    const label = r.label ?? r.action;
    byRule.set(label, (byRule.get(label) ?? 0) + n);
    total += n;
  }
  return [name, ...[...byRule].map(([l, c]) => `Rule Count: ${l} - ${c}`), `Total Item Count: ${total}`];
}
